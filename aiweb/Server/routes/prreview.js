import { buildPrMonitorHealth } from '../prReview/monitorHealth.js';
import { classifyParkApproval } from '../prReview/approvalState.js';
/**
 * PR 监控路由 — AceHarness 只读代理层
 *
 * PR 监控工作流（gitcode-pr-review.yaml）由用户在 AceHarness 侧启动和管理，
 * 本系统不创建、不存储任何任务，仅代理读取状态。
 *
 * 隔离机制：所有接口要求携带用户的 AceHarness token（Authorization header），
 * AceHarness /api/run-history 对非管理员用户自动只返回其本人的 run，
 * 天然实现"每个用户只看到自己的 PR"。
 *
 * 路由列表：
 *  POST /api/pr-review/login                                用户登录（代理 AceHarness /api/auth/login）
 *  POST /api/pr-review/register                             用户注册（管理员直通激活；未配置凭证时降级为需审核）
 *  GET  /api/pr-review/me                                   校验 token / 获取当前用户
 *  GET  /api/pr-review/runs?page=&pageSize=                 当前用户的 PR 监控 run 列表
 *  GET  /api/pr-review/runs/:runId/status                   单个 run 实时状态（阶段/步骤/评审）
 *  GET  /api/pr-review/runs/:runId/outputs                  输出文件列表
 *  GET  /api/pr-review/runs/:runId/outputs/:outputRef       读取输出文件内容
 */

import { Router } from 'express';
import { createHash } from 'crypto';
import { createLogger } from '../library/logger.js';
import config from '../library/config.js';
import { readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { httpRequest, ACEHARNESS_API_BASE_URL } from '../issueAnalysis/aceHarnessClient.js';
import {
    loginUser,
    registerUser,
    getUserByToken,
    listPrReviewRuns,
    findOwnedPrReviewRun,
    getRunStatus,
    listRunOutputs,
    readRunOutput,
    listGitcodePrs,
    startPrMonitor,
    stopPrMonitor,
    deletePrRun,
    getGitcodeTokens,
    getGitcodeTokenValues,
    getPrReviewPolicy,
    saveGitcodeToken,
    clearGitcodeToken,
    parseGitcodeUserMap,
    getReviewFixData,
    archiveApprovedReview,
    startReviewActionRun,
    postStartBuildAsAuthor,
    postReviewDismissComment,
    groupSiblingPrs,
    findSiblingReviewSource,
    siblingGroupKey,
    listAllGitcodeIdentities,
    getGitcodePrDetail,
    listGitcodeOrgPrs,
    listGitcodeOrgRepos,
    listGitcodeRepoPrsPage,
    isTesterApproved,
    runRepoOf,
    runStartInfoOf,
    runIssueInfoOf,
    runGateDiagnosisOf,
    PR_REVIEW_CONFIG_FILE,
} from '../prReview/client.js';
import { loadCapabilities, deriveCapabilities, probeGitcodeCapabilities, saveCapabilities } from '../prReview/capabilities.js';
import { readExecutionEvidence } from '../prReview/executionEvidence.js';
import { buildFixEvidence } from '../prReview/evidence.js';
import { status as outboxStatus, markSent as outboxMarkSent, markFailed as outboxMarkFailed } from '../prReview/outbox.js';
import { buildTodos } from '../prReview/todos.js';
import {
    operationKey,
    hashPatch,
    beginOperation,
    findOperation,
    startOperationReconciler,
    patchOperation,
    listOperations,
    reconcileOperation,
    OPERATION_STATE_LABELS,
} from '../prReview/operations.js';

const logger = createLogger('Router.PrReview');

/* ═══════════ 通知事件（小鲁班拉模式） ═══════════ */

const NOTIFY_STATE_FILE = join(homedir(), '.aceharness', 'data', 'aiweb-notify-state.json');
const HUMAN_PHASE = '__human_approval__';
const TERMINAL = new Set(['completed', 'failed', 'crashed']);
const RUN_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const RUN_STATUS_FRESH_MS = 8 * 1000;
const RUN_STATUS_CACHE_MAX = 500;
const runStatusCache = new Map();
const runStatusInflight = new Map();
const runOutputsCache = new Map();
const runOutputsInflight = new Map();

/**
 * start API may return a runId before workflow preflight rejects the config.
 * Such a run only has config snapshots (no state/summary); after a short grace
 * period it is safe to offer an apply retry, provided the PR head still matches.
 */
function _isRunPreflightFailure(runId) {
    if (!/^run-[A-Za-z0-9-]+$/.test(String(runId || ''))) return false;
    const runDir = join(homedir(), '.aceharness', 'runs', runId);
    try { readFileSync(join(runDir, 'summary.json'), 'utf8'); return false; } catch { /* 尚无最终摘要 */ }
    try { readFileSync(join(runDir, 'state.yaml'), 'utf8'); return false; } catch { /* 预校验失败时尚未创建状态 */ }
    try {
        const manifest = JSON.parse(readFileSync(join(runDir, 'configs', 'manifest.json'), 'utf8'));
        const isPrWorkflow = manifest.root === PR_REVIEW_CONFIG_FILE
            || manifest.configs?.some((item) => item.canonicalFile === PR_REVIEW_CONFIG_FILE);
        const createdAt = Date.parse(manifest.createdAt || '');
        return Boolean(isPrWorkflow && createdAt && Date.now() - createdAt >= 60_000);
    } catch { return false; }
}

function _runSummaryStatus(runId) {
    if (!/^run-[A-Za-z0-9-]+$/.test(String(runId || ''))) return '';
    try {
        const summary = JSON.parse(readFileSync(join(homedir(), '.aceharness', 'runs', runId, 'summary.json'), 'utf8'));
        return String(summary.status || '').toLowerCase();
    } catch { return ''; }
}

async function _failedAppliedRunId(token, decisionEntry) {
    const op = decisionEntry?.operationKey ? findOperation(decisionEntry.operationKey) : null;
    if (op?.status === 'failed' && op.retrySafe) return op.runId;
    const runId = String(decisionEntry?.newRunId || '');
    if (decisionEntry?.decision !== 'applied' || !runId) return '';
    const localStatus = _runSummaryStatus(runId);
    if (localStatus) return ['failed', 'crashed'].includes(localStatus) ? runId : '';
    if (_isRunPreflightFailure(runId)) return runId;
    try {
        const run = await findOwnedPrReviewRun(token, runId);
        return run && ['failed', 'crashed'].includes(String(run.status || '').toLowerCase()) ? runId : '';
    } catch (error) {
        logger.warn('检查已应用建议任务状态失败', { runId, error: error.message });
        return '';
    }
}

function _runStatusCacheKey(token, runId) {
    return `${createHash('sha256').update(token).digest('hex')}:${runId}`;
}

function _cacheRunStatus(key, status) {
    runStatusCache.set(key, { status: { ...status }, savedAt: Date.now() });
    if (runStatusCache.size > RUN_STATUS_CACHE_MAX) {
        runStatusCache.delete(runStatusCache.keys().next().value);
    }
}

function _refreshRunStatus(token, runId, cacheKey) {
    if (runStatusInflight.has(cacheKey)) return runStatusInflight.get(cacheKey);
    const promise = getRunStatus(token, runId).then((status) => {
        if (status?.currentPhase === HUMAN_PHASE) {
            const park = classifyParkApproval(runId);
            status.approvalKind = park === 'webhook' ? 'suspended' : 'human';
        }
        _cacheRunStatus(cacheKey, status);
        return status;
    }).finally(() => runStatusInflight.delete(cacheKey));
    runStatusInflight.set(cacheKey, promise);
    return promise;
}

function _loadNotifyState() {
    try {
        return JSON.parse(readFileSync(NOTIFY_STATE_FILE, 'utf8'));
    } catch { return { acked: {} }; }
}

function _saveNotifyState(state) {
    try {
        const { mkdirSync, writeFileSync } = require('fs');
        mkdirSync(join(homedir(), '.aceharness', 'data'), { recursive: true });
        writeFileSync(NOTIFY_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        logger.warn('通知状态写入失败', { error: e.message });
    }
}

/**
 * 扫描 AceHarness runs 目录，产出待通知事件（幂等：已 ack 的不再返回）
 * 事件类型：
 *  - human-approval：活跃 run 进入「需人工确认」阶段
 *  - monitor-done：监控完成 / 失败 / 崩溃
 */
function collectNotifyEvents() {
    const state = _loadNotifyState();
    const events = [];
    const runsDir = join(homedir(), '.aceharness', 'runs');
    let dirs = [];
    try { dirs = readdirSync(runsDir); } catch { return events; }
    for (const name of dirs) {
        if (!name.startsWith('run-')) continue;
        let s;
        try {
            s = JSON.parse(readFileSync(join(runsDir, name, 'summary.json'), 'utf8'));
        } catch { continue; }
        if (s.configFile !== 'gitcode-pr-review.yaml') continue;
        const prNumber = (name.match(/-pr(\d+)(?:-|$)/) || [])[1];
        if (!prNumber) continue;

        const isTerminal = TERMINAL.has(s.status);
        const needsApproval = !isTerminal && s.currentPhase === HUMAN_PHASE;
        if (!isTerminal && !needsApproval) continue;

        // 每类事件一个稳定 eventId：runId + 类型（人工确认可多次进入，用阶段计数天然区分不了，先按一次性事件处理）
        const type = needsApproval ? 'human-approval' : 'monitor-done';
        const eventId = `${s.runId}:${type}`;
        if (state.acked[eventId]) continue;

        // 细分"需人工确认"：挂起等 CI 门禁（自动继续，isSuspendedWait=true）vs 真需人处理
        let isSuspendedWait = false;
        if (needsApproval) isSuspendedWait = classifyParkApproval(s.runId || name) === 'webhook';

        events.push({
            eventId,
            type,                       // human-approval | monitor-done
            isSuspendedWait,            // true=挂起等CI门禁（无需处理）；false=真需人工处理
            prNumber: Number(prNumber),
            repo: runRepoOf(s.runId || name),  // 归属仓库（跨仓编号重叠时的区分依据）
            title: s.configName || 'PR 监控',
            status: s.status,           // running/paused/completed/failed/crashed
            ownerName: s.ownerName || '',
            startTime: s.startTime,
            endTime: s.endTime || null,
            workbenchUrl: `${config.aceharness.baseUrl}/dashboard?route=${encodeURIComponent('/workbench/gitcode-pr-review.yaml?mode=run&run=' + s.runId)}`,
        });
    }
    return events;
}

function ackNotifyEvent(eventId) {
    const state = _loadNotifyState();
    state.acked[eventId] = new Date().toISOString();
    _saveNotifyState(state);
}

/* ── 启动请求串行去重，固定脚本启动只保留 250ms 的短暂错峰。 ── */
const MONITOR_START_MIN_INTERVAL_MS = 250;
const MONITOR_START_MAX_WAIT_MS = 60_000;
let _monitorStartChain = Promise.resolve();
let _monitorLastStartAt = 0;
const pendingMonitorStarts = new Map();

/** 把启动任务排入串行链：任务本身不抛错（错误包装为 {ok:false,error}），保证链不断 */
function _runMonitorStartTask(task) {
    const run = _monitorStartChain.then(async () => {
        const wait = Math.max(0, _monitorLastStartAt + MONITOR_START_MIN_INTERVAL_MS - Date.now());
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        try {
            return { ok: true, value: await task() };
        } catch (error) {
            return { ok: false, error };
        } finally {
            _monitorLastStartAt = Date.now();
        }
    });
    _monitorStartChain = run.then(() => {}, () => {});
    return run;
}

/**
 * 跨用户检查：该 PR 是否已有活跃监控 run（无论谁启动的）。
 * 同机部署：直接读 AceHarness runs 目录的 summary.json（runId 格式 run-<ts>-pr<N>-<rand>）。
 * 多仓支持：PR 编号跨仓重叠，repo 非空时需同时校验 run 归属仓库（state.yaml globalContext）。
 * 读取失败时静默返回 null（保持旧行为，不阻塞启动）。
 */
function findActiveRunByPr(prNumber, repo = '') {
    try {
        const runsDir = join(homedir(), '.aceharness', 'runs');
        const re = new RegExp(`-pr${prNumber}(-|$)`);
        for (const name of readdirSync(runsDir)) {
            if (!re.test(name)) continue;
            try {
                const s = JSON.parse(readFileSync(join(runsDir, name, 'summary.json'), 'utf8'));
                if (!['running', 'preparing', 'paused', 'pending'].includes(s.status)) continue;
                // 仓库校验：repo 提供且 run 仓库可识别时不匹配则跳过（旧 run 仓库未知时兼容放行）
                if (repo) {
                    const runRepo = runRepoOf(s.runId || name);
                    if (runRepo && runRepo !== repo) continue;
                }
                return { runId: s.runId || name, status: s.status };
            } catch { /* 单个 run 读失败忽略 */ }
        }
    } catch { /* 目录不存在/不可读时跳过全局检查 */ }
    return null;
}

/**
 * GitCode PR 列表缓存（30s TTL + 在途合并 + 过期降级 + 落盘）：
 * - 命中 TTL 内缓存直接返回；
 * - 同身份并发只打一次 GitCode；
 * - 有 10 分钟内的旧缓存时立即返回并后台刷新（标记 stale），避免每次过期都等待全仓分页；
 * - 缓存同时落盘（aiweb-prs-cache.json），后端重启后仍可用作降级兜底。
 */
const PRS_CACHE_TTL_MS = 30000;
const PRS_STALE_MAX_MS = 10 * 60 * 1000;
const PRS_CACHE_FILE = join(homedir(), '.aceharness', 'data', 'aiweb-prs-cache.json');
const _prsCache = new Map();      // author -> { at, repo, repos, prs, complete, incompleteRepos }
const _prsInflight = new Map();   // author -> Promise<cached PR list>

function _loadDiskPrsCache() {
    try {
        const disk = JSON.parse(readFileSync(PRS_CACHE_FILE, 'utf8'));
        if (disk && typeof disk === 'object') {
            for (const [author, entry] of Object.entries(disk)) {
                if (entry?.at && Array.isArray(entry.prs)) {
                    _prsCache.set(author, {
                        ...entry,
                        complete: entry.complete === true,
                        incompleteRepos: Array.isArray(entry.incompleteRepos) ? entry.incompleteRepos
                            : [{ repo: '', status: 'unknown', reason: '旧缓存没有记录仓库扫描完整性' }],
                    });
                }
            }
        }
    } catch { /* 首次运行/损坏时忽略 */ }
}
_loadDiskPrsCache();

/* ── 邮件通知开关：读写 AceHarness 同机 system-settings.yaml（ACEHarness 每次现读文件，改完即生效） ── */

const ACE_SETTINGS_FILE = () => join(homedir(), '.aceharness', 'data', 'system-settings.yaml');

/** 提取 emailNotifications 段落文本（按行扫描：段头之后的所有缩进行，遇顶级键结束）。 */
function _emailNotifySection(text) {
    const lines = String(text || '').split('\n');
    const start = lines.findIndex((l) => /^emailNotifications:\s*$/.test(l));
    if (start < 0) return '';
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].trim() === '') { out.push(lines[i]); continue; }
        if (!/^\s/.test(lines[i])) break;
        out.push(lines[i]);
    }
    return out.join('\n');
}

export function readEmailNotifyState() {
    try {
        const section = _emailNotifySection(readFileSync(ACE_SETTINGS_FILE(), 'utf8'));
        return {
            enabled: /^\s*enabled:\s*true\s*$/m.test(section),
            // SMTP 配置完整性（不回传任何凭证，只给布尔）
            configured: /^\s*smtpHost:\s*\S+/m.test(section) && /^\s*fromEmail:\s*\S+/m.test(section),
        };
    } catch {
        return { enabled: false, configured: false };
    }
}

export function setEmailNotifyEnabled(enabled) {
    const file = ACE_SETTINGS_FILE();
    const want = enabled === true;
    let lines;
    try {
        lines = readFileSync(file, 'utf8').split('\n');
    } catch {
        lines = [];
    }
    const start = lines.findIndex((l) => /^emailNotifications:\s*$/.test(l));
    if (start < 0) {
        // 无段落：追加最小骨架（不动已有内容）
        if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
        lines.push('emailNotifications:', `  enabled: ${want}`);
    } else {
        // 段内找 enabled 行：仅替换其值，其余行（凭证/注释/其他键）原样保留
        let hit = -1;
        for (let i = start + 1; i < lines.length; i++) {
            if (lines[i].trim() !== '' && !/^\s/.test(lines[i])) break; // 顶级键 → 段落结束
            if (/^\s*enabled:/.test(lines[i])) { hit = i; break; }
        }
        if (hit >= 0) lines[hit] = lines[hit].replace(/^(\s*enabled:).*/, `$1 ${want}`);
        else lines.splice(start + 1, 0, `  enabled: ${want}`);
    }
    // 原子写：tmp + rename，防并发撕裂
    mkdirSync(join(homedir(), '.aceharness', 'data'), { recursive: true });
    const tmp = `${file}.aiweb-tmp`;
    writeFileSync(tmp, lines.join('\n'), 'utf8');
    renameSync(tmp, file);
    return readEmailNotifyState();
}

function _saveDiskPrsCache() {
    try {
        mkdirSync(join(homedir(), '.aceharness', 'data'), { recursive: true });
        const obj = {};
        for (const [author, entry] of _prsCache) obj[author] = entry;
        writeFileSync(PRS_CACHE_FILE, JSON.stringify(obj, null, 1));
    } catch { /* 落盘失败不影响主流程 */ }
}

function watchRepoFirst() {
    try { return config.gitcodeToken ? String(process.env.GITCODE_PR_REPOS || '').split(',')[0].trim() || 'CPF-Flutter/flutter_flutter' : 'CPF-Flutter/flutter_flutter'; }
    catch { return 'CPF-Flutter/flutter_flutter'; }
}

function getPrsCached(author, fresh = false) {
    const hit = _prsCache.get(author);
    if (!fresh && hit && Date.now() - hit.at < PRS_CACHE_TTL_MS) {
        return Promise.resolve(hit);
    }
    const usableStale = hit && Date.now() - hit.at < PRS_STALE_MAX_MS;
    if (_prsInflight.has(author)) {
        return !fresh && usableStale ? Promise.resolve({ ...hit, stale: true }) : _prsInflight.get(author);
    }
    const p = listGitcodePrs({ author, fresh })
        .then(data => {
            const entry = {
                at: Date.now(), repo: data.repo, repos: data.repos || [], prs: data.prs,
                complete: data.complete, incompleteRepos: data.incompleteRepos || [],
            };
            _prsCache.set(author, entry);
            _saveDiskPrsCache();
            return entry;
        })
        .catch(err => {
            // 过期缓存降级：GitCode 失败但 10 分钟内有旧数据 → 返回旧数据（标记 stale）
            if (hit && Date.now() - hit.at < PRS_STALE_MAX_MS) {
                logger.warn('GitCode 拉取失败，降级返回过期缓存', { author, age: Math.round((Date.now() - hit.at) / 1000) + 's', error: err.message });
                return { ...hit, stale: true };
            }
            throw err;
        })
        .finally(() => _prsInflight.delete(author));
    _prsInflight.set(author, p);
    if (!fresh && usableStale) {
        // The refresh can outlive this HTTP request; keep its rejection handled.
        void p.catch(err => logger.warn('后台刷新 PR 列表失败', { author, error: err.message }));
        return Promise.resolve({ ...hit, stale: true });
    }
    return p;
}

const ORG_PR_PAGE_CACHE_TTL_MS = 60 * 1000;
const ORG_PR_PAGE_CACHE_MAX = 200;
const _orgPrPageCache = new Map();
const _orgPrPageInflight = new Map();

function getOrgPrPageCached(options, fresh = false) {
    const normalized = {
        org: 'CPF-Flutter',
        repo: String(options.repo || ''),
        page: Number(options.page) || 1,
        perPage: Number(options.perPage) || 20,
        state: String(options.state || 'all'),
        search: String(options.search || ''),
        author: String(options.author || ''),
    };
    const key = JSON.stringify({ ...normalized, repo: normalized.repo.toLowerCase(), author: normalized.author.toLowerCase() });
    const hit = _orgPrPageCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < ORG_PR_PAGE_CACHE_TTL_MS) return Promise.resolve(hit.data);
    if (_orgPrPageInflight.has(key)) return _orgPrPageInflight.get(key);
    const read = normalized.repo
        ? listGitcodeRepoPrsPage(normalized.repo, normalized)
        : listGitcodeOrgPrs(normalized);
    const pending = Promise.resolve(read).then((data) => {
        _orgPrPageCache.delete(key);
        _orgPrPageCache.set(key, { at: Date.now(), data });
        while (_orgPrPageCache.size > ORG_PR_PAGE_CACHE_MAX) _orgPrPageCache.delete(_orgPrPageCache.keys().next().value);
        return data;
    }).finally(() => _orgPrPageInflight.delete(key));
    _orgPrPageInflight.set(key, pending);
    return pending;
}

export function createPrReviewRouter(orchestrator) {
    startOperationReconciler();
    const router = Router();

    // 从请求中提取用户 token（Authorization: Bearer xxx）
    function extractToken(req) {
        const h = req.headers.authorization || '';
        return h.startsWith('Bearer ') ? h.slice(7) : null;
    }

    // ── 1. 用户登录 ───────────────────────────────────────────────────────────

    router.post('/pr-review/login', async (req, res) => {
        const { email, password } = req.body ?? {};
        try {
            const { token, user } = await loginUser(email, password);
            logger.info('PR 监控用户登录成功', { username: user?.username });
            // 只返回安全的用户字段
            res.json({
                success: true,
                token,
                user: {
                    id: user?.id,
                    username: user?.username,
                    email: user?.email,
                    role: user?.role,
                },
            });
        } catch (err) {
            logger.warn('PR 监控用户登录失败', { email: email ? '***' : '(空)', error: err.message });
            res.status(401).json({ success: false, message: err.message });
        }
    });

    // ── 1c. 忘记密码（邮箱验证码） ───────────────────────────────────────────

    router.post('/pr-review/forgot-password', async (req, res) => {
        const { step, email, code, newPassword } = req.body ?? {};
        if (!email) {
            return res.status(400).json({ success: false, message: '请输入邮箱' });
        }
        try {
            const result = await httpRequest('POST', '/api/auth/forgot-password', {
                step, email, code, newPassword,
            }, { baseUrl: ACEHARNESS_API_BASE_URL, timeoutMs: 30000 });
            if (result.status !== 200) {
                const msg = result.data?.error || `操作失败（HTTP ${result.status}）`;
                return res.status(result.status === 404 ? 404 : 400).json({ success: false, message: msg });
            }
            logger.info('忘记密码操作', { step, email: email ? '***' : '(空)' });
            res.json({ success: true, message: result.data?.message || '操作成功' });
        } catch (err) {
            logger.warn('忘记密码操作失败', { step, error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // ── 1d. 注册邮箱验证码 ────────────────────────────────────────────────────

    router.post('/pr-review/verify-email', async (req, res) => {
        const { email, code, action } = req.body ?? {};
        if (!email) {
            return res.status(400).json({ success: false, message: '请输入邮箱' });
        }
        try {
            const result = await httpRequest('POST', '/api/auth/verify-email', {
                email, code, action,
            }, { baseUrl: ACEHARNESS_API_BASE_URL, timeoutMs: 30000 });
            if (result.status !== 200) {
                const msg = result.data?.error || `操作失败（HTTP ${result.status}）`;
                return res.status(result.status).json({ success: false, message: msg });
            }
            logger.info('注册邮箱验证', { action: action || 'send', email: '***' });
            res.json({ success: true, message: result.data?.message, verified: result.data?.verified });
        } catch (err) {
            logger.warn('注册邮箱验证失败', { error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // ── 1e. 注册（改造版：强制邮箱验证码） ─────────────────────────────────────

    router.post('/pr-review/register', async (req, res) => {
        const { username, email, password, question, answer, emailVerifyCode } = req.body ?? {};
        try {
            // 先验证邮箱验证码（防无效邮箱注册——谁都能填假邮箱的时代结束了）
            if (!emailVerifyCode || String(emailVerifyCode).length !== 6) {
                return res.status(400).json({ success: false, message: '请输入 6 位邮箱验证码（点邮箱旁边的「发送验证码」按钮）' });
            }
            const verifyResult = await httpRequest('POST', '/api/auth/verify-email', {
                email, code: String(emailVerifyCode), action: 'verify',
            }, { baseUrl: ACEHARNESS_API_BASE_URL, timeoutMs: 30000 });
            if (verifyResult.status !== 200 || !verifyResult.data?.verified) {
                return res.status(400).json({
                    success: false,
                    message: verifyResult.data?.error || '邮箱验证码校验失败，请重新获取',
                });
            }

            const { user, message, activated, degradedReason } = await registerUser({
                username, email, password, question, answer,
            });
            logger.info('PR 监控用户注册完成', { username, activated: !!activated, emailVerified: true });
            res.status(201).json({
                success: true,
                activated: !!activated,
                message,
                degradedReason: degradedReason || null,
                user: {
                    username: user?.username,
                    email: user?.email,
                    status: user?.status,
                },
            });
        } catch (err) {
            logger.warn('PR 监控用户注册失败', { username: username || '(空)', error: err.message });
            res.status(400).json({ success: false, message: err.message });
        }
    });

    // ── 2. 校验 token / 获取当前用户 ──────────────────────────────────────────

    router.get('/pr-review/me', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        try {
            const user = await getUserByToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            }
            res.json({
                success: true,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    role: user.role,
                },
            });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // ── 3. run 列表（AceHarness 侧按用户隔离） ───────────────────────────────

    router.get('/pr-review/runs', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        try {
            const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
            const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '50', 10) || 50));
            const data = await listPrReviewRuns(token, page, pageSize);
            // 附加 AceHarness 工作台跳转链接
            const cf = PR_REVIEW_CONFIG_FILE;
            data.runs = data.runs.map(r => {
                const route = `/workbench/${cf}?mode=run&run=${r.runId}`;
                return {
                    ...r,
                    workbenchUrl: `${config.aceharness.baseUrl}/dashboard?route=${encodeURIComponent(route)}`,
                };
            });
            res.json({ success: true, ...data });
        } catch (err) {
            logger.error('查询 PR 监控 run 列表失败', { error: err.message });
            const status = err.message.includes('HTTP 401') ? 401 : 500;
            res.status(status).json({ success: false, message: err.message });
        }
    });

    // ── 4. 单个 run 实时状态 ─────────────────────────────────────────────────

    router.get('/pr-review/runs/:runId/status', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        const cacheKey = _runStatusCacheKey(token, req.params.runId);
        // 门禁根因/维护提醒：让"普通详情"也能看到，不必打开"检视修复"面板。读磁盘小文件，不进缓存。
        const gateDiagnosis = runGateDiagnosisOf(req.params.runId);
        const cached = runStatusCache.get(cacheKey);
        const cacheAge = cached ? Date.now() - cached.savedAt : Infinity;
        if (cached && cacheAge <= RUN_STATUS_FRESH_MS) {
            return res.json({ success: true, status: { ...cached.status, gateDiagnosis } });
        }
        if (cached && cacheAge <= RUN_STATUS_CACHE_TTL_MS) {
            // 先返回最近快照，后台刷新。状态页不会再等 15-20 秒超时才看到旧进度。
            void _refreshRunStatus(token, req.params.runId, cacheKey).catch((err) => {
                logger.warn('后台刷新 run 状态失败，继续使用最近快照', { runId: req.params.runId, error: err.message });
            });
            return res.json({
                success: true,
                status: {
                    ...cached.status,
                    gateDiagnosis,
                    staleStatus: true,
                    staleAt: new Date(cached.savedAt).toISOString(),
                    refreshing: runStatusInflight.has(cacheKey),
                },
            });
        }
        try {
            const status = await _refreshRunStatus(token, req.params.runId, cacheKey);
            res.json({ success: true, status: { ...status, gateDiagnosis } });
        } catch (err) {
            logger.error('查询 run 状态失败', { runId: req.params.runId, error: err.message });
            const statusCode = err.message.includes('HTTP 401') ? 401
                : err.message.includes('HTTP 403') ? 403
                    : 500;
            const cached = runStatusCache.get(cacheKey);
            if (statusCode !== 401 && statusCode !== 403 && cached && Date.now() - cached.savedAt <= RUN_STATUS_CACHE_TTL_MS) {
                return res.json({
                    success: true,
                    status: { ...cached.status, gateDiagnosis, staleStatus: true, staleAt: new Date(cached.savedAt).toISOString() },
                });
            }
            res.status(statusCode).json({ success: false, message: err.message });
        }
    });

    // ── 5. 输出文件列表 ───────────────────────────────────────────────────────

    router.get('/pr-review/runs/:runId/outputs', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        const cacheKey = _runStatusCacheKey(token, req.params.runId);
        const cached = runOutputsCache.get(cacheKey);
        const age = cached ? Date.now() - cached.savedAt : Infinity;
        const refresh = () => {
            if (runOutputsInflight.has(cacheKey)) return runOutputsInflight.get(cacheKey);
            const promise = listRunOutputs(token, req.params.runId).then((data) => {
                runOutputsCache.set(cacheKey, { data, savedAt: Date.now() });
                if (runOutputsCache.size > RUN_STATUS_CACHE_MAX) {
                    runOutputsCache.delete(runOutputsCache.keys().next().value);
                }
                return data;
            }).finally(() => runOutputsInflight.delete(cacheKey));
            runOutputsInflight.set(cacheKey, promise);
            return promise;
        };
        if (cached && age < 15000) {
            return res.json({ success: true, ...cached.data });
        }
        if (cached && age <= RUN_STATUS_CACHE_TTL_MS) {
            void refresh().catch((err) => logger.warn('后台刷新 run 输出列表失败，继续使用最近快照', {
                runId: req.params.runId, error: err.message,
            }));
            return res.json({ success: true, ...cached.data, stale: true });
        }
        try {
            const data = await refresh();
            res.json({ success: true, ...data });
        } catch (err) {
            logger.error('列出输出文件失败', { runId: req.params.runId, error: err.message });
            const status = err.message.includes('HTTP 401') ? 401 : 500;
            res.status(status).json({ success: false, message: err.message });
        }
    });

    // ── 6. 读取输出文件内容 ───────────────────────────────────────────────────

    router.get('/pr-review/runs/:runId/outputs/:outputRef', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        try {
            // outputRef 含路径分隔符（outputs/step-logs/xxx.md），前端已 encodeURIComponent，
            // Express 对编码后的参数整体解码，req.params.outputRef 即完整路径
            const data = await readRunOutput(token, req.params.runId, req.params.outputRef);
            res.json({ success: true, ...data });
        } catch (err) {
            logger.error('读取输出文件失败', { runId: req.params.runId, error: err.message });
            const status = err.message.includes('HTTP 401') ? 401 : 500;
            res.status(status).json({ success: false, message: err.message });
        }
    });

    // ── 7. GitCode CPF-Flutter 组织 PR 总览（跨作者、跨仓库分页） ─────────────

    router.get('/pr-review/gitcode-prs', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        // token 校验：AceHarness 不可达时降级（PR 列表直连 GitCode，不依赖引擎）
        let user = null;
        let degraded = false;
        try {
            user = await getUserByToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            }
        } catch (err) {
            logger.warn('校验用户时 AceHarness 不可达，PR 总览降级（不标注监控状态）', { error: err.message });
            degraded = true;
        }
        try {
            const isAdmin = user?.role === 'admin';
            const ownLogin = user && !degraded ? (_gitcodeLoginOfUser(user.username) || '') : '';
            const requestedAuthor = String(req.query.author || '').trim();
            let author = '';
            if (req.query.scope === 'self') {
                if (!user || degraded) return res.status(503).json({ success: false, message: '当前无法验证账号身份，请稍后重试' });
                if (!ownLogin) return res.status(422).json({ success: false, message: '当前账号尚未绑定 GitCode 身份，无法筛选本人 PR' });
                author = ownLogin;
            } else if (requestedAuthor) {
                if (!isAdmin && (!user || degraded)) {
                    return res.status(503).json({ success: false, message: '当前无法验证 GitCode 身份，请稍后重试' });
                }
                if (!isAdmin && (!ownLogin || requestedAuthor.toLowerCase() !== ownLogin.toLowerCase())) {
                    return res.status(403).json({ success: false, message: '只能按当前账号绑定的 GitCode 身份筛选' });
                }
                author = requestedAuthor;
            }

            const page = Math.min(100000, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
            const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query.perPage, 10) || 20));
            const state = ['open', 'closed', 'merged'].includes(String(req.query.state || '')) ? String(req.query.state) : 'all';
            const search = String(req.query.search || '').trim().slice(0, 200);
            const repoFilter = String(req.query.repo || '').trim();
            if (repoFilter && !/^CPF-Flutter\/[A-Za-z0-9_.-]+$/i.test(repoFilter)) {
                return res.status(400).json({ success: false, message: '仓库筛选只支持 CPF-Flutter 组织内的仓库' });
            }
            let repos = [];
            try { repos = await listGitcodeOrgRepos('CPF-Flutter', req.query.fresh === '1', isAdmin ? 'all' : 'public'); }
            catch (error) { logger.warn('读取 CPF-Flutter 仓库筛选目录失败', { error: error.message }); }
            const isPublicRepo = repos.some((name) => name.toLowerCase() === repoFilter.toLowerCase());
            if (repoFilter && !isAdmin && !isPublicRepo && !ownLogin) {
                return res.status(403).json({ success: false, message: '筛选非公开仓库需要绑定自己的 GitCode 身份' });
            }
            // 单仓 API 能读到服务令牌可见的私有 PR；普通用户筛私有仓时只查询自己的 PR。
            const pageAuthor = repoFilter && !isAdmin && !isPublicRepo ? (author || ownLogin) : author;
            const data = await getOrgPrPageCached({ page, perPage, state, search, repo: repoFilter, author: pageAuthor }, req.query.fresh === '1');
            // 私有项目的 PR 不能因为服务端令牌权限更高而泄露给普通平台用户；本人仍可查看自己的条目。
            let prs = data.prs.filter((p) => isAdmin || p.visibilityReason === 'public'
                || (ownLogin && p.author.toLowerCase() === ownLogin.toLowerCase()));
            if (!degraded) {
                // 标注每条 PR 的监控状态：匹配当前用户名下的 run（仓库+编号双键，防跨仓同号误标）
                const runs = await listPrReviewRuns(token, 1, 100);
                const runByPr = new Map();
                for (const r of runs.runs) {
                    if (!r.prNumber) continue;
                    const key = `${r.repo || '?'}/${r.prNumber}`;
                    const list = runByPr.get(key) || [];
                    list.push(r);
                    runByPr.set(key, list);
                }
                prs = prs.map(p => {
                    const mine = (runByPr.get(`${p.repo || '?'}/${p.number}`) || [])
                        .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
                    const active = mine.find(r => !['completed', 'failed', 'crashed', 'stopped'].includes(r.status));
                    return {
                        ...p,
                        monitorRuns: mine.map(r => ({ runId: r.runId, status: r.status, startTime: r.startTime })),
                        monitorStatus: active ? 'running' : (mine.length > 0 ? 'done' : 'off'),
                        canMonitor: isAdmin || Boolean(ownLogin && p.author.toLowerCase() === ownLogin.toLowerCase()),
                    };
                });
            } else {
                prs = prs.map((p) => ({ ...p, canMonitor: false, monitorRuns: [], monitorStatus: 'off' }));
            }
            for (const pr of prs) if (pr.repoFull && !repos.some((name) => name.toLowerCase() === pr.repoFull.toLowerCase())) repos.push(pr.repoFull);
            res.json({ success: true, prs, repo: 'CPF-Flutter', repos, author,
                identitySource: author ? 'self' : 'organization', degraded,
                page: data.page, perPage: data.perPage, hasMore: data.hasMore,
                searchMode: repoFilter ? 'current-page' : 'organization' });
        } catch (err) {
            logger.error('拉取 GitCode PR 列表失败', { error: err.message, cause: String(err.cause?.code || err.cause?.message || ''), stack: String(err.stack || '').split('\n')[1] });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // ── 8. 人工开启 PR 监控 ───────────────────────────────────────────────────

    router.post('/pr-review/monitor/start', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        let releaseMonitorReservation = null;
        try {
            const user = await getUserByToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            }
            const { number, repo: repoParam } = req.body ?? {};
            if (!/^\d+$/.test(String(number || ''))) {
                return res.status(400).json({ success: false, message: 'PR 编号必须是正整数' });
            }
            // 手工监控覆盖 CPF-Flutter 组织全部代码仓，不再受旧的两仓列表配置限制。
            // 工作流侧仍会执行自身仓库白名单校验；部署环境也应设置 ACE_GITCODE_WATCH_REPOS=CPF-Flutter/*。
            const repos = await listGitcodeOrgRepos('CPF-Flutter');
            const repoFull = !repoParam ? (repos.find(r => r.toLowerCase() === 'cpf-flutter/flutter_flutter') || repos[0])
                : (repos.find(r => r.toLowerCase() === String(repoParam).toLowerCase())
                    || repos.find(r => r.toLowerCase().endsWith(`/${String(repoParam).toLowerCase()}`)) || '');
            if (!repoFull) {
                return res.status(400).json({ success: false, message: `CPF-Flutter 组织中未找到可访问的代码仓库：${repoParam}` });
            }
            const repoShort = repoFull.split('/')[1];
            // ── 一个 PR 只保留一个监控任务（跨用户全局唯一；仓库+编号双键防跨仓同号误伤） ──
            // 0) 任何用户（含自己）已有该 PR 的活跃 run → 拒绝
            const globalActive = findActiveRunByPr(number, repoShort);
            if (globalActive) {
                return res.status(409).json({
                    success: false,
                    message: `${repoShort} PR #${number} 已有监控任务进行中（由其他用户启动），无需重复开启`,
                    runId: globalActive.runId,
                });
            }
            // 1) 该 PR 已有活跃 run → 拒绝启动
            const existing = (await listPrReviewRuns(token, 1, 100)).runs
                .filter(r => r.prNumber === String(number) && (!r.repo || r.repo === repoShort));
            const active = existing.find(r => !['completed', 'failed', 'crashed', 'stopped'].includes(r.status));
            if (active) {
                return res.status(409).json({
                    success: false,
                    message: `${repoShort} PR #${number} 已有监控任务进行中（${active.runId}），无需重复开启`,
                    runId: active.runId,
                });
            }
            // 单个 PR 直接读取详情；保留历史 run，启动失败也不丢失日志和修复产物。
            const [owner, repoName] = repoFull.split('/');
            const prDetail = await getGitcodePrDetail(owner, repoName, number);
            if (!prDetail) {
                return res.status(503).json({ success: false, message: `暂时无法读取 PR #${number}，请稍后重试` });
            }
            const pr = {
                number: prDetail.number || number, title: prDetail.title || '',
                state: prDetail.merged ? 'merged' : prDetail.state,
                author: prDetail.user?.login || prDetail.author?.username || '',
                headRef: prDetail.head?.ref || prDetail.source_branch || '',
                baseRef: prDetail.base?.ref || prDetail.target_branch || '',
                headSha: prDetail.head?.sha || prDetail.head?.id || '',
                headRepo: prDetail.head?.repo?.full_name || prDetail.source?.path_with_namespace || '',
            };
            const ownLogin = _gitcodeLoginOfUser(user.username) || '';
            if (!pr.author || (user.role !== 'admin' && ownLogin.toLowerCase() !== pr.author.toLowerCase())) {
                return res.status(403).json({ success: false, message: '只能开启本人 PR 的监控，请检查绑定的 GitCode 身份' });
            }
            // 防呆：已合入/已关闭的 PR 拒绝开启监控（工作流识别阶段本会终止，提前拦截省 token）
            if (pr.state === 'merged') {
                return res.status(422).json({ success: false, message: `PR #${number} 已合入，无需开启监控` });
            }
            if (pr.state === 'closed') {
                return res.status(422).json({ success: false, message: `PR #${number} 已关闭（未合入）。若已在 GitCode 重新打开，请刷新 PR 列表后再开启` });
            }
            // 防呆：测试人已全部通过（GitCode 网页"测试人 ✓ 已通过"）的 PR 拒绝监控——
            // PR 已验证等待合入，监控推送代码会重置测试状态（列表接口 testers 恒空，须拉详情）
            if (prDetail && isTesterApproved(prDetail.testers)) {
                const names = (prDetail.testers || []).map(t => t?.login).filter(Boolean).join('、');
                return res.status(422).json({
                    success: false,
                    message: `PR #${number} 测试人已全部通过（${names}），等待合入即可，无需监控——监控推送代码会重置测试状态。如需处理检视意见请在 GitCode 手动操作`,
                });
            }
            const startKey = `${repoFull}#${number}`;
            if (pendingMonitorStarts.get(startKey)) {
                const ps = pendingMonitorStarts.get(startKey);
                return res.status(409).json({ success: false, runId: ps.runId,
                    message: `${repoShort} PR #${number} 正在启动监控，请等待列表刷新` });
            }
            const capabilities = loadCapabilities(pr.author, owner, repoName);

            // H5：探测返回后再原子预占（检查与写入之间无 await），避免并发请求重复启动；
            // 队列轮到执行前还会再核对一次活跃 run。
            const existingReservation = pendingMonitorStarts.get(startKey);
            if (existingReservation) {
                return res.status(409).json({ success: false, runId: existingReservation.runId,
                    message: `${repoShort} PR #${number} 正在启动监控，请等待列表刷新` });
            }
            const reservation = {};
            pendingMonitorStarts.set(startKey, reservation);
            const releaseReservation = () => {
                if (pendingMonitorStarts.get(startKey) === reservation) pendingMonitorStarts.delete(startKey);
            };
            releaseMonitorReservation = releaseReservation;

            const queued = _runMonitorStartTask(async () => {
                // 队列轮到执行前再核对：若已有活跃 run 则跳过（避免排队期间被他处启动）
                const activeNow = findActiveRunByPr(number, repoShort);
                if (activeNow) return { skipped: true, runId: activeNow.runId };
                // R08：记录本次采用的策略版本（失败不阻断启动）
                let policyVersion = '';
                try {
                    const pol = await Promise.race([
                        getPrReviewPolicy(token, owner, repoName, pr.baseRef || ''),
                        new Promise(resolve => setTimeout(() => resolve(null), 3000)),
                    ]);
                    policyVersion = pol?.version || '';
                } catch { /* 策略服务不可用时留空 */ }
                return startPrMonitor(token, {
                    owner, repo: repoName,
                    number: pr.number, title: pr.title, author: pr.author || user.username,
                    headRef: pr.headRef, baseRef: pr.baseRef, headSha: pr.headSha,
                    headRepo: pr.headRepo, state: pr.state, policyVersion,
                });
            });
            queued.then(out => {
                if (!out.ok) { releaseReservation(); return; }
                reservation.runId = out.value?.runId;
                const release = setTimeout(releaseReservation, 30000);
                release.unref?.();
            });
            // 最多等 60s（前端超时 90s）；超时转后台启动，立即返回排队成功
            let startWaitTimer;
            const timedOut = await Promise.race([
                queued.then(() => false),
                new Promise(resolve => { startWaitTimer = setTimeout(() => resolve(true), MONITOR_START_MAX_WAIT_MS); }),
            ]).finally(() => clearTimeout(startWaitTimer));
            if (timedOut) {
                logger.info('PR 监控启动排队中（转后台继续）', { username: user.username, pr: `${repoShort}#${pr.number}` });
                queued.then(out => {
                    if (out.ok) logger.info('排队启动完成（后台）', { pr: `${repoShort}#${pr.number}`, skipped: Boolean(out.value?.skipped) });
                    else logger.warn('排队启动失败（后台）', { pr: `${repoShort}#${pr.number}`, error: out.error?.message });
                });
                return res.json({
                    success: true,
                    queued: true,
                    capabilities,
                    message: `PR #${pr.number} 已加入启动队列（并发保护限流），处理后列表会自动刷新`,
                });
            }
            const out = await queued;
            if (!out.ok) throw out.error;
            if (out.value?.skipped) {
                return res.status(409).json({
                    success: false,
                    message: `${repoShort} PR #${number} 已有监控任务进行中（${out.value.runId}），无需重复开启`,
                    runId: out.value.runId,
                });
            }
            const result = out.value;
            logger.info('人工开启 PR 监控', { username: user.username, pr: `${repoShort}#${pr.number}`, runId: result.runId });
            res.json({ success: true, ...result, capabilities });
        } catch (err) {
            if (releaseMonitorReservation) releaseMonitorReservation();
            logger.warn('人工开启 PR 监控失败', { error: err.message });
            const status = err.message.includes('HTTP 401') ? 401 : 500;
            res.status(status).json({ success: false, message: err.message });
        }
    });

    // ── 9. 人工关闭 PR 监控 ───────────────────────────────────────────────────

    router.post('/pr-review/monitor/stop', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        try {
            const user = await getUserByToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            }
            const { runId } = req.body ?? {};
            // 校验 run 归属：非管理员只能停止自己的 run
            const runs = await listPrReviewRuns(token, 1, 100);
            const target = runs.runs.find(r => r.runId === runId);
            if (!target && user.role !== 'admin') {
                return res.status(403).json({ success: false, message: '只能停止自己的监控任务' });
            }
            const result = await stopPrMonitor(token, runId);
            logger.info('人工关闭 PR 监控', { username: user.username, runId, message: result.message });
            res.json({ success: true, ...result });
        } catch (err) {
            logger.warn('人工关闭 PR 监控失败', { runId: req.body?.runId, error: err.message });
            const status = err.message.includes('HTTP 401') ? 401 : 500;
            res.status(status).json({ success: false, message: err.message });
        }
    });

    // ── 10. 用户 GitCode 令牌：查询（脱敏）/ 保存 / 清除 ────────────────────────

    router.get('/pr-review/gitcode-token', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        try {
            const user = await getUserByToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            }
            const data = await getGitcodeTokens(token);
            res.json({ success: true, ...data });
        } catch (err) {
            logger.error('查询 GitCode 令牌状态失败', { error: err.message });
            const status = err.message.includes('HTTP 401') ? 401 : 500;
            res.status(status).json({ success: false, message: err.message });
        }
    });

    router.post('/pr-review/gitcode-token', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        try {
            const user = await getUserByToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            }
            const { token: gitcodeToken, owner, repo } = req.body ?? {};
            const data = await saveGitcodeToken(token, gitcodeToken, { owner, repo });
            logger.info('用户配置 GitCode 令牌', {
                username: user.username,
                gitcode: data.gitcodeUsername,
                probed: Boolean(data.capabilities),
            });
            res.json({ success: true, ...data, masked: String(gitcodeToken || '').slice(0, 4) + '****' });
        } catch (err) {
            logger.warn('保存 GitCode 令牌失败', { error: err.message });
            const status = err.message.includes('令牌无效') || err.message.includes('不能为空') ? 400
                : err.message.includes('HTTP 401') ? 401 : 500;
            res.status(status).json({ success: false, message: err.message });
        }
    });

    // R02：查询某仓库下已绑定的 GitCode 能力（身份/读/评论/推送），供页面提示与修复入口
    router.get('/pr-review/gitcode-token/capabilities', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        try {
            const user = await getUserByToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            }
            const owner = String(req.query?.owner || '').trim();
            const repo = String(req.query?.repo || '').trim();
            const info = await getGitcodeTokens(token).catch(() => ({ tokens: [] }));
            const wanted = String(req.query?.author || '').trim().toLowerCase();
            let entry = wanted
                ? info.tokens.find(t => String(t.gitcodeUsername || '').toLowerCase() === wanted)
                : null;
            if (!entry && info.tokens.length) entry = info.tokens[0];
            const login = entry?.gitcodeUsername || '';
            let stored = login ? loadCapabilities(login, owner, repo) : null;
            // probe=1：用该身份的令牌原文做一次只读探测并缓存（绝不把原文返回给前端）
            if (req.query?.probe === '1' && entry && owner && repo) {
                try {
                    const values = await getGitcodeTokenValues(token);
                    const raw = values.find(v => String(v.login || '').toLowerCase() === String(login).toLowerCase())?.value;
                    if (raw) {
                        stored = await probeGitcodeCapabilities(raw, owner, repo);
                        saveCapabilities(login, owner, repo, stored);
                    }
                } catch (e) {
                    logger.warn('GitCode 能力探测失败', { login, owner, repo, error: e.message });
                }
            }
            const capabilities = deriveCapabilities({ bound: Boolean(entry), login, stored });
            res.json({ success: true, gitcodeUsername: login, tokens: info.tokens, capabilities });
        } catch (err) {
            logger.error('查询 GitCode 能力失败', { error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    router.delete('/pr-review/gitcode-token', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        try {
            const user = await getUserByToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            }
            const data = await clearGitcodeToken(token);
            logger.info('用户清除 GitCode 令牌', { username: user.username, removed: data.removed });
            res.json({ success: true, ...data });
        } catch (err) {
            logger.error('清除 GitCode 令牌失败', { error: err.message });
            const status = err.message.includes('HTTP 401') ? 401 : 500;
            res.status(status).json({ success: false, message: err.message });
        }
    });

    // R04：监控健康与时延。用本机 admin 服务令牌只读查询 AceHarness 队列/耗时统计，
    // 并附上该 PR 活跃 run 的等待原因；admin 令牌不可用时降级返回本地可见信息。
    router.get('/pr-review/monitor/health', async (req, res) => {
        const token = extractToken(req);
        if (!token) return res.status(401).json({ success: false, message: '未登录' });
        try {
            const user = await getUserByToken(token);
            if (!user) return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            const isAdmin = user.role === 'admin';

            // H1：全局队列统计只对管理员开放；普通用户只能拿到自己被授权 PR 的健康信息，
            // 不能借本机 admin 令牌绕过引擎的管理员边界。
            let queue = null;
            let degraded = false;
            let error = null;
            if (isAdmin) {
                const admin = _readAdminTokenForWake();
                if (!admin) {
                    degraded = true;
                    error = '本机无可用 admin 服务令牌，队列统计暂不可用';
                } else {
                    try {
                        const r = await httpRequest('GET', '/api/gitcode/monitor', null, {
                            token: admin, baseUrl: ACEHARNESS_API_BASE_URL, timeoutMs: 6000,
                        });
                        if (r.status === 200) queue = r.data;
                        else { degraded = true; error = `队列接口返回 HTTP ${r.status}`; }
                    } catch (e) {
                        degraded = true;
                        error = e.message;
                    }
                }
            } else {
                degraded = true;
                error = '全局队列统计仅管理员可见';
            }

            const number = String(req.query?.number || '').trim();
            const repo = String(req.query?.repo || '').trim();
            let run = null;
            if (number && repo) {
                const active = findActiveRunByPr(number, repo);
                if (active) {
                    if (isAdmin || (await findOwnedPrReviewRun(token, active.runId))) {
                        const park = classifyParkApproval(active.runId);
                        const waitReason = active.status === 'running'
                            ? (park === 'decision' ? '等待用户决策' : park === 'webhook' ? '等待 CI' : null)
                            : (active.status === 'preparing' || active.status === 'pending' ? '准备中' : null);
                        run = { runId: active.runId, status: active.status, waitReason };
                    }
                }
            }

            res.json({
                success: true,
                scope: isAdmin ? 'admin' : 'user',
                degraded,
                error,
                queue,
                run,
                reconcileIntervalMs: 30000,
                generatedAt: new Date().toISOString(),
            });
        } catch (err) {
            logger.error('查询监控健康失败', { error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // ── 邮件通知开关（读写同机 AceHarness settings，改完即生效，无需重启） ──

    router.get('/pr-review/email-notify', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        // A12：仅"token 非空"不校验会泄露开关状态；必须校验登录态
        try {
            const user = await getUserByToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            }
            res.json({ success: true, ...readEmailNotifyState() });
        } catch (err) {
            logger.error('查询邮件通知状态失败', { error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    router.post('/pr-review/email-notify', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        try {
            const user = await getUserByToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            }
            // A12：该开关控制全站 PR 监控的邮件通知，仅 admin 可修改
            if (user.role !== 'admin') {
                logger.warn('非管理员尝试切换邮件通知被拒', { username: user.username });
                return res.status(403).json({ success: false, message: '邮件通知是全站设置，仅管理员可修改' });
            }
            const enabled = req.body?.enabled === true;
            const state = setEmailNotifyEnabled(enabled);
            logger.info('用户切换邮件通知', { username: user.username, enabled, configured: state.configured });
            res.json({ success: true, ...state });
        } catch (err) {
            logger.error('切换邮件通知失败', { error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // ── 11. 通知拉取（小鲁班/内网机器人）：待通知事件 + API Key 鉴权 ──────────

    router.get('/notify/pending', async (req, res) => {
        const key = req.headers['x-notify-key'];
        const expected = process.env.NOTIFY_API_KEY;
        if (!expected || key !== expected) {
            return res.status(401).json({ success: false, message: 'invalid notify key' });
        }
        try {
            const events = collectNotifyEvents();
            res.json({
                success: true,
                serverTime: new Date().toISOString(),
                count: events.length,
                events,
            });
        } catch (err) {
            logger.error('通知事件扫描失败', { error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // 通知回执：机器人发送成功后调用，之后不再出现在 pending 里
    router.post('/notify/ack', async (req, res) => {
        const key = req.headers['x-notify-key'];
        const expected = process.env.NOTIFY_API_KEY;
        if (!expected || key !== expected) {
            return res.status(401).json({ success: false, message: 'invalid notify key' });
        }
        const { eventId } = req.body ?? {};
        if (!eventId) {
            return res.status(400).json({ success: false, message: '缺少 eventId' });
        }
        try {
            ackNotifyEvent(eventId);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // ── 12. AI 检视修复：意见 + 修改可视化 + 用户决策 ─────────────────────────

    // 决策持久化（同机 JSON，与通知状态同目录）
    const decisionInflight = new Set();
    const DECISION_FILE = join(homedir(), '.aceharness', 'data', 'aiweb-review-decisions.json');

    function _loadDecisions() {
        let all = {};
        try { all = JSON.parse(readFileSync(DECISION_FILE, 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        for (const op of listOperations()) {
            if (op.sourceRunId && op.decision && (!all[op.sourceRunId]
                || op.decision.decidedAt >= all[op.sourceRunId].decidedAt)) all[op.sourceRunId] = op.decision;
        }
        return all;
    }

    function _saveDecision(runId, entry) {
        try {
            mkdirSync(join(homedir(), '.aceharness', 'data'), { recursive: true });
            const all = _loadDecisions();
            all[runId] = entry;
            const tmp = `${DECISION_FILE}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(all, null, 2));
            renameSync(tmp, DECISION_FILE);
        } catch (e) {
            logger.error('检视决策写入失败', { error: e.message });
            throw e;
        }
    }

    // 校验 run 归属：返回 { user, run }，失败时已回写响应
    async function _authRun(req, res, runId, { needUser = true } = {}) {
        const token = extractToken(req);
        if (!token) {
            res.status(401).json({ success: false, message: '未登录' });
            return null;
        }
        let user = null;
        let run = null;
        if (needUser) {
            [user, run] = await Promise.all([
                getUserByToken(token),
                findOwnedPrReviewRun(token, runId),
            ]);
        } else {
            run = await findOwnedPrReviewRun(token, runId);
        }
        if (run && !needUser) return { user: null, run };
        if (!needUser && !user) user = await getUserByToken(token);
        if (!user) {
            res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            return null;
        }
        if (!run && user.role !== 'admin') {
            res.status(403).json({ success: false, message: '只能操作自己的监控任务' });
            return null;
        }
        return { user, run: run || { runId } };
    }

    // R02：结合已绑定身份、历史探测结果与本次推送结果，推导能力视图。
    async function _capabilitiesFor(token, meta, { pushFailed, pushSucceeded, pushStatus, credentialFingerprint } = {}) {
        let bound = false;
        let login = '';
        let fingerprint = '';
        try {
            const info = await getGitcodeTokens(token);
            const wanted = String(meta?.author || '').toLowerCase();
            const entry = info.tokens.find(t => String(t.gitcodeUsername || '').toLowerCase() === wanted && t.enabled !== false) || null;
            bound = Boolean(entry);
            login = entry?.gitcodeUsername || '';
            fingerprint = entry?.credentialFingerprint || '';
        } catch { /* 读取失败按未绑定处理 */ }
        // 令牌更新/删除时会清空该身份的能力缓存，因此这里按身份读取即可
        const stored = login ? loadCapabilities(login, meta?.owner, meta?.repo, fingerprint) : null;
        return { gitcodeUsername: login, ...deriveCapabilities({ bound, login, stored, pushFailed, pushSucceeded, pushStatus, currentFingerprint: fingerprint, evidenceFingerprint: credentialFingerprint }) };
    }

    // 操作记录 → 带中文展示状态的列表
    function _operationsView(runId) {
        return listOperations({ runId }).map(op => {
            const evidence = readExecutionEvidence(op.runId);
            const current = reconcileOperation(op.key, evidence) || op;
            return { ...current, stateLabel: OPERATION_STATE_LABELS[current.state] || current.state };
        });
    }

    // 12a. 读取检视修复数据（AI 意见 + fix.patch + 决策状态 + PR 当前生命周期）
    router.get('/pr-review/runs/:runId/review-fix', async (req, res) => {
        try {
            const auth = await _authRun(req, res, req.params.runId, { needUser: false });
            if (!auth) return;
            const data = await getReviewFixData(extractToken(req), req.params.runId);
            // 附 PR 当前状态（merged/closed 时前端隐藏决策按钮，防点了才 422）
            const meta = data.prMeta || {};
            let prState = null;
            let prHeadSha = null;
            let prDetailError = null;
            if (meta.owner && meta.repo && meta.number) {
                try {
                    const prNow = await getGitcodePrDetail(meta.owner, meta.repo, meta.number, 4000);
                    if (!prNow) prDetailError = 'PR 当前状态暂不可读';
                    prState = prNow ? (prNow.merged ? 'merged' : String(prNow.state || '').toLowerCase()) : null;
                    prHeadSha = prNow?.head?.sha || prNow?.head?.id || null;
                } catch (e) { prDetailError = e.message; }
            }
            const competingActiveRun = meta.owner && meta.repo && meta.number
                ? findActiveRunByPr(meta.number, meta.repo)
                : null;
            const decisions = _loadDecisions();
            const runDecision = decisions[req.params.runId] || null;
            _operationsView(req.params.runId);
            const failedApplyRunId = await _failedAppliedRunId(extractToken(req), runDecision);
            const canRetryApply = Boolean(
                failedApplyRunId
                && data.suggestionMode
                && data.patch
                && data.suggestion?.headSha
                && prState === 'open'
                && prHeadSha === data.suggestion.headSha
                && (!competingActiveRun || competingActiveRun.runId === req.params.runId)
            );
            const canRetryPush = Boolean(
                data.patch
                && data.patchSource === 'run'
                && !data.suggestionMode
                && !data.pushSucceeded
                && (data.pushFailed || auth.run?.currentPhase === HUMAN_PHASE || ['failed', 'crashed', 'stopped'].includes(auth.run?.status))
                && data.prMeta?.origHeadSha
                && prState === 'open'
                && prHeadSha === data.prMeta.origHeadSha
                && (!runDecision || runDecision.decision === 'approved')
                && (!competingActiveRun || competingActiveRun.runId === req.params.runId)
            );
            let decision = runDecision;
            // 决策继承：本 run 若是某次 revert/feedback 决策启动的新任务，
            // 显示源头决策（避免新 run 上又出现重复决策按钮）
            if (!decision) {
                for (const entry of Object.values(decisions)) {
                    if (entry.newRunId === req.params.runId) {
                        decision = { ...entry, spawnedByDecision: true };
                        break;
                    }
                }
            }
            // H4：只从「该操作自己的执行 run（op.runId）」更新证据；sourceRunId 仅用于关联展示，
            // 因此查看源任务不会用旧的失败证据覆盖执行任务的新结论。
            let operations = _operationsView(req.params.runId);
            try {
                for (const op of operations) {
                    if (op.runId !== req.params.runId) continue;
                    reconcileOperation(op.key, {
                        pushStatus: data.pushStatus,
                        pushSucceeded: data.pushSucceeded,
                        pushFailed: data.pushFailed,
                        runStatus: auth.run?.status,
                        commitSha: data.commitSha,
                        remoteHeadSha: data.remoteHeadSha,
                        buildCredential: data.buildCredential,
                        ciPassed: data.ciPassed, ciSha: data.ciSha, ciObserved: data.ciObserved,
                        evidenceRunId: req.params.runId,
                    });
                }
                operations = _operationsView(req.params.runId);
            } catch (e) {
                logger.warn('操作记录对账失败', { runId: req.params.runId, error: e.message });
            }
            const capabilities = await _capabilitiesFor(extractToken(req), meta, {
                pushFailed: data.pushFailed,
                pushSucceeded: data.pushSucceeded,
                pushStatus: data.pushStatus, credentialFingerprint: data.credentialFingerprint,
            });
            const evidence = buildFixEvidence(data, { prState, prHeadSha });
            // R04：该 run 视角的监控健康。lastCheckedAt 取业务数据来源（run summary）的时间，
            // 与生成响应时间区分；查询失败如实标注，不对非补查任务承诺下一次补查。
            const runStatus = String(auth.run?.status || '').toLowerCase();
            const currentPhase = auth.run?.currentPhase;
            let waitReason = null;
            let gateWait = false;
            if (currentPhase === HUMAN_PHASE) {
                const park = classifyParkApproval(req.params.runId);
                waitReason = park === 'decision' ? '等待用户决策' : park === 'webhook' ? '等待 CI' : '等待用户处理';
                gateWait = park === 'webhook';
            } else if (runStatus === 'running') waitReason = '执行中';
            else if (runStatus === 'preparing' || runStatus === 'pending') waitReason = '准备中';
            const monitorHealth = buildPrMonitorHealth({
                runStatus, waitReason, gateWait, lastCheckedAt: data.gateCheckedAt || null,
                generatedAt: evidence.asOf, queryError: prDetailError || (data.gateReadFailed ? data.gateError || '门禁查询失败' : null),
            });
            res.json({
                success: true,
                ...data,
                prState,
                prHeadSha,
                canRetryApply,
                failedApplyRunId: canRetryApply ? failedApplyRunId : '',
                canRetryPush,
                decision,
                operations,
                capabilities,
                evidence,
                monitorHealth,
            });
        } catch (err) {
            logger.error('读取检视修复数据失败', { runId: req.params.runId, error: err.message });
            const status = err.message.includes('HTTP 401') ? 401 : 500;
            res.status(status).json({ success: false, message: err.message });
        }
    });

    // R01：查询一个 run 相关的修复操作记录（发起 run 或执行 run 均可见）
    router.get('/pr-review/runs/:runId/operations', async (req, res) => {
        try {
            const auth = await _authRun(req, res, req.params.runId, { needUser: false });
            if (!auth) return;
            res.json({ success: true, operations: _operationsView(req.params.runId) });
        } catch (err) {
            logger.error('查询操作记录失败', { runId: req.params.runId, error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // R07：增量事件（按序号续读；断线可从 nextSeq 恢复），代理引擎的事件日志。
    router.get('/pr-review/runs/:runId/events', async (req, res) => {
        try {
            const token = extractToken(req);
            const auth = await _authRun(req, res, req.params.runId, { needUser: false });
            if (!auth) return;
            const afterSeq = Math.max(0, Number(req.query?.afterSeq) || 0);
            const limit = Math.min(1000, Math.max(1, Number(req.query?.limit) || 200));
            const r = await httpRequest('GET', `/api/workflow/event-log?runId=${encodeURIComponent(req.params.runId)}&afterSeq=${afterSeq}&limit=${limit}`, null, { token, baseUrl: ACEHARNESS_API_BASE_URL, timeoutMs: 8000 });
            if (r.status !== 200) {
                return res.status(r.status === 403 ? 403 : 502).json({ success: false, message: r.data?.error || `事件接口返回 HTTP ${r.status}` });
            }
            const events = r.data?.events || [];
            res.json({ success: true, runId: req.params.runId, events, nextSeq: r.data?.nextSeq ?? afterSeq, hasMore: events.length >= limit });
        } catch (err) {
            logger.error('查询增量事件失败', { runId: req.params.runId, error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // R07：按需读取本次修复 diff（大 diff 不随主数据下发，可截断）。
    router.get('/pr-review/runs/:runId/diff', async (req, res) => {
        try {
            const token = extractToken(req);
            const auth = await _authRun(req, res, req.params.runId, { needUser: false });
            if (!auth) return;
            const data = await getReviewFixData(token, req.params.runId);
            const maxBytes = Math.min(2_000_000, Math.max(1000, Number(req.query?.maxBytes) || 400_000));
            const patch = String(data.patch || '');
            const truncated = patch.length > maxBytes;
            res.json({ success: true, runId: req.params.runId, patchSource: data.patchSource || null, truncated, patch: truncated ? patch.slice(0, maxBytes) : patch });
        } catch (err) {
            logger.error('读取增量 diff 失败', { runId: req.params.runId, error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // R09：通知出站状态与投递回执（管理员）
    router.get('/pr-review/notify/outbox', async (req, res) => {
        const token = extractToken(req);
        if (!token) return res.status(401).json({ success: false, message: '未登录' });
        try {
            const user = await getUserByToken(token);
            if (!user) return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            if (user.role !== 'admin') return res.status(403).json({ success: false, message: '仅管理员可查看通知出站' });
            res.json({ success: true, ...outboxStatus() });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });
    router.post('/pr-review/notify/outbox/:id/ack', async (req, res) => {
        const token = extractToken(req);
        if (!token) return res.status(401).json({ success: false, message: '未登录' });
        try {
            const user = await getUserByToken(token);
            if (!user) return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            if (user.role !== 'admin') return res.status(403).json({ success: false, message: '仅管理员可操作通知出站' });
            const ok = req.body?.success !== false;
            const item = ok ? outboxMarkSent(req.params.id, { by: user.username }) : outboxMarkFailed(req.params.id, req.body?.error || '发送失败');
            if (!item) return res.status(404).json({ success: false, message: '通知记录不存在' });
            res.json({ success: true, item: { id: item.id, status: item.status, attempts: item.attempts } });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // R09：统一待办（推送受阻 / 通知失败 / 权限不足）
    router.get('/pr-review/todos', async (req, res) => {
        const token = extractToken(req);
        if (!token) return res.status(401).json({ success: false, message: '未登录' });
        try {
            const user = await getUserByToken(token);
            if (!user) return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            const isAdmin = user.role === 'admin';
            const operations = listOperations().filter(op => isAdmin || op.decidedBy === user.username);
            const notifications = isAdmin ? (outboxStatus().items || []) : [];
            res.json({ success: true, todos: buildTodos({ operations, notifications }) });
        } catch (err) {
            logger.error('查询待办失败', { error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // 12b. 用户决策：approve（认可）/ revert（恢复原版）/ feedback（按建议改）
    router.post('/pr-review/runs/:runId/review-fix/decision', async (req, res) => {
        const lockKey = req.params.runId;
        if (decisionInflight.has(lockKey)) return res.status(409).json({ success: false, message: '该任务正在处理决策，请稍后刷新' });
        decisionInflight.add(lockKey);
        try {
            const token = extractToken(req);
            const auth = await _authRun(req, res, req.params.runId);
            if (!auth) return;
            const { user } = auth;
            const runId = req.params.runId;
            let decision = req.body?.decision;
            if (!['approve', 'revert', 'feedback', 'apply', 'dismiss'].includes(decision)) {
                return res.status(400).json({ success: false, message: 'decision 必须是 approve / revert / feedback / apply / dismiss' });
            }

            // 已有终态决策时拒绝重复操作（保护 fork：避免连点两次 revert）；
            // approved 例外：用户认可后仍允许反悔做 revert / feedback
            _operationsView(runId);
            const prev = _loadDecisions()[runId];
            const failedApplyRunId = decision === 'apply'
                ? await _failedAppliedRunId(token, prev)
                : '';
            const canRetryAppliedDecision = Boolean(failedApplyRunId);
            if (prev && prev.decision !== 'approved' && !canRetryAppliedDecision) {
                const decisionLabel = {
                    reverted: '已回退', 'feedback-applied': '已按建议修改', dismissed: '已驳回', applied: '已应用建议',
                }[prev.decision] || prev.decision;
                return res.status(409).json({
                    success: false,
                    message: `该修复已处理过（${decisionLabel}${prev.newRunId ? `，新任务 ${prev.newRunId}` : ''}），请勿重复操作`,
                    decision: prev,
                });
            }
            // 决策继承的 run 不允许继续 revert/feedback；apply 仅保留一次受 head 校验保护的推送重试。
            if (!prev && decision !== 'apply') {
                for (const entry of Object.values(_loadDecisions())) {
                    if (entry.newRunId === runId) {
                        return res.status(409).json({
                            success: false,
                            message: '本任务由你的决策操作产生，如需再次调整，请对该任务的新一轮检视修复做决策',
                            decision: entry,
                        });
                    }
                }
            }

            const data = await getReviewFixData(token, runId);
            // 兼容旧页面的 approve：本次未推送 patch 的认可必须走真正应用流程。
            if (decision === 'approve' && data.patchSource === 'run' && data.patch && !data.pushSucceeded) decision = 'apply';
            if (!data.hasReviewFix && !(decision === 'apply' && data.patch)) {
                return res.status(404).json({ success: false, message: '该任务没有 AI 检视意见数据' });
            }

            if (decision === 'approve') {
                const entry = { decision: 'approved', decidedAt: new Date().toISOString(), byUser: user.username };
                _saveDecision(runId, entry);
                logger.info('用户认可检视修复', { username: user.username, runId });
                return res.json({ success: true, decision: entry, message: '已记录认可；此操作本身不会创建提交或推送代码。' });
            }

            // ── 驳回（建议模式）：发驳回标记评论（fetch-ai-review 识别，后续 run 不再生成建议）→ 停监控 ──
            if (decision === 'dismiss') {
                const meta = data.prMeta || {};
                if (!meta.owner || !meta.repo || !meta.number) {
                    return res.status(422).json({ success: false, message: '任务输出中缺少 PR 元数据，无法驳回' });
                }
                const commentCount = data.actionableCount ?? data.aiComments?.length ?? 0;
                // 候选评论身份：PR 作者 → 决策用户（谁有令牌用谁的）
                const userLogin = _gitcodeLoginOfUser(user.username);
                let commentResult = null;
                let commentError = null;
                try {
                    commentResult = await postReviewDismissComment(
                        data.prMeta.prUrl || `https://gitcode.com/${meta.owner}/${meta.repo}/merge_requests/${meta.number}`,
                        [meta.author, userLogin].filter(Boolean),
                        commentCount,
                    );
                } catch (e) {
                    commentError = e.message;
                }
                // 停掉本 PR 的活跃监控 run（驳回 = 用户自行处理，监控结束）
                const globalActive = findActiveRunByPr(meta.number, meta.repo);
                if (globalActive) {
                    try {
                        await stopPrMonitor(token, globalActive.runId);
                        logger.info('驳回后停止活跃 run', { pr: `#${meta.number}`, runId: globalActive.runId });
                    } catch (err) {
                        logger.warn('驳回后停止活跃 run 失败', { runId: globalActive.runId, error: err.message });
                    }
                }
                const entry = {
                    decision: 'dismissed',
                    decidedAt: new Date().toISOString(),
                    byUser: user.username,
                    commentPosted: Boolean(commentResult),
                    commentPostedAs: commentResult?.postedAs || null,
                    commentError: commentError || undefined,
                };
                _saveDecision(runId, entry);
                logger.info('用户驳回检视建议', { username: user.username, runId, commentPosted: Boolean(commentResult) });
                return res.json({
                    success: true,
                    decision: entry,
                    message: commentResult
                        ? `已驳回 ${commentCount} 条检视意见，并以 ${commentResult.postedAs} 身份在 PR 上留了处理标记，监控已结束`
                        : `已驳回并结束监控；但标记评论发布失败：${commentError}（后续重新监控可能重新生成建议）`,
                });
            }

            // ── 应用建议 / 重试未推送的修复：均以 user_apply_patch 启动新 run ──
            if (decision === 'apply') {
                if (!data.patch) {
                    return res.status(422).json({ success: false, message: '该任务没有可应用的 fix.patch' });
                }
                if (!data.suggestionMode && !data.pushFailed
                    && auth.run?.currentPhase !== HUMAN_PHASE
                    && !['failed', 'crashed', 'stopped'].includes(auth.run?.status)) {
                    return res.status(409).json({ success: false, message: '该修复任务尚未进入可重试状态，请等工作流完成推送步骤后刷新' });
                }
            }

            // revert / feedback 需要启动指令 run：必须先有完整 PR 元数据
            const meta = data.prMeta || {};
            if (!meta.owner || !meta.repo || !meta.number || !meta.author) {
                return res.status(422).json({ success: false, message: '任务输出中缺少 PR 元数据，无法执行该操作' });
            }

            let instruction;
            let prInfo = {
                owner: meta.owner, repo: meta.repo, number: meta.number, title: meta.title,
                author: meta.author, headRef: meta.headRef, baseRef: meta.baseRef,
                headRepo: meta.headRepo, state: 'open',
            };
            // 实时拉 PR：同时校验生命周期（仅 open 状态可执行指令，避免对已关闭/已合并 PR 推 fork）
            const pull = await getGitcodePrDetail(meta.owner, meta.repo, meta.number, 5000);
            const prNow = pull ? {
                state: pull.merged ? 'merged' : String(pull.state || '').toLowerCase(),
                author: pull.user?.login || pull.author?.username || '',
                headSha: pull.head?.sha || pull.head?.id || '',
            } : null;
            if (!prNow) {
                return res.status(503).json({ success: false, message: `暂时无法读取 GitCode PR #${meta.number} 状态，请稍后重试；未启动新任务` });
            }
            if (prNow.state !== 'open') {
                return res.status(422).json({ success: false, message: `PR #${meta.number} 已${prNow.state === 'merged' ? '合入' : '关闭'}，无需再执行修改/回退` });
            }
            if (prNow.author && prNow.author.toLowerCase() !== String(meta.author || '').toLowerCase()) {
                return res.status(422).json({ success: false, message: 'PR 作者与任务记录不一致，为防止误操作已拒绝' });
            }
            if (decision === 'feedback') {
                const feedback = String(req.body?.feedback || '').trim();
                if (feedback.length < 5) {
                    return res.status(400).json({ success: false, message: '请填写修改建议（至少 5 个字符）' });
                }
            }
            if (decision === 'revert') {
                if (!data.patch) {
                    return res.status(422).json({ success: false, message: '该任务没有可回退的修改（无 fix.patch）' });
                }
                // GitCode 恢复的修改无法精确归属（可能混入作者本人的提交），禁止一键回退
                if (data.patchSource === 'recovered') {
                    return res.status(422).json({
                        success: false,
                        message: '该修改是从 GitCode 提交历史恢复的，无法精确归属到监控任务，不支持一键回退；如需回退请用「按我的建议修改」描述回退范围，或到 GitCode 手动处理',
                    });
                }
                // 回退区间起点 = 修复前基线：本任务推送用启动基线；历史任务推送用持久化的修复 run 基线
                const revertFrom = data.patchSource === 'history'
                    ? (data.historyOrigHeadSha || '')
                    : (meta.origHeadSha || '');
                if (!revertFrom) {
                    return res.status(422).json({ success: false, message: '无法确定回退基线（修复前的 commit sha），请手动处理' });
                }
                // to_sha：GitCode 实时拉当前 PR head
                const revertTo = prNow.headSha || '';
                if (!revertTo) {
                    return res.status(422).json({ success: false, message: '无法确定回退区间（缺少当前 commit sha）' });
                }
                if (revertTo === revertFrom) {
                    return res.status(422).json({ success: false, message: 'fork 分支已回到基线，无需回退' });
                }
                prInfo.headSha = revertTo;
                instruction = { kind: 'revert', revertFrom, revertTo };
            } else if (decision === 'apply') {
                // 建议模式使用生成时基线；已认可但 push 失败的 run 只允许在 PR
                // 仍停留于修复前 head 时重试，避免把旧 patch 重放到新代码上。
                if (data.suggestionMode) {
                    if (!prNow.headSha || !data.suggestion?.headSha) return res.status(422).json({ success: false, message: '缺少建议生成时或当前 PR 的 head，无法安全应用' });
                    if (prNow.headSha && data.suggestion?.headSha && prNow.headSha !== data.suggestion.headSha) {
                        return res.status(422).json({
                            success: false,
                            message: `PR 在建议生成后又有新提交（${String(prNow.headSha).slice(0, 8)} ≠ ${String(data.suggestion.headSha).slice(0, 8)}），建议可能不适用；请用「按我的想法改」重新生成`,
                        });
                    }
                } else if (data.patchSource !== 'run' || !meta.origHeadSha || prNow.headSha !== meta.origHeadSha) {
                    return res.status(422).json({
                        success: false,
                        message: '当前修改不是可安全重试的未推送 patch，或 PR head 已变化；请刷新检视数据并确认最新修复状态',
                    });
                }
                prInfo.headSha = prNow.headSha || '';
                instruction = { kind: 'apply_patch', sourceRunId: runId };
            } else {
                prInfo.headSha = prNow.headSha || '';
                instruction = { kind: 'feedback', feedback: String(req.body?.feedback || '').trim() };
            }

            // 输入与 PR head 校验通过后，再停止本 PR 活跃监控，避免无效操作中断现有 run。
            const globalActive = findActiveRunByPr(meta.number, meta.repo);
            if (decision === 'apply' && globalActive && globalActive.runId !== runId) {
                return res.status(409).json({
                    success: false,
                    message: `PR 当前有另一个活动任务 ${globalActive.runId}，请在该任务结束后再重试推送`,
                });
            }
            // R01：为本次动作建立幂等操作记录。同键进行中/已成功则拒绝，
            // 避免连点或请求重放导致重复推送、重复触发构建。
            const actionKind = decision;
            const patchHash = hashPatch(data.patch);
            if (decision === 'apply') instruction.patchHash = createHash('sha256').update(data.patch).digest('hex');
            const origHead = data.suggestionMode ? (data.suggestion?.headSha || '') : (meta.origHeadSha || '');
            const actionKey = operationKey({
                owner: meta.owner, repo: meta.repo, number: meta.number, origHead, patchHash, action: actionKind,
            });
            const begun = beginOperation({
                key: actionKey,
                action: actionKind,
                owner: meta.owner,
                repo: meta.repo,
                number: String(meta.number),
                origHead,
                patchHash,
                sourceRunId: runId,
                decidedBy: user.username,
                decision: { decision: decision === 'revert' ? 'reverted' : decision === 'apply' ? 'applied' : 'feedback-applied', decidedAt: new Date().toISOString(), byUser: user.username },
                state: 'to_apply',
            });
            if (!begun.created) {
                const label = OPERATION_STATE_LABELS[begun.operation.state] || begun.operation.state;
                const when = begun.operation.updatedAt || begun.operation.createdAt || '';
                return res.status(409).json({
                    success: false,
                    message: `该操作已在处理中或已完成（${label}${when ? `，${when}` : ''}），未重复执行`,
                    operation: { ...begun.operation, stateLabel: label },
                });
            }

            const attemptId = begun.operation.attemptId;
            let dispatched = false;
            let result;
            try {
                if (globalActive) await stopPrMonitor(token, globalActive.runId);
                if (decision === 'apply') {
                    archiveApprovedReview(runId, data.patch);
                }
                patchOperation(actionKey, { dispatchState: 'dispatching' }, attemptId);
                dispatched = true;
                result = await startReviewActionRun(token, prInfo, instruction, { runId: begun.operation.runId });
                patchOperation(actionKey, { status: 'running', state: 'to_apply', dispatchState: 'accepted',
                    runId: result.runId, decision: { ...begun.operation.decision, newRunId: result.runId } }, attemptId);
            } catch (startErr) {
                const retrySafe = !dispatched || startErr.definitelyNotStarted === true;
                patchOperation(actionKey, { status: retrySafe ? 'failed' : 'uncertain', state: 'blocked', retrySafe,
                    error: retrySafe ? '启动未完成，可以重试' : `启动结果待核对，执行编号 ${begun.operation.runId}；不会重复启动`,
                }, attemptId);
                throw startErr;
            }
            const entry = {
                decision: decision === 'revert' ? 'reverted' : decision === 'apply' ? 'applied' : 'feedback-applied',
                decidedAt: new Date().toISOString(),
                byUser: user.username,
                feedback: decision === 'feedback' ? instruction.feedback : undefined,
                newRunId: result.runId,
                operationKey: actionKey,
                ...(canRetryAppliedDecision ? {
                    previousRunIds: [...(Array.isArray(prev.previousRunIds) ? prev.previousRunIds : []), failedApplyRunId].slice(-5),
                } : {}),
            };
            _saveDecision(runId, entry);
            logger.info('检视修复用户决策', { username: user.username, runId, decision, newRunId: result.runId, actionKey });
            res.json({ success: true, decision: entry, newRunId: result.runId, operationKey: actionKey });
        } catch (err) {
            logger.error('检视修复决策失败', { runId: req.params.runId, decision: req.body?.decision, error: err.message });
            const status = err.message.includes('HTTP 401') ? 401 : 500;
            res.status(status).json({ success: false, message: err.message });
        } finally {
            decisionInflight.delete(lockKey);
        }
    });

    // ── 13. 一键重发 start build（run 停在人工确认时，以作者身份代发评论） ─────

    /** 平台用户名 → GitCode 登录名（驳回标记评论的候选身份；取其第一个绑定） */
    function _gitcodeLoginOfUser(platformUsername) {
        try {
            const id = listAllGitcodeIdentities().find(
                (x) => String(x.username || '').toLowerCase() === String(platformUsername || '').toLowerCase()
            );
            return id?.gitcodeUsername || null;
        } catch {
            return null;
        }
    }

    /** 从 run 的 state.yaml 读 globalContext（routes 侧轻量版，不引依赖） */
    function _readRunGlobalContextPublic(runId) {
        try {
            const yaml = readFileSync(join(homedir(), '.aceharness', 'runs', runId, 'state.yaml'), 'utf8');
            const m = /^globalContext:\s*[|>][+-]?\n([\s\S]*?)(?=\n[^\s])/m.exec(yaml);
            return m ? m[1] : '';
        } catch {
            return '';
        }
    }

    /** 读取 admin 服务 token 用于唤醒 run（同机 tokens.json） */
    function _readAdminTokenForWake() {
        try {
            const dataDir = join(homedir(), '.aceharness', 'data');
            const users = JSON.parse(readFileSync(join(dataDir, 'users.json'), 'utf8'));
            const adminIds = new Set(users.filter(u => u.role === 'admin' && u.status === 'active').map(u => u.id));
            const tokens = JSON.parse(readFileSync(join(dataDir, 'tokens.json'), 'utf8'));
            const now = Date.now();
            for (const [token, info] of tokens) {
                if (info?.userId && adminIds.has(info.userId) && info.expiry > now) {
                    return token;
                }
            }
        } catch { /* 读不到返回 null */ }
        return null;
    }

    router.post('/pr-review/runs/:runId/retry-build', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        try {
            const auth = await _authRun(req, res, req.params.runId);
            if (!auth) return;
            const runId = req.params.runId;
            const user = auth.user;

            // 读取 run 元数据（PR URL + 作者）
            const gc = _readRunGlobalContextPublic(runId);
            const prUrl = /^\s*pr_url:\s*(\S+)/m.exec(gc)?.[1] || '';
            const author = /^\s*author:\s*(\S+)/m.exec(gc)?.[1] || '';
            if (!prUrl || !author) {
                return res.status(422).json({ success: false, message: '任务数据中缺少 PR URL 或作者，无法代发' });
            }

            // 按 PR URL 直接读取详情，避免全组织仓库扫描尚未完成时误判 PR 状态。
            try {
                const match = /^https?:\/\/gitcode\.com\/([^/]+)\/([^/]+)\/(?:pull|pulls|merge_requests)\/(\d+)/i.exec(prUrl);
                if (match) {
                    const detail = await getGitcodePrDetail(decodeURIComponent(match[1]), decodeURIComponent(match[2]), match[3]);
                    const state = detail?.merged ? 'merged' : String(detail?.state || '').toLowerCase();
                    if (detail && state && state !== 'open') {
                        return res.status(422).json({ success: false, message: `PR 已${state === 'merged' ? '合入' : '关闭'}，无需重发 start build` });
                    }
                }
            } catch { /* GitCode 不可达时不阻塞——评论接口本身会校验 */ }

            // 以作者身份评论 start build
            const result = await postStartBuildAsAuthor(prUrl, author);
            logger.info('一键重发 start build', { username: user.username, runId, prUrl, author });

            // 唤醒 run 回等待门禁（重新监控新一轮构建）
            try {
                const adminToken = _readAdminTokenForWake();
                if (adminToken) {
                    const wakeReq = await fetch(`http://127.0.0.1:${process.env.ACE_PORT || 3031}/api/workflow/resume`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            runId,
                            action: 'force-transition',
                            targetState: '等待门禁',
                            instruction: `用户 ${user.username} 已通过 AIWeb 一键重发 start build（${new Date().toISOString()}），请重新执行检查门禁。`,
                        }),
                        signal: AbortSignal.timeout(15000),
                    });
                    logger.info('重发后唤醒 run', { runId, status: wakeReq.status });
                }
            } catch (wakeErr) {
                logger.warn('重发后唤醒 run 失败（评论已发出，run 可能需要手动唤醒）', { runId, error: wakeErr.message });
            }

            res.json({ success: true, ...result, message: `已以 ${author} 身份评论 start build，正在唤醒监控任务` });
        } catch (err) {
            logger.warn('一键重发 start build 失败', { runId: req.params.runId, error: err.message });
            const status = err.message.includes('令牌') || err.message.includes('已合入') || err.message.includes('已关闭') ? 422
                : err.message.includes('HTTP 401') ? 401 : 500;
            res.status(status).json({ success: false, message: err.message });
        }
    });

    // ── 13b. 同步兄弟 PR 修复（手动触发跨分支修复同步） ──────────────────────

    router.post('/pr-review/runs/:runId/sync-sibling-fix', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        try {
            const auth = await _authRun(req, res, req.params.runId);
            if (!auth) return;
            const runId = req.params.runId;
            const user = auth.user;

            // 读取 run 元数据
            const gc = _readRunGlobalContextPublic(runId);
            const prUrl = /^\s*pr_url:\s*(\S+)/m.exec(gc)?.[1] || '';
            const author = /^\s*author:\s*(\S+)/m.exec(gc)?.[1] || '';
            if (!prUrl || !author) {
                return res.status(422).json({ success: false, message: '任务数据中缺少 PR URL 或作者' });
            }

            // 获取 PR 元数据
            const { getReviewFixData: getRFD } = await import('../prReview/client.js');
            const data = await getRFD(token, runId);
            const meta = data.prMeta || {};
            if (!meta.owner || !meta.repo || !meta.number) {
                return res.status(422).json({ success: false, message: '缺少 PR 元数据' });
            }

            // 检查本 PR 是否确实未被检视
            if ((data.actionableCount || 0) > 0) {
                return res.status(422).json({ success: false, message: '本 PR 已有 AI 检视意见，无需同步（请用正常检视修复流程）' });
            }

            // 从共享 PR 缓存找同仓、同作者、同主题且仍开放的兄弟 PR。
            // 旧逻辑每次重新遍历所有监听仓，并且未限定 repo，可能串到另一个仓库的同号 PR。
            const sharedPrs = await getPrsCached('*');
            if (sharedPrs.complete === false) {
                return res.status(503).json({ success: false, message: '组织 PR 列表仍在扫描或包含未完成仓库，请稍后重试同步操作' });
            }
            const { prs } = sharedPrs;
            const repoKey = `${meta.owner}/${meta.repo}`.toLowerCase();
            const titleKey = siblingGroupKey(meta.title || '');
            const siblings = prs.filter((p) => (
                String(p.number) !== String(meta.number)
                && String(p.author || '').toLowerCase() === String(author).toLowerCase()
                && String(p.repoFull || '').toLowerCase() === repoKey
                && String(p.state || '').toLowerCase() === 'open'
                && p.labels?.includes('AI已检视')
                && titleKey
                && siblingGroupKey(p.title) === titleKey
            ));

            if (!siblings.length) {
                return res.status(422).json({ success: false, message: '未找到同主题已检视的兄弟 PR，无修复可同步' });
            }

            // 只从确实保存了意见/patch 的 run 取来源，不能只看 AI已检视 标签。
            const sources = siblings.map((sibling) => ({
                sibling,
                source: findSiblingReviewSource(sibling, meta),
            })).filter((item) => item.source && (item.source.actionableCount > 0 || item.source.hasPatch));
            sources.sort((a, b) => (
                Number(Boolean(b.source.actionableCount)) - Number(Boolean(a.source.actionableCount))
                || Number(Boolean(b.source.hasPatch)) - Number(Boolean(a.source.hasPatch))
                || new Date(b.sibling.updatedAt || 0) - new Date(a.sibling.updatedAt || 0)
            ));
            if (!sources.length) {
                return res.status(422).json({
                    success: false,
                    message: `找到同主题已检视 PR（${siblings.map((p) => `#${p.number}`).join('、') || '无'}），但本机没有可用的 AI 意见或修复 patch`,
                });
            }
            const { sibling: sib, source } = sources[0];
            if (source.hasPatch) {
                const prepared = findSiblingReviewSource(sib, meta, { preparePatch: true });
                source.hasPatch = Boolean(prepared?.hasPatch);
                if (!source.hasPatch && source.actionableCount === 0) {
                    return res.status(500).json({ success: false, message: `无法准备 PR #${sib.number} 的修复 patch，请稍后重试` });
                }
            }

            const prInfo = {
                owner: meta.owner, repo: meta.repo, number: meta.number,
                title: meta.title || '', author: meta.author || sib.author,
                headRef: meta.headRef || '', baseRef: meta.baseRef || '',
                headRepo: meta.headRepo || '', state: 'open',
            };

            // 刷新目标 PR head 后再开始动作，避免把旧列表缓存中的 SHA 注入新 run。
            const targetNow = await getGitcodePrDetail(meta.owner, meta.repo, meta.number, 5000);
            if (!targetNow || targetNow.merged || String(targetNow.state || '').toLowerCase() !== 'open') {
                return res.status(422).json({ success: false, message: '目标 PR 已关闭/合入，或暂时无法读取最新状态' });
            }
            prInfo.headSha = targetNow.head?.sha || targetNow.head?.id || '';

            const sourceReview = {
                number: sib.number,
                comments: source.comments.slice(0, 4),
            };
            const instruction = source.hasPatch
                ? { kind: 'apply_patch', sourceRunId: source.runId, sourceReview }
                : {
                    kind: 'feedback',
                    feedback: `参考同主题 PR #${sib.number} 的 AI 检视意见，仅在该意见适用于当前分支时修复。来源文件/行号和意见如下：${source.comments.slice(0, 4).map((c, i) => `\n${i + 1}. ${c.path || 'PR 整体'}${c.line ? `:${c.line}` : ''}：${String(c.body || '').replace(/\s+/g, ' ').slice(0, 420)}`).join('')}`.slice(0, 1900),
                    sourceReview,
                };

            // 成功找到来源、并确认目标 PR 仍开放后，才停止本 PR 上的旧活动 run。
            const globalActive = findActiveRunByPr(meta.number, meta.repo);
            if (globalActive && globalActive.runId !== runId) {
                return res.status(409).json({
                    success: false,
                    message: `目标 PR 已有活动任务 ${globalActive.runId}，请等它结束后再同步兄弟意见`,
                    activeRunId: globalActive.runId,
                });
            }
            if (globalActive) {
                try {
                    await stopPrMonitor(token, globalActive.runId);
                    logger.info('同步前停止活跃 run', { pr: `#${meta.number}`, runId: globalActive.runId });
                } catch (err) {
                    logger.warn('同步前停止活跃 run 失败（继续）', { runId: globalActive.runId, error: err.message });
                }
            }

            const result = await startReviewActionRun(token, prInfo, instruction);
            logger.info('同步兄弟修复', {
                username: user.username, runId, from: `#${sib.number}`, to: `#${meta.number}`,
                sourceRunId: source.runId, sourceOpinionCount: source.actionableCount,
                usedPatch: source.hasPatch, newRunId: result.runId,
            });

            res.json({
                success: true,
                message: source.hasPatch
                    ? `已启动同步任务：从 PR #${sib.number} 的 ${source.actionableCount} 条待处理 AI 意见生成的 patch 同步到 PR #${meta.number}`
                    : `已启动同步任务：将 PR #${sib.number} 的 ${source.actionableCount} 条 AI 检视意见复核并应用到 PR #${meta.number}`,
                siblingNumber: sib.number,
                sourceOpinionCount: source.actionableCount,
                usedPatch: source.hasPatch,
                newRunId: result.runId,
            });
        } catch (err) {
            logger.error('同步兄弟修复失败', { runId: req.params.runId, error: err.message });
            const status = err.message.includes('HTTP 401') ? 401 : 500;
            res.status(status).json({ success: false, message: err.message });
        }
    });

    // ── 14. 管理员统计（仅 admin 角色可见） ──────────────────────────────────

    router.get('/pr-review/admin/stats', async (req, res) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ success: false, message: '未登录' });
        }
        try {
            const user = await getUserByToken(token);
            if (!user) {
                return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
            }
            if (user.role !== 'admin') {
                logger.warn('非管理员访问统计被拒', { username: user.username });
                return res.status(403).json({ success: false, message: '仅管理员可访问' });
            }

            /* ── 用户统计：同机直读 AceHarness users.json（只回安全字段） ── */
            let users = [];
            try {
                users = JSON.parse(readFileSync(join(homedir(), '.aceharness', 'data', 'users.json'), 'utf8'));
            } catch { /* 读失败按空处理 */ }
            // 时间戳归一化（历史数据秒/毫秒混存）
            const toMs = (v) => {
                const n = Number(v) || 0;
                return n > 1e12 ? n : n * 1000;
            };
            const now = Date.now();
            const dayMs = 86400000;

            /* ── GitCode 身份绑定（用户令牌 env + 邮箱映射，一个平台用户可绑多个） ── */
            const identities = listAllGitcodeIdentities();
            const gcByUser = new Map();   // 平台用户名(lower) -> Set(gitcodeUsername)
            const gcByEmail = new Map();  // 邮箱(lower) -> Set(gitcodeUsername)
            for (const id of identities) {
                if (id.username && id.username !== '（未注册）') {
                    const k = String(id.username).toLowerCase();
                    if (!gcByUser.has(k)) gcByUser.set(k, new Set());
                    gcByUser.get(k).add(id.gitcodeUsername);
                }
                if (id.email) {
                    const k = String(id.email).toLowerCase();
                    if (!gcByEmail.has(k)) gcByEmail.set(k, new Set());
                    gcByEmail.get(k).add(id.gitcodeUsername);
                }
            }
            const gitcodeOf = (u) => {
                const s = new Set([
                    ...(gcByUser.get(String(u.username || '').toLowerCase()) || []),
                    ...(gcByEmail.get(String(u.email || '').toLowerCase()) || []),
                ]);
                return s.size ? [...s].join(', ') : null;
            };

            const userRows = users.map(u => ({
                username: u.username,
                email: u.email,
                role: u.role,
                status: u.status,
                gitcodeUsername: gitcodeOf(u),
                createdAt: u.createdAt ? new Date(toMs(u.createdAt)).toISOString() : null,
                lastLoginAt: u.lastLoginAt ? new Date(toMs(u.lastLoginAt)).toISOString() : null,
            })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

            const activeWithin = (days) => userRows.filter(u => u.lastLoginAt && now - new Date(u.lastLoginAt).getTime() <= days * dayMs).length;
            const userStats = {
                total: userRows.length,
                admins: userRows.filter(u => u.role === 'admin').length,
                pending: userRows.filter(u => u.status === 'pending').length,
                active1d: activeWithin(1),
                active7d: activeWithin(7),
                active30d: activeWithin(30),
                new7d: userRows.filter(u => u.createdAt && now - new Date(u.createdAt).getTime() <= 7 * dayMs).length,
                neverLogin: userRows.filter(u => !u.lastLoginAt).length,
            };

            /* ── 监控统计：扫 runs 目录（collectNotifyEvents 同模式；含 PR 监控 + Issue 诊断） ── */
            const TERMINAL_RUN = new Set(['completed', 'failed', 'crashed', 'stopped']);
            const ISSUE_CONFIG_RE = /^cpf-ohos-diagnosis(?:-iterate)?\.yaml$/;
            const runsDir = join(homedir(), '.aceharness', 'runs');
            const runRows = [];
            try {
                for (const name of readdirSync(runsDir)) {
                    if (!name.startsWith('run-')) continue;
                    let s;
                    try {
                        s = JSON.parse(readFileSync(join(runsDir, name, 'summary.json'), 'utf8'));
                    } catch { continue; }
                    const isIssue = ISSUE_CONFIG_RE.test(s.configFile || '');
                    if (!isIssue && s.configFile !== 'gitcode-pr-review.yaml') continue;
                    const prNumber = (name.match(/-pr(\d+)(?:-|$)/) || [])[1] || null;
                    // Issue 信息：run 目录名不含 issue 号，从 state.yaml 运行时 globalContext 提取
                    const issueInfo = isIssue ? runIssueInfoOf(s.runId || name) : null;
                    // 启动方式：PR 取 event（manual/note/merge_request）；Issue 一律平台提交（manual），
                    // iterate 型（用户反馈触发的重跑）标记为 feedback
                    runRows.push({
                        type: isIssue ? 'issue' : 'pr',
                        runId: s.runId || name,
                        prNumber: prNumber ? Number(prNumber) : null,
                        issueNumber: issueInfo ? issueInfo.number : null,
                        repo: isIssue
                            ? (issueInfo?.repo || '')
                            : (prNumber ? runRepoOf(s.runId || name) : ''),
                        status: s.status,
                        ownerName: s.ownerName || '',
                        startMode: isIssue
                            ? (issueInfo?.iterate ? 'feedback' : 'manual')
                            : (prNumber ? runStartInfoOf(s.runId || name).mode : ''),
                        startTime: s.startTime,
                        endTime: s.endTime || null,
                    });
                }
            } catch { /* 目录不存在按空处理 */ }

            const byStatus = {};
            for (const r of runRows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
            const byUser = {};
            for (const r of runRows) {
                const k = r.ownerName || '(未知)';
                byUser[k] = byUser[k] || { total: 0, active: 0, prs: new Set(), issues: new Set() };
                byUser[k].total++;
                if (!TERMINAL_RUN.has(r.status)) byUser[k].active++;
                if (r.prNumber) byUser[k].prs.add(`${r.repo || '?'}/${r.prNumber}`);
                if (r.type === 'issue' && r.issueNumber) byUser[k].issues.add(`${r.repo || '?'}/${r.issueNumber}`);
            }
            const runStats = {
                totalRuns: runRows.length,
                activeRuns: runRows.filter(r => !TERMINAL_RUN.has(r.status)).length,
                // 监控的 PR：活跃监控中的 + 历史监控过（按 PR 号去重）
                activePrs: new Set(runRows.filter(r => r.type === 'pr' && !TERMINAL_RUN.has(r.status) && r.prNumber).map(r => `${r.repo || '?'}/${r.prNumber}`)).size,
                totalPrs: new Set(runRows.filter(r => r.type === 'pr' && r.prNumber).map(r => `${r.repo || '?'}/${r.prNumber}`)).size,
                totalPrRuns: runRows.filter(r => r.type === 'pr').length,
                activePrRuns: runRows.filter(r => r.type === 'pr' && !TERMINAL_RUN.has(r.status)).length,
                // Issue 分析：累计 run 数与进行中的 run 数
                totalIssueRuns: runRows.filter(r => r.type === 'issue').length,
                activeIssueRuns: runRows.filter(r => r.type === 'issue' && !TERMINAL_RUN.has(r.status)).length,
                byStatus,
                byUser: Object.entries(byUser)
                    .map(([user, v]) => ({ user, gitcode: [...(gcByUser.get(user.toLowerCase()) || [])].join(', ') || null, total: v.total, active: v.active, prs: v.prs.size, issues: v.issues.size }))
                    .sort((a, b) => b.total - a.total),
                recent: runRows
                    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
                    .slice(0, 30)
                    .map(r => ({
                        type: r.type,
                        runId: r.runId,
                        pr: r.prNumber,
                        issue: r.issueNumber,
                        repo: r.repo,
                        status: r.status,
                        owner: r.ownerName,
                        ownerIsAdmin: userRows.some(u => u.username === r.ownerName && u.role === 'admin'),
                        startMode: r.startMode,
                        startTime: r.startTime,
                    })),
            };

            logger.info('管理员查询统计', { username: user.username, users: userStats.total, runs: runStats.totalRuns });
            res.json({
                success: true,
                generatedAt: new Date().toISOString(),
                userStats,
                users: userRows,
                runStats,
            });
        } catch (err) {
            logger.error('管理员统计查询失败', { error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    return router;
}
