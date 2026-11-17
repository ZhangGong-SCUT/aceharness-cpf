/**
 * AceHarness PR 监控客户端 — 代理层
 *
 * PR 监控工作流（gitcode-pr-review.yaml）可由用户在 AceHarness 侧或本系统页面启动，
 * 读取/控制均使用用户自己的 AceHarness token：
 *  1. POST /api/auth/login          — 用户登录（返回 token + 用户信息）
 *  2. GET  /api/auth/me             — 校验 token / 获取当前用户
 *  3. GET  /api/run-history         — 运行历史（AceHarness 侧自动隔离：非管理员只见自己的 run）
 *  4. GET  /api/workflow/status     — 单个 run 的实时状态（阶段/步骤/最终评审）
 *  5. GET  /api/runs/{id}/outputs   — 输出文件列表 / 内容读取
 *  6. POST /api/workflow/start      — 人工开启 PR 监控（globalContext 与 webhook 一致）
 *  7. POST /api/workflow/stop       — 人工关闭 PR 监控
 *  8. GitCode API                   — 拉取用户在监听仓库的全部 PR（总览）
 *
 * 隔离机制：AceHarness /api/run-history 对非管理员用户自动过滤
 * `run.ownerId === auth.id`，天然实现"只看自己的 PR"。
 */

import { aceDataDir, aceRunsDir, aceRuntimeRoot, isActiveAdmin } from '../library/aceRuntime.js';
import { resolveLocalAdminSession, readLocalAdminUserByToken } from '../library/localSession.js';
import { isIsolatedRunDir, readWorkingDirectory } from '../library/runPath.js';
import { httpRequest, ACEHARNESS_API_BASE_URL } from '../issueAnalysis/aceHarnessClient.js';
import config from '../library/config.js';
import { createLogger } from '../library/logger.js';
import { readHumanApproval } from './approvalState.js';
import { createRecentQueryCache } from './recentQueryCache.js';
import { listLocalPrRuns, findLocalPrRun } from './localRunSummaries.js';
import { createSessionValidationCache } from './sessionValidation.js';
import { readExecutionEvidence } from './executionEvidence.js';
import { reviewArtifactMatchesPr } from './review-match.js';
import { readPushedPatch } from './pushedPatch.js';
import { probeGitcodeCapabilities, saveCapabilities, clearCapabilitiesForLogin } from './capabilities.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { homedir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);
const logger = createLogger('PrReviewClient');

/** PR 监控工作流配置文件 */
export const PR_REVIEW_CONFIG_FILE = config.aceharness.prReviewConfigFile;

/**
 * 用户登录 AceHarness
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{token: string, user: object}>}
 */
export async function loginUser(email, password) {
    if (!email || !password) {
        throw new Error('邮箱和密码不能为空');
    }
    const result = await httpRequest('POST', '/api/auth/login', { email, password }, {
        baseUrl: ACEHARNESS_API_BASE_URL,
        timeoutMs: 10000,
    });
    if (result.status !== 200 || !result.data?.token) {
        throw new Error(result.data?.error || `登录失败（HTTP ${result.status}）`);
    }
    return { token: result.data.token, user: result.data.user };
}

/**
 * 本地个人部署直接进入本机管理员会话，不再走登录页。
 * 只复用 AceHarness 已签发、仍在有效期内的管理员 token。
 */
export async function openLocalSession() {
    const { token, user } = await resolveLocalAdminSession(getUserByToken);
    return { token, user };
}

/**
 * 从 AceHarness 数据目录读取一个有效的 admin 服务 token（同机部署）。
 * 用于注册直通（免审核创建普通用户），避免在 .env 明文存管理员密码。
 * token 7 天有效，admin 正常登录会自动产生新 token；读不到时返回 null（降级注册）。
 */
function _readAdminTokenFromDisk() {
    try {
        const dataDir = aceDataDir();
        const users = JSON.parse(readFileSync(join(dataDir, 'users.json'), 'utf8'));
        const adminIds = new Set(
            users.filter(isActiveAdmin).map(u => u.id)
        );
        const tokens = JSON.parse(readFileSync(join(dataDir, 'tokens.json'), 'utf8'));
        const now = Date.now();
        for (const [token, info] of tokens) {
            if (info?.userId && adminIds.has(info.userId) && info.expiry > now) {
                return token;
            }
        }
    } catch (err) {
        logger.warn('读取 admin 服务 token 失败（注册将降级为需审核）', { error: err.message });
    }
    return null;
}

/**
 * 用户注册（AIWeb 专用：免审核直通）
 *
 * 优先策略：用 AceHarness admin 服务 token 调 POST /api/users 直接创建
 *           active 状态的普通用户（role 固定为 user，无管理员权限）。
 * 备选策略：.env 配置 ACEHARNESS_ADMIN_EMAIL/PASSWORD 时用密码登录直通。
 * 降级策略：以上都不可用时，回退普通注册（pending，需 AceHarness 管理员审核）。
 *
 * @param {object} opts - { username, email, password, question, answer }
 * @returns {Promise<{user: object, activated: boolean, message: string, degradedReason?: string}>}
 */
export async function registerUser(opts) {
    const { username, email, password, question, answer } = opts;
    if (!username || !email || !password || !question || !answer) {
        throw new Error('所有字段都不能为空');
    }
    if (password.length < 6) {
        throw new Error('密码至少 6 个字符');
    }

    const _fallbackPending = async (reason) => {
        const result = await _registerPendingUser({ username, email, password, question, answer });
        return { ...result, activated: false, degradedReason: reason };
    };

    // ── 策略一：admin 服务 token 直通（免审核，创建普通用户） ──
    const adminTokenFromDisk = _readAdminTokenFromDisk();
    if (adminTokenFromDisk) {
        try {
            const user = await _createActiveUser(adminTokenFromDisk, { username, email, password, question, answer });
            return {
                user,
                activated: true,
                message: '注册成功，无需审核，可直接登录',
            };
        } catch (err) {
            const msg = err.message || '';
            const isCredentialIssue = msg.includes('管理员凭证无效') || msg.includes('不是管理员') || msg.includes('403') || msg.includes('401');
            if (!isCredentialIssue) throw err;   // 参数类错误（如邮箱已存在）直接抛给用户
            logger.warn('admin 服务 token 直通注册失败，尝试 .env 凭证', { error: msg });
        }
    }

    // ── 策略二：.env 管理员凭证直通（可选配置） ──
    const adminEmail = config.aceharness.adminEmail || config.aceharness.email;
    const adminPassword = config.aceharness.adminPassword || config.aceharness.password;
    const isPlaceholderCred = !adminEmail || !adminPassword
        || adminEmail.includes('example.com') || adminEmail === 'your_email@example.com';
    if (!isPlaceholderCred) {
        try {
            const adminToken = await _getAdminToken(adminEmail, adminPassword);
            const user = await _createActiveUser(adminToken, { username, email, password, question, answer });
            return {
                user,
                activated: true,
                message: '注册成功，无需审核，可直接登录',
            };
        } catch (err) {
            const msg = err.message || '';
            const isCredentialIssue = msg.includes('未配置') || msg.includes('登录失败')
                || msg.includes('不是管理员') || msg.includes('403') || msg.includes('401');
            if (!isCredentialIssue) {
                throw err;
            }
            logger.warn('管理员直通注册失败，降级为普通注册', { error: msg });
        }
    }

    // ── 策略三（降级）：普通注册，需 AceHarness 管理员审核 ──
    return _fallbackPending(adminTokenFromDisk || !isPlaceholderCred
        ? '管理员凭证暂不可用，本次注册需审核'
        : 'AIWeb 未配置管理员凭证（ACEHARNESS_ADMIN_EMAIL / ACEHARNESS_ADMIN_PASSWORD）');
}

/**
 * 管理员登录获取 token（校验 admin 角色）
 * @returns {Promise<string>}
 */
async function _getAdminToken(email, password) {
    let token;
    try {
        ({ token } = await loginUser(email, password));
    } catch (err) {
        // 统一包装为"管理员登录失败"，确保上层能据此降级而非误报给注册用户
        throw new Error(`管理员登录失败（401）：${err.message}`);
    }
    const user = await getUserByToken(token);
    if (!user || user.role !== 'admin') {
        throw new Error(`配置的账号 ${email} 不是 AceHarness 管理员（403）`);
    }
    return token;
}

/**
 * 管理员直接创建 active 用户（免审核）
 * AceHarness 侧该用户的 createdBy/approvedBy 均记录为该管理员
 * @returns {Promise<object>} 创建的用户
 */
async function _createActiveUser(adminToken, opts) {
    const result = await httpRequest('POST', '/api/users', {
        username: opts.username,
        email: opts.email,
        password: opts.password,
        question: opts.question,
        answer: opts.answer,
        role: 'user',
    }, { token: adminToken });

    if (result.status === 401 || result.status === 403) {
        throw new Error(`管理员凭证无效（HTTP ${result.status}）`);
    }
    if (result.status !== 200) {
        throw new Error(result.data?.error || `创建用户失败（HTTP ${result.status}）`);
    }
    return result.data.user;
}

/**
 * 普通注册（pending，需 AceHarness 管理员审核）
 * @returns {Promise<{user: object, message: string}>}
 */
async function _registerPendingUser(opts) {
    const result = await httpRequest('POST', '/api/auth/register', {
        username: opts.username,
        email: opts.email,
        password: opts.password,
        question: opts.question,
        answer: opts.answer,
    }, {
        baseUrl: ACEHARNESS_API_BASE_URL,
        timeoutMs: 10000,
    });

    if (result.status !== 200) {
        throw new Error(result.data?.error || `注册失败（HTTP ${result.status}）`);
    }
    return { user: result.data.user, message: result.data.message || '注册申请已提交，请等待管理员审核' };
}

/**
 * 校验 token 并返回当前用户信息
 * @param {string} token
 * @returns {Promise<object|null>} 用户信息，token 无效时返回 null
 */
const validateSession = createSessionValidationCache();

/**
 * 校验 token 并返回当前用户信息。
 * 短期缓存的是上游确认结果；每次仍先校验凭证，再做任务归属检查。
 */
export async function getUserByToken(token) {
    const localUser = readLocalAdminUserByToken(token);
    if (localUser) return localUser;
    return validateSession(token, async value => {
        const result = await httpRequest('GET', '/api/auth/me', null, { token: value, timeoutMs: 10000 });
        if (result.status !== 200) return null;
        return result.data?.user || null;
    });
}

/**
 * 从 runId 提取 PR 编号
 * runId 形如 run-1788509505648-pr1914-91ef7d2b → 1914
 * @param {string} runId
 * @returns {string|null}
 */
function humanApprovalFields(runId) {
    const approval = readHumanApproval(runId);
    if (!approval) return {};
    return {
        approvalAsk: approval.ask,
        approvalNext: approval.suggestedNextState,
        approvalKind: approval.kind,
    };
}

export function extractPrNumber(runId) {
    const m = /pr(\d+)/i.exec(runId || '');
    return m ? m[1] : null;
}

/**
 * 列出当前用户的 PR 监控 run
 *
 * 调用 AceHarness /api/run-history（keyword 过滤到 PR 监控工作流），
 * AceHarness 侧对非管理员用户自动只返回其本人的 run。
 *
 * @param {string} token - 用户 AceHarness token
 * @param {number} [page=1]
 * @param {number} [pageSize=50]
 * @returns {Promise<{runs: array, total: number, page: number, totalPages: number}>}
 */
export async function listPrReviewRuns(token, page = 1, pageSize = 50) {
    // 本机摘要已包含状态、进度和归属，无需让 ACE 为每次浏览扫描全部 state.yaml。
    // 本地归档不可用时回退 ACE API；两种路径都先校验会话，绝不绕过所有权过滤。
    if (aceRunsDir()) {
        try {
            return await localPrReviewRuns(token, page, pageSize);
        } catch (error) {
            logger.warn('本机 PR 摘要不可用，回退 ACE 运行历史', { error: error.message });
        }
    }
    return remotePrReviewRuns(token, page, pageSize);
}

async function localPrReviewRuns(token, page, pageSize) {
    const user = await getUserByToken(token);
    if (!user) throw new Error('查询运行历史失败（HTTP 401）：登录已过期');
    const result = await listLocalPrRuns({
        user, runsRoot: aceRunsDir(), configFile: PR_REVIEW_CONFIG_FILE, page, pageSize,
        enrich: summary => prReviewRunSummary(summary),
    });
    return result || remotePrReviewRuns(token, page, pageSize);
}

function prReviewRunSummary(r) {
    const id = r.runId || r.id;
    return {
        runId: id,
        prNumber: extractPrNumber(id),
        repo: runRepoOf(id),
        prTitle: runTitleOf(id),
        configName: r.configName,
        status: r.status,
        currentPhase: r.currentPhase,
        totalSteps: r.totalSteps,
        completedSteps: r.completedSteps,
        failedSteps: r.failedSteps,
        startTime: r.startTime,
        endTime: r.endTime,
        ownerName: r.ownerName,
        totalTokens: r.totalTokens,
        cost: r.cost,
        tokenUsageSource: r.tokenUsageSource || (r.totalTokens > 0 ? 'reported' : 'unavailable'),
        costSource: r.costSource || (r.cost > 0 ? 'reported' : 'unavailable'),
        ...runGateOutcomeOf(id),
        ...(r.currentPhase === '__human_approval__' ? humanApprovalFields(id) : {}),
    };
}

export async function remotePrReviewRuns(token, page = 1, pageSize = 50) {
    const path = `/api/run-history?page=${page}&pageSize=${Math.min(pageSize, 100)}&keyword=${encodeURIComponent('gitcode-pr-review')}`;
    const result = await httpRequest('GET', path, null, { token });
    if (result.status !== 200) {
        throw new Error(`查询运行历史失败（HTTP ${result.status}）：${JSON.stringify(result.data).slice(0, 200)}`);
    }

    // keyword 是子串匹配，再按精确 configFile 过滤一次
    const all = (result.data?.runs || []).filter(r => r.configFile === PR_REVIEW_CONFIG_FILE);
    let runs = all.map(r => ({
        runId: r.id,
        prNumber: extractPrNumber(r.id),
        // 跨仓 PR 编号重叠：附上 run 归属仓库（同机读 state.yaml，模块级缓存）
        repo: extractPrNumber(r.id) ? runRepoOf(r.id) : '',
        // PR 标题（同机读 state.yaml globalContext，模块级缓存）
        prTitle: extractPrNumber(r.id) ? runTitleOf(r.id) : '',
        configName: r.configName,
        status: r.status,
        currentPhase: r.currentPhase,
        totalSteps: r.totalSteps,
        completedSteps: r.completedSteps,
        failedSteps: r.failedSteps,
        startTime: r.startTime,
        endTime: r.endTime,
        ownerName: r.ownerName,
        totalTokens: r.totalTokens,
        cost: r.cost,
        // R5：透传用量来源，页面据此区分 reported/partial/unavailable，不再把"未采集"隐藏成 0。
        tokenUsageSource: r.tokenUsageSource || (r.totalTokens > 0 ? 'reported' : 'unavailable'),
        costSource: r.costSource || (r.cost > 0 ? 'reported' : 'unavailable'),
        // R1：门禁终态归因——页面不得仅凭 status==='completed' 就宣称"门禁全绿"。
        ...(extractPrNumber(r.id) ? runGateOutcomeOf(r.id) : {}),
        ...(r.currentPhase === '__human_approval__' ? humanApprovalFields(r.id) : {}),
    }));

    // 一个 PR 只显示一个任务：按「仓库+编号」去重（跨仓编号重叠，仅编号会误伤），保留最新的
    const byPr = new Map();
    const kept = [];
    for (const r of runs) {
        if (!r.prNumber) { kept.push(r); continue; }   // 无 PR 号的 run 原样保留
        const dedupeKey = `${r.repo || '?'}/${r.prNumber}`;
        const prev = byPr.get(dedupeKey);
        if (!prev || new Date(r.startTime) > new Date(prev.startTime)) {
            if (prev) kept.splice(kept.indexOf(prev), 1);
            byPr.set(dedupeKey, r);
            kept.push(r);
        }
    }
    runs = kept.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

    return {
        runs,
        total: result.data?.pagination?.total ?? runs.length,
        page,
        totalPages: result.data?.pagination?.totalPages ?? 1,
    };
}

/** 查询并验证单个 run 的归属，避免为一次详情请求下载最近 100 条运行记录。 */
export async function findOwnedPrReviewRun(token, runId) {
    const user = await getUserByToken(token);
    if (!user) return null;
    const local = await findLocalPrRun({
        user, runsRoot: aceRunsDir(), configFile: PR_REVIEW_CONFIG_FILE, runId,
    });
    if (local !== undefined) return local;
    const path = `/api/run-history?page=1&pageSize=1&runId=${encodeURIComponent(runId)}`;
    const result = await httpRequest('GET', path, null, { token, timeoutMs: 12000 });
    if (result.status !== 200) {
        throw new Error(`查询运行归属失败（HTTP ${result.status}）：${JSON.stringify(result.data).slice(0, 200)}`);
    }
    const run = (result.data?.runs || []).find((item) => item.id === runId && item.configFile === PR_REVIEW_CONFIG_FILE);
    if (run) return { runId: run.id, status: run.status, currentPhase: run.currentPhase };
    if (result.data?.filters?.runId === runId) return null;
    // 兼容 ACEHarness 尚未部署 runId 过滤参数的实例。
    const fallback = await listPrReviewRuns(token, 1, 100);
    const legacyRun = fallback.runs.find((item) => item.runId === runId);
    return legacyRun ? { runId: legacyRun.runId, status: legacyRun.status, currentPhase: legacyRun.currentPhase } : null;
}

/**
 * 查询单个 run 的完整实时状态（阶段/步骤日志/最终评审）
 * @param {string} token
 * @param {string} runId
 * @returns {Promise<object>}
 */
export async function getRunStatus(token, runId, options = {}) {
    // PR 卡片只展示运行进度。compact=1 跳过 spec、记忆和历史评审聚合，
    // 这些数据不参与时间线渲染，却会让普通状态请求走完整详情慢路径。
    const path = `/api/workflow/status?runId=${encodeURIComponent(runId)}&configFile=${encodeURIComponent(PR_REVIEW_CONFIG_FILE)}&compact=1`;
    const result = await httpRequest('GET', path, null, { token, timeoutMs: options.timeoutMs || 15000 });
    if (result.status !== 200) {
        throw new Error(`查询状态失败（HTTP ${result.status}）：${JSON.stringify(result.data).slice(0, 200)}`);
    }
    return result.data;
}

/**
 * 列出 run 的所有输出文件
 * @param {string} token
 * @param {string} runId
 * @returns {Promise<{files: array}>}
 */
export async function listRunOutputs(token, runId) {
    const result = await httpRequest('GET', `/api/runs/${encodeURIComponent(runId)}/outputs`, null, { token });
    if (result.status !== 200) {
        throw new Error(`列出输出文件失败（HTTP ${result.status}）：${JSON.stringify(result.data).slice(0, 200)}`);
    }
    return result.data;
}

/**
 * 按 outputRef 读取输出文件内容
 * @param {string} token
 * @param {string} runId
 * @param {string} outputRef
 * @returns {Promise<{stepName: string, content: string}>}
 */
export async function readRunOutput(token, runId, outputRef, options = {}) {
    const result = await httpRequest(
        'GET',
        `/api/runs/${encodeURIComponent(runId)}/outputs?outputRef=${encodeURIComponent(outputRef)}`,
        null,
        { token, timeoutMs: options.timeoutMs || undefined }
    );
    if (result.status !== 200) {
        throw new Error(`读取输出失败（HTTP ${result.status}）：${JSON.stringify(result.data).slice(0, 200)}`);
    }
    return result.data;
}

/* ════════════════════════════════════════════════════════════════════════
 *  AI 检视修复：数据聚合 + 用户指令启动
 * ════════════════════════════════════════════════════════════════════════ */

/** 读取输出文件，失败/不存在返回 null（不抛错） */
async function _readOutputSafe(token, runId, outputRef) {
    try {
        const data = await readRunOutput(token, runId, outputRef, { timeoutMs: 8000 });
        return data?.content ?? null;
    } catch {
        return null;
    }
}

/** 从 run 的 state.yaml 读取 globalContext 段（同机部署直读，格式稳定；
 *  YAML 块样式可能是 >-（折叠）或 |-（字面），两种都匹配） */
function _readRunGlobalContext(runId) {
    try {
        const yaml = readFileSync(join(aceRunsDir(), runId, 'state.yaml'), 'utf8');
        const m = /^globalContext:\s*[|>][+-]?\n([\s\S]*?)(?=\n[^\s]|(?![\s\S]))/m.exec(yaml);
        return m ? m[1] : '';
    } catch {
        return '';
    }
}

/** 从 run 的 state.yaml 读取 workingDirectory（隔离工作目录——personalDir 用户的产物实际落点）。
 *  outputs API 只读记录目录（~/.aceharness/runs/<id>/outputs），隔离 run 的
 *  fix.patch / ai-review-comments.json 等工件在工作目录 outputs/ 下，需同机直读兜底。 */
function _readRunWorkingDirectory(runId) {
    try {
        const yaml = readFileSync(join(aceRunsDir(), runId, 'state.yaml'), 'utf8');
        return readWorkingDirectory(yaml);
    } catch {
        return '';
    }
}

/** 同机部署时先读 run 归档和隔离工作目录，避免为小型 JSON/patch 反复走 HTTP。 */
function _readRunArtifactLocal(runId, name, workDir = '') {
    const candidates = [
        join(aceRunsDir(), runId, 'outputs', name),
        // 共享模板工作区可能已有其他 PR 的产物，仅隔离目录可以回退读取。
        isIsolatedRunDir(workDir, runId) ? join(workDir, 'outputs', name) : '',
    ].filter(Boolean);
    for (const path of candidates) {
        try { return readFileSync(path, 'utf8'); } catch { /* 尝试下一个本地位置 */ }
    }
    return null;
}

async function _readRunArtifact(token, runId, name, workDir) {
    const local = _readRunArtifactLocal(runId, name, workDir);
    if (local !== null) return local;
    // 同机归档可读时，缺失是正常业务状态，不再为每个缺失工件排队请求 HTTP。
    if (existsSync(join(aceRunsDir(), runId, 'state.yaml'))) return null;
    return _readOutputSafe(token, runId, `outputs/${name}`);
}

/**
 * R1：由 gate-check 快照推导门禁终态（纯函数，便于单测）。区分已关闭/已合入/门禁通过/阻塞/未知。
 */
export function deriveGateOutcome(gate) {
    const g = gate || {};
    const prState = g.merged ? 'merged' : g.closed ? 'closed' : 'open';
    const phase = String(g.phase || '');
    const gateOutcome = prState === 'merged' ? 'merged'
        : prState === 'closed' ? 'closed'
        : phase === 'tester_approved' ? 'tester_approved'
        : phase === 'green' ? 'green'
        : phase === 'blocked_rate_limit' || phase === 'blocked_no_issue' ? 'blocked'
        : ['static_failed', 'compile_failed', 'test_failed', 'dco_failed'].includes(phase) ? 'failed'
        : ['running', 'need_start_build'].includes(phase) ? 'running'
        : 'unknown';
    return {
        prState,
        gateOutcome,
        gateSummary: String(g.summary || ''),
        gateHeadSha: String(g.head_sha || ''),
    };
}

/**
 * R1：从 run 归档的 gate-check.json 读取门禁终态。
 * 页面此前仅按 status==='completed' 插入"门禁全绿"，会把"关闭终止、未完成验证"误显示成全绿。
 * 不做模块级缓存：gate-check 会随运行变化，列表每次都读小文件（PR run 数量很少）。
 */
export function runGateOutcomeOf(runId, runsRoot = join(aceRunsDir())) {
    let outcome = { prState: '', gateOutcome: '', gateSummary: '', gateHeadSha: '' };
    try {
        const gate = JSON.parse(readFileSync(join(runsRoot, runId, 'outputs', 'gate-check.json'), 'utf8'));
        outcome = deriveGateOutcome(gate);
    } catch { /* 缺失门禁证据不能默认全绿。 */ }
    let artifactStatus = 'unknown';
    try {
        const manifest = JSON.parse(readFileSync(join(runsRoot, runId, 'outputs', 'pr-archive-manifest.json'), 'utf8'));
        if (['complete', 'partial', 'failed'].includes(manifest.artifact_status)) artifactStatus = manifest.artifact_status;
        // Also support old manifests, without treating an empty inventory as complete.
        else if (manifest.entries?.some(e => e.status === 'failed')) artifactStatus = 'failed';
        else if (manifest.entries?.some(e => e.status === 'missing')) artifactStatus = 'partial';
        else if (manifest.entries?.length && manifest.entries.every(e => ['archived', 'already_present'].includes(e.status))) artifactStatus = 'complete';
    } catch { /* 老运行或尚未收口的运行没有 manifest。 */ }
    return { ...outcome, artifactStatus };
}

/**
 * 门禁根因/维护提醒的结构化诊断（供"普通详情"直接展示，不必打开"检视修复"面板）。
 * 归档优先、隔离工作目录兜底，与其它工件读取口径一致；读不到就返回 null，不臆造。
 */
export function runGateDiagnosisOf(runId, runsRoot = join(aceRunsDir())) {
    const workDir = _readRunWorkingDirectory(runId);
    const candidates = [
        join(runsRoot, runId, 'outputs', 'gate-check.json'),
        isIsolatedRunDir(workDir, runId) ? join(workDir, 'outputs', 'gate-check.json') : '',
    ].filter(Boolean);
    let raw = null;
    for (const path of candidates) {
        try { raw = JSON.parse(readFileSync(path, 'utf8')); break; } catch { /* 尝试下一个本地位置 */ }
    }
    if (!raw) return null;
    const verdict = String(raw.log_verdict || '');
    const needsMaintainer = raw.needs_maintainer === true;
    return {
        phase: String(raw.phase || ''),
        summary: String(raw.summary || ''),
        reportUrl: String(raw.report_url || ''),
        failures: [['dco_fail', 'DCO'], ['static_fail', '静态检查'], ['compile_fail', '编译'], ['test_fail', '测试']]
            .filter(([key]) => raw[key] === true).map(([, label]) => label),
        logVerdict: verdict,
        rootCauseVerified: raw.root_cause_verified === true,
        logReasons: Array.isArray(raw.log_reasons) ? raw.log_reasons.map(String).slice(0, 3) : [],
        logEvidence: Array.isArray(raw.log_evidence) ? raw.log_evidence.map(String).slice(0, 3) : [],
        retryBudgetExhausted: raw.retry_budget_exhausted === true,
        needsMaintainer,
        // 后端已判断是否"已核实属门禁/平台侧"；前端据此决定措辞，避免未核实也排除 PR 代码。
        logPlatformVerified: raw.log_platform_verified === true,
        maintainerHint: String(raw.maintainer_hint || ''),
    };
}

/* ── PR 标题缓存（任务卡片显示；与 runRepoOf 同模式，从 state.yaml 提取） ── */
const _runTitleCache = new Map();

/* ── 启动方式缓存（admin 统计用：manual=UI 手动 / 其他=webhook 自动；starter=manual-start-by） ── */
const _runStartInfoCache = new Map();

export function runStartInfoOf(runId) {
    const id = String(runId || '').trim();
    if (!id) return { mode: '', starter: '' };
    if (_runStartInfoCache.has(id)) return _runStartInfoCache.get(id);
    let info = { mode: '', starter: '' };
    try {
        const gc = _readRunGlobalContext(id);
        const ev = /^\s*event:\s*(\S+)/m.exec(gc);
        const msb = /^\s*manual-start-by:\s*(\S+)/m.exec(gc);
        info = {
            mode: ev ? ev[1] : '',
            starter: msb ? msb[1] : '',
        };
    } catch { /* 读失败返回空 */ }
    _runStartInfoCache.set(id, info);
    return info;
}

/* ── Issue 诊断 run 信息缓存（admin 统计用）──
 * Issue run 的运行时输入位于 state.yaml 的【第二个】globalContext 块（首块为工作流静态描述，
 * 与 PR run 首块即运行时输入不同）。块样式不固定：| / >- 块或多行，也可能是单行引号流式标量
 * （如 globalContext: "issue-url: ..."），故不锚定行首、全文匹配 issue-* 键，并剥除尾部引号。
 * 这些键仅存在于运行时上下文，静态描述与 PR run 上下文中不会出现 */
const _runIssueInfoCache = new Map();

export function runIssueInfoOf(runId) {
    const id = String(runId || '').trim();
    if (!id) return { number: null, repo: '', url: '', iterate: false };
    if (_runIssueInfoCache.has(id)) return _runIssueInfoCache.get(id);
    let info = { number: null, repo: '', url: '', iterate: false };
    try {
        const yaml = readFileSync(join(aceRunsDir(), id, 'state.yaml'), 'utf8');
        const clean = (v) => String(v || '').replace(/["',]+$/, '');
        const url = clean((/\bissue-url:\s*(\S+)/.exec(yaml) || [])[1] || '');
        let number = (/\bissue-number:\s*(\d+)/.exec(yaml) || [])[1] || null;
        if (!number && url) number = (url.match(/\/issues\/(\d+)/) || [])[1] || null;
        let repo = clean((/\bissue-repo:\s*(\S+)/.exec(yaml) || [])[1] || '');
        if (!repo && url) repo = (url.match(/\/([^\/]+)\/(?:issues|pull)\/\d+/) || [])[1] || '';
        info = {
            number: number ? Number(number) : null,
            repo,
            url,
            iterate: /\biterate-mode:\s*true\b/.test(yaml),
        };
    } catch { /* 读失败返回空 */ }
    _runIssueInfoCache.set(id, info);
    return info;
}

export function runTitleOf(runId) {
    const id = String(runId || '').trim();
    if (!id) return '';
    if (_runTitleCache.has(id)) return _runTitleCache.get(id);
    let title = '';
    try {
        const gc = _readRunGlobalContext(id);
        const m = /^\s*title:\s*(.+)$/m.exec(gc);
        title = m ? m[1].trim() : '';
    } catch { /* 读失败返回空 */ }
    _runTitleCache.set(id, title);
    return title;
}

export function siblingGroupKey(title) {
    return String(title || '')
        .replace(/^[【\[]\d+\.?\d*(?:\.\d+)?[】\]]\s*/i, '')
        .replace(/^[（(]\d+\.?\d*(?:\.\d+)?[）)]\s*/i, '')
        .trim()
        .toLowerCase();
}

/**
 * 分支名归一化：去掉末尾的版本段 / 预发布后缀，得到"同一条特性分支"的 slug。
 * 例：fix/platformchannel-reply-3.44.9 → fix/platformchannel-reply
 *      fix/ohos-preferred-locales-3.44  → fix/ohos-preferred-locales
 *      fix/341-switch-ime               → fix/341-switch-ime（末尾不是版本，保持不变）
 * 同一问题在不同版本分支上通常用同一分支名（仅版本后缀不同），比标题更稳定。
 */
export function branchSlug(headRef) {
    return String(headRef || '')
        .trim()
        .toLowerCase()
        .replace(/[-_](?:dev|beta|alpha|rc|release)\d*$/, '')
        .replace(/[-_.]?v?\d+(?:[._-]\d+)*$/, '')
        .replace(/^[-_./]+|[-_./]+$/g, '');
}

/**
 * 按同主题/同分支分组 PR（同一作者下，分支 slug 相同或标题去版本前缀后相同 = 同一问题）。
 *
 * 旧实现只按 同仓+作者+标题 精确匹配，且仅在"部分已检视"时才写 siblingGroup，
 * 导致两个问题：
 *   1) 同一问题在不同分支的标题措辞不一致（甚至跨 flutter_engine/flutter_flutter 两仓）
 *      时无法归组；分支名 slug 相同是更强的信号。
 *   2) 即使归了组，只要全已检视或全未检视就不展示，用户看不到"这是同一问题"。
 * 现改为：并查集合并「作者+分支slug」与「作者+标题」两种关系，跨仓；只要组内 PR≥2
 * 就写 siblingGroup（前端始终展示），部分检视额外标 inconsistent。
 * @param {Array} prs - listGitcodePrs 返回的 PR 列表
 * @returns {Array} 附加 siblingGroup 字段的 PR 列表
 */
export function groupSiblingPrs(prs) {
    const list = Array.isArray(prs) ? prs : [];
    const keyOf = (p, kind) => {
        const author = String(p.author || '').toLowerCase();
        if (!author) return '';
        if (kind === 'branch') {
            const slug = branchSlug(p.headRef);
            // 仅命名空间化分支（含 "/"）作依据，避免 oh-3.41.9-dev / dev / main 这类基础分支名误合并
            return slug.includes('/') && slug.length >= 8 ? `${author}|${slug}` : '';
        }
        const titleKey = siblingGroupKey(p.title);
        return titleKey ? `${author}|${titleKey}` : '';
    };

    const parent = new Map();
    const find = (x) => {
        while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
        return x;
    };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const idOf = new Map();
    list.forEach((p, i) => { const id = `pr-${i}`; idOf.set(p, id); parent.set(id, id); });

    const seen = new Map();
    for (const p of list) {
        for (const kind of ['branch', 'title']) {
            const key = keyOf(p, kind);
            if (!key) continue;
            const bucketKey = `${kind}:${key}`;
            const first = seen.get(bucketKey);
            if (first) union(idOf.get(first), idOf.get(p));
            else seen.set(bucketKey, p);
        }
    }

    const groups = new Map();
    for (const p of list) {
        const root = find(idOf.get(p));
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(p);
    }

    for (const [, group] of groups) {
        if (group.length < 2) continue;
        const reviewed = group.filter(p => p.labels?.includes('AI已检视'));
        const unreviewed = group.filter(p => !p.labels?.includes('AI已检视'));
        const nums = (arr) => arr.map(p => Number(p.number)).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
        // 归组依据：全员同一分支 slug → branch；否则同一（去版本前缀）标题 → title；两者混用 → mixed
        const slugs = [...new Set(group.map(p => branchSlug(p.headRef)).filter(s => s.includes('/') && s.length >= 8))];
        const titleKeys = [...new Set(group.map(p => siblingGroupKey(p.title)).filter(Boolean))];
        const matchBy = slugs.length === 1 ? 'branch' : (titleKeys.length === 1 ? 'title' : 'mixed');
        const key = matchBy === 'branch' ? slugs[0] : (titleKeys[0] || slugs[0] || '');
        const repos = [...new Set(group.map(x => x.repoFull || x.repo || '').filter(Boolean))];
        for (const p of group) {
            p.siblingGroup = {
                key,
                matchBy,
                total: group.length,
                reviewedCount: reviewed.length,
                unreviewedCount: unreviewed.length,
                numbers: nums(group),
                reviewedNumbers: nums(reviewed),
                unreviewedNumbers: nums(unreviewed),
                inconsistent: reviewed.length > 0 && unreviewed.length > 0,
                repos,
            };
        }
    }
    return list;
}

/**
 * 找到指定兄弟 PR 最近一份确实包含 AI 意见或修复 patch 的 run 工件。
 * run 可能使用 personalDir 隔离工作区，工件优先在 state.yaml 的 workingDirectory/outputs，
 * 其次才在 ~/.aceharness/runs/<runId>/outputs。
 */
export function findSiblingReviewSource(sibling, targetMeta = {}, { preparePatch = false } = {}) {
    const runsDir = join(aceRunsDir());
    const expectedOwner = String(targetMeta.owner || '').toLowerCase();
    const expectedRepo = String(targetMeta.repo || '').toLowerCase();
    const expectedNumber = String(sibling?.number || '');
    const runPattern = new RegExp(`-pr${expectedNumber}(-|$)`);
    const candidates = [];

    try {
        for (const name of readdirSync(runsDir)) {
            if (!runPattern.test(name)) continue;
            const runDir = join(runsDir, name);
            const meta = _parseGlobalContextMeta(_readRunGlobalContext(name));
            if (String(meta.number || '').replace(/^#/, '') !== expectedNumber) continue;
            if (expectedOwner && String(meta.owner || '').toLowerCase() !== expectedOwner) continue;
            if (expectedRepo && String(meta.repo || '').toLowerCase() !== expectedRepo) continue;

            let summary = {};
            try { summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')); } catch { /* 允许旧 run 缺少 summary */ }
            const workDir = _readRunWorkingDirectory(name);
            const commentsRaw = _readRunArtifactLocal(name, 'ai-review-comments.json', workDir);
            const patch = _readRunArtifactLocal(name, 'fix.patch', workDir) || '';
            const suggestionRaw = _readRunArtifactLocal(name, 'review-suggestion.json', workDir);
            let review = null;
            let suggestion = null;
            try { review = commentsRaw ? JSON.parse(commentsRaw) : null; } catch { /* 忽略损坏的工件 */ }
            try { suggestion = suggestionRaw ? JSON.parse(suggestionRaw) : null; } catch { /* 忽略损坏的工件 */ }
            if (review && !reviewArtifactMatchesPr(review, { owner: meta.owner, repo: meta.repo, number: expectedNumber })) continue;

            const comments = (Array.isArray(review?.comments) ? review.comments : [])
                .filter((item) => item && !item.stale && String(item.body || '').trim());
            if (!comments.length && !patch) continue;
            const startedAt = Date.parse(summary.startTime || summary.startedAt || '') || 0;
            candidates.push({
                runId: name,
                comments,
                patch,
                suggestion,
                actionableCount: comments.length,
                startedAt,
                workDir,
            });
        }
    } catch { /* runs 目录不存在或不可读 */ }

    candidates.sort((a, b) => (
        Number(Boolean(b.actionableCount)) - Number(Boolean(a.actionableCount))
        || Number(Boolean(b.patch)) - Number(Boolean(a.patch))
        || b.startedAt - a.startedAt
    ));
    const source = candidates[0];
    if (!source) return null;

    // user_apply_patch 读取 run 归档路径。隔离工作区产物需要镜像到归档，避免工作流误判为 patch 丢失。
    let patchPath = '';
    if (source.patch && preparePatch) {
        const archiveOutputs = join(runsDir, source.runId, 'outputs');
        patchPath = join(archiveOutputs, 'fix.patch');
        try {
            mkdirSync(archiveOutputs, { recursive: true });
            writeFileSync(patchPath, source.patch, 'utf8');
        } catch (error) {
            logger.warn('镜像兄弟 PR 修复 patch 到归档目录失败', { runId: source.runId, error: error.message });
            patchPath = '';
        }
    }

    return {
        runId: source.runId,
        comments: source.comments,
        actionableCount: source.actionableCount,
        patchPath,
        hasPatch: Boolean(source.patch && (!preparePatch || patchPath)),
        suggestion: source.suggestion,
        startedAt: source.startedAt ? new Date(source.startedAt).toISOString() : '',
    };
}

export function findAuthorGitcodeToken(gitcodeLogin) {
    const login = String(gitcodeLogin || '').trim();
    if (!login) return '';
    const keySuffix = login.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const envDir = join(aceDataDir(), 'env-vars.users');
    try {
        for (const file of readdirSync(envDir)) {
            if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
            try {
                const content = readFileSync(join(envDir, file), 'utf8');
                // YAML list of {key, value, enabled}；轻量解析避免引 yaml 依赖
                const keyRe = new RegExp(`key:\\s*GITCODE_TOKEN_${keySuffix}\\b`);
                if (!keyRe.test(content)) continue;
                const m = content.match(/key:\s*GITCODE_TOKEN_\S+[\s\S]{0,200}?value:\s*["']?([A-Za-z0-9_\-]+)["']?/);
                if (m && m[1]) return m[1];
            } catch { /* 单文件失败跳过 */ }
        }
    } catch { /* 目录不存在 */ }
    return '';
}

/**
 * 以 PR 作者身份在 GitCode 上评论 start build（AIWeb 侧一键重试）。
 * 令牌从 per-user env 查找（作者绑过即可用）；PR 必须仍为 open。
 * @returns {Promise<{posted: boolean, prUrl: string}>}
 */
export async function postStartBuildAsAuthor(prUrl, gitcodeLogin) {
    const token = findAuthorGitcodeToken(gitcodeLogin);
    if (!token) {
        throw new Error(`作者 ${gitcodeLogin} 的 GitCode 令牌未配置（需作者在 AIWeb「🔑 令牌」绑定），请作者本人到 PR 页面评论 start build`);
    }
    const m = String(prUrl || '').match(/https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/(?:pulls?|merge_requests)\/(\d+)/i);
    if (!m) throw new Error(`PR URL 无效: ${prUrl}`);
    const [, owner, repo, number] = m;
    const url = `${GITCODE_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/comments`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'AIWeb-PRMonitor/1.0',
        },
        body: JSON.stringify({ body: 'start build' }),
        signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 401 || resp.status === 403) {
        throw new Error(`作者令牌无效（HTTP ${resp.status}），请作者在 AIWeb 重新绑定`);
    }
    if (resp.status !== 200 && resp.status !== 201) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(`评论 start build 失败（HTTP ${resp.status}）：${err.message || ''}`);
    }
    return { posted: true, prUrl };
}

/**
 * 以 PR 作者（或决策用户）身份在 PR 上发「驳回 AI 检视意见」标记评论。
 * 标记评论（【AI检视处理】开头）会被 fetch-ai-review.mjs 识别：晚于全部待处理意见 → 后续 run 不再据此生成建议。
 * 令牌按候选顺序尝试：PR 作者 → 决策用户。
 */
export async function postReviewDismissComment(prUrl, candidateLogins = [], commentCount = 0) {
    const m = String(prUrl || '').match(/https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/(?:pulls?|merge_requests)\/(\d+)/i);
    if (!m) throw new Error(`PR URL 无效: ${prUrl}`);
    const [, owner, repo, number] = m;
    const body = [
        '【AI检视处理】用户已驳回全部 AI 检视意见' + (commentCount ? `（共 ${commentCount} 条）` : '') + '。',
        '用户选择自行处理代码，AI 不再按这些意见生成修复建议。',
        '如需 AI 重新处理，请重新提交检视。',
    ].join('\n');

    const tried = [];
    for (const login of candidateLogins.map((l) => String(l || '').trim()).filter(Boolean)) {
        const token = findAuthorGitcodeToken(login);
        if (!token) { tried.push(`${login}(无令牌)`); continue; }
        try {
            const url = `${GITCODE_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/comments`;
            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'AIWeb-PRMonitor/1.0',
                },
                body: JSON.stringify({ body }),
                signal: AbortSignal.timeout(15000),
            });
            if (resp.status === 200 || resp.status === 201) {
                return { posted: true, postedAs: login, prUrl };
            }
            tried.push(`${login}(HTTP ${resp.status})`);
        } catch (e) {
            tried.push(`${login}(${e.message.slice(0, 40)})`);
        }
    }
    throw new Error(`驳回标记评论发布失败（已尝试：${tried.join('、') || '无候选'}）——驳回已记录在平台，但 PR 上无标记，后续重新监控可能重新生成建议`);
}

/** 从 globalContext（结构化 key: value 行）解析 PR 元数据；head_sha 为启动 run 时的基线（修复前） */
function _parseGlobalContextMeta(text) {
    const get = (key) => {
        const m = new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm').exec(String(text || ''));
        return m ? m[1].trim() : '';
    };
    return {
        prUrl: get('pr_url'),
        owner: get('owner'),
        repo: get('repo'),
        number: get('number'),
        title: get('title'),
        author: get('author'),
        headRepo: get('head_repo'),
        headRef: get('head_ref'),
        baseRef: get('base_ref'),
        origHeadSha: get('head_sha'),
    };
}

function _parseSiblingReviewContext(runId) {
    const globalContext = _readRunGlobalContext(runId);
    const number = /^\s*sibling_review_pr:\s*(\d+)\s*$/m.exec(globalContext)?.[1] || '';
    const encoded = /^\s*sibling_review_comments_b64:\s*(\S+)\s*$/m.exec(globalContext)?.[1] || '';
    if (!number || !encoded) return null;
    try {
        const comments = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        if (!Array.isArray(comments)) return null;
        return {
            prNumber: number,
            comments: comments.slice(0, 4).filter((item) => item && String(item.body || '').trim()),
        };
    } catch {
        return null;
    }
}

/* ── 检视修复 patch 的 PR 级持久化 ──────────────────────────────────────────
 * 背景（1978 事故）：fix.patch 是 run 级产物。修复 run 崩溃被清理、或新监控 run
 * 接管后，平台「提交的修改」面板只读当前 run 的 outputs → 真实推送过的修复
 * 显示为「没有修改提交」。现改为读到 fix.patch 时按「仓库+PR 号」写一份到
 * ~/.aceharness/data/aiweb-review-fixes/，后续 run 读不到时回退读这份历史。
 * origHeadSha 一并持久化：那是修复 run 启动时的基线，回退区间的正确起点。 */
function _prFixStoreFile(owner, repo, number) {
    const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_');
    return join(aceDataDir(), 'aiweb-review-fixes', `${safe(owner)}__${safe(repo)}__${safe(number)}.json`);
}

function _readRunPushStatus(runId) {
    const logDir = join(aceRunsDir(), runId, 'outputs', 'step-logs');
    const outputsDir = join(aceRunsDir(), runId, 'outputs');
    try {
        const receipt = JSON.parse(readFileSync(join(outputsDir, 'push-result.json'), 'utf8'));
        if (_pushStatusSucceeded(receipt.push_status)) {
            return receipt.commit_sha && receipt.commit_sha === receipt.remote_head_sha ? 'success' : 'unverified';
        }
        if (receipt.push_status) return String(receipt.push_status);
    } catch { /* 兼容旧工作流 */ }
    try {
        const candidates = readdirSync(logDir)
            .filter((name) => name.startsWith('推送并触发-推送并start-build-') && name.endsWith('.md'))
            .map((name) => {
                const path = join(logDir, name);
                try { return { path, mtime: statSync(path).mtimeMs }; } catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.mtime - a.mtime);
        for (const item of candidates) {
            const raw = readFileSync(item.path, 'utf8');
            const match = /["']push_status["']\s*:\s*["']([^"']+)["']/i.exec(raw);
            if (match) return _pushStatusSucceeded(match[1]) ? 'unverified' : match[1];
        }
    } catch { /* 没有本地结构化推送记录 */ }
    // 旧运行仅写了自然语言总结；只识别明确失败，绝不从含糊文本推断推送成功。
    try {
        const raw = readFileSync(join(outputsDir, '推送并触发-推送并start-build.md'), 'utf8');
        if (/push[^\n]{0,30}失败|推送[^\n]{0,20}(?:失败|无权限)|403.{0,40}(?:权限|upload|拒绝)/i.test(raw)) return 'push_failed';
    } catch { /* 尚未推送 */ }
    return '';
}

function _pushStatusFailed(status) {
    return /fail|error|denied|403|拒绝|失败/i.test(String(status || ''));
}

function _pushStatusSucceeded(status) {
    return /^(?:push[_-])?(?:success|succeeded|pushed|completed?)$/i.test(String(status || '').trim());
}

function _loadPrFixEntry(owner, repo, number) {
    try {
        const entry = JSON.parse(readFileSync(_prFixStoreFile(owner, repo, number), 'utf8'));
        const status = entry?.runId ? _readRunPushStatus(entry.runId) : '';
        if (_pushStatusFailed(status) || !(entry?.pushed === true || _pushStatusSucceeded(status))) return null;
        return entry?.patch ? entry : null;
    } catch {
        return null;
    }
}

function _savePrFixEntry(entry) {
    try {
        mkdirSync(join(aceDataDir(), 'aiweb-review-fixes'), { recursive: true });
        writeFileSync(_prFixStoreFile(entry.owner, entry.repo, entry.number), JSON.stringify(entry, null, 2));
    } catch (e) {
        logger.warn('检视修复 patch 持久化失败', { error: e.message });
    }
}

/**
 * 从 GitCode 恢复「检视修复推送」（最后手段，patch 已随 run 目录丢失时）。
 * 仅展示意见之后的提交，不能据此证明对应问题已修复或由谁修复。
 * 流程：拉 PR 全部 commit，取「最后一条 stale AI 意见之后」的提交（≤5 个）；
 *       diff 正文从本机 repo-cache（~/.aceharness/repo-cache/gitcode.com/<owner>/<repo>.git）
 *       的 git 对象只读提取；缓存缺对象时降级为只返回提交清单。
 * @returns {Promise<{patch: string, commits: array, since: number}|null>}
 */
async function _recoverPushedFixFromGitcode(meta, staleComments) {
    const { owner, repo, number } = meta || {};
    if (!owner || !repo || !number) return null;
    const staleDates = (staleComments || [])
        .map(c => Date.parse(c.created_at || c.createdAt || ''))
        .filter(t => Number.isFinite(t));
    if (!staleDates.length) return null;   // 无 stale 意见 → 无「意见后推送」证据，不恢复
    const since = Math.max(...staleDates);

    const headers = { Accept: 'application/json', 'User-Agent': 'AIWeb-PRMonitor/1.0' };
    const token = process.env.ACE_GITCODE_TOKEN || config.gitcodeToken;
    if (token) headers.Authorization = `Bearer ${token}`;
    let commits = null;
    try {
        const resp = await fetch(
            `${GITCODE_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/commits?per_page=50`,
            { headers, signal: AbortSignal.timeout(4000) },
        );
        if (resp.status !== 200) return null;
        commits = await resp.json();
    } catch {
        return null;
    }
    if (!Array.isArray(commits)) return null;

    const pushed = commits
        .map(c => ({
            sha: c.sha || '',
            date: Date.parse(c.commit?.author?.date || c.commit?.committer?.date || '') || 0,
            subject: String(c.commit?.message || '').split('\n')[0].slice(0, 160),
            htmlUrl: c.html_url || `https://gitcode.com/${owner}/${repo}/commit/${c.sha}`,
        }))
        .filter(c => c.sha && c.date > since)
        .sort((a, b) => b.date - a.date)
        .slice(0, 5);
    if (!pushed.length) return null;

    // diff 正文：本机 repo-cache git 对象（只读；缺对象/超时则该提交无正文，仅列清单）
    let patch = '';
    const cacheDir = join(aceRuntimeRoot(), 'repo-cache', 'gitcode.com', owner, `${repo}.git`);
    if (existsSync(cacheDir)) {
        const parts = await Promise.all([...pushed].sort((a, b) => a.date - b.date).map(async (c) => {
            try {
                const { stdout } = await execFileAsync('git', ['-C', cacheDir, 'show', '--no-color', '--format=', c.sha],
                    { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
                return stdout.trimEnd() + '\n';
            } catch { return ''; }
        }));
        patch = parts.join('\n').slice(0, 256 * 1024);
    }
    return { patch, commits: pushed, since };
}

/**
 * 评论净化分类：兼容新旧两种 ai-review-comments.json。
 * 新版（fetch-ai-review.mjs + selectActionableReviews）已过滤噪音、kind 区分 ai_review/diff_comment；
 * 旧版（9月上旬）无分类，CI 播报/口令/测试评论全量混入 comments[] —— 此处按内容特征兜底：
 *   ai    = AI 检视意见（【AI-Review】标记或 kind=ai_review）
 *   human = 人工行内评论（kind=diff_comment，或旧版数据中非机器人的实质评论）
 *   noise = CI 机器人播报 / 口令（start build 等）/ DCP 系统通知 / 超短无意义内容
 */
const _NOISE_COMMAND_RE = /^(start build|submit|check dco|checkdco|approve|lgtm)\s*$/i;
const _NOISE_CI_BODY_RE = /门禁构建开始|代码门禁|感谢提交|构建失败|验证结果|监测到PR|限制提交|全量重新构建|重置.{0,8}验证状态|部分构建失败|首次触发|Thanks for submitting|dcpp|DCP 平台|学习视频/i;
const _NOISE_BOT_AUTHORS = new Set(['openharmony_ci', 'openharmony_dcp', 'cpf-manager']);

function _classifyReviewComments(rawComments) {
    const ai = [], human = [];
    let noise = 0;
    for (const c of rawComments) {
        const body = String(c.body || '').trim();
        const author = String(c.author || '');
        const kind = String(c.kind || '');
        const base = {
            id: c.id,
            author,
            path: c.path || '',
            line: c.line || '',
            body: c.body || '',
            htmlUrl: c.html_url || '',
            stale: !!c.stale,
            approvedPatch: c.approvedPatch === true,
            reviewSourceRunId: c.reviewSourceRunId || null,
            appliedByRunId: c.appliedByRunId || null,
        };
        // ① AI 检视意见：新版 kind 标记，或正文以【AI-Review】开头（新旧通用）
        if (kind === 'ai_review' || body.startsWith('【AI-Review】')) {
            ai.push(base);
            continue;
        }
        // ② 明确噪音：CI/DCP 机器人播报、检视机器人的非检视评论、口令式评论
        if (_NOISE_BOT_AUTHORS.has(author) || _NOISE_COMMAND_RE.test(body) || _NOISE_CI_BODY_RE.test(body)) {
            noise++;
            continue;
        }
        // ③ 超短无意义内容（旧数据里的 "1" 之类测试评论）
        if (body.replace(/\s/g, '').length <= 2) {
            noise++;
            continue;
        }
        // ④ 其余 → 人工行内评论（新版 kind=diff_comment 落于此；conversation 类同样归入）
        human.push(base);
    }
    return { ai, human, noise };
}

function suggestionField(item, keys) {
    for (const key of keys) {
        const value = String(item?.[key] || '').replace(/\r\n/g, '\n').trim();
        if (value) return value;
    }
    return '';
}

/** keep_trailer 里「保留」的 Signed-off-by 行。括号说明不是提交正文。 */
function keptTrailer(item) {
    const explicit = suggestionField(item, ['suggested_body']);
    if (explicit) return explicit;
    const line = suggestionField(item, ['keep_trailer'])
        .split('\n')
        .map((part) => part.trim())
        .find((part) => /^[A-Za-z][\w-]*:\s+\S/.test(part));
    return line ? line.replace(/[（(].*$/, '').trim() : '';
}

/** commit 标题/正文建议做成展示用 diff。它不是文件补丁，不能 git apply。 */
export function commitMessagePatch(suggestion) {
    const items = Array.isArray(suggestion?.suggestions) ? suggestion.suggestions : [];
    const blocks = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        let current = suggestionField(item, ['current', 'current_value', 'current_commit_title', 'current_commit_message', 'current_title']);
        const title = suggestionField(item, ['suggested_title', 'proposed_commit_title', 'suggested_value', 'proposed_value', 'proposed_title']);
        const body = keptTrailer(item);
        if (body && current && !current.includes(body)) current = `${current}\n\n${body}`;
        if (!title && !body) continue;
        const next = [title, body].filter(Boolean).join('\n\n');
        if (next === current) continue;
        const oldLines = (current || '(empty)').split('\n');
        const newLines = next.split('\n');
        blocks.push([
            'diff --git a/COMMIT_EDITMSG b/COMMIT_EDITMSG',
            '--- a/COMMIT_EDITMSG',
            '+++ b/COMMIT_EDITMSG',
            `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
            ...oldLines.map((line) => `-${line}`),
            ...newLines.map((line) => `+${line}`),
        ].join('\n'));
    }
    return blocks.join('\n');
}

/**
 * 聚合读取一个 run 的「AI 检视修复」数据：
 *   ai-review-comments.json（结构化意见） + fix.patch（提交的修改） + state.yaml globalContext（PR 元数据/基线 sha）
 * 任一文件缺失不报错，仅置空；hasReviewFix = 意见文件存在。
 * 评论经净化分类：aiComments（AI 检视意见）/ humanComments（人工行内评论）/ noiseFilteredCount（噪音数）。
 * PR 元数据从 state.yaml 的 globalContext 提取（启动时注入的结构化字段，格式稳定），
 * 不从 LLM 生成的识别PR.md 解析（其格式随 run 漂移）。
 *
 * patch 三级来源（patchSource 标注）：
 *   'run'       — 本 run 的 outputs/fix.patch（并写通 PR 级持久化）
 *   'history'   — 本 run 无 patch，回退读 PR 级持久化（更早 run 推送过；patchRunId/patchSavedAt/historyOrigHeadSha 带来源）
 *   'recovered' — 持久化也没有，从 GitCode 提交历史恢复（stale 意见之后的 push；recoveredCommits 为提交清单）
 * @returns {Promise<{hasReviewFix, aiComments, humanComments, noiseFilteredCount, actionableCount, patch, patchSource, patchRunId, patchSavedAt, historyOrigHeadSha, recoveredCommits, prMeta}>}
 */
export async function getReviewFixData(token, runId) {
    // 同机优先读本地文件，不先列出所有 outputs，也不对每份小产物单独请求远端。
    // 本地缺失时才并行回退 AceHarness API；隔离工作目录兼容 personalDir run。
    const workDir = _readRunWorkingDirectory(runId);
    const [commentsRaw, runPatch, suggestionRaw, gateRaw, defectsRaw] = await Promise.all([
        _readRunArtifact(token, runId, 'ai-review-comments.json', workDir),
        _readRunArtifact(token, runId, 'fix.patch', workDir),
        _readRunArtifact(token, runId, 'review-suggestion.json', workDir),
        _readRunArtifact(token, runId, 'gate-check.json', workDir),
        _readRunArtifact(token, runId, 'dcp-codecheck-defects.json', workDir),
    ]);

    const parseJson = (raw) => {
        try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    };

    let rawParsed = parseJson(commentsRaw);
    let reviewSourceRunId = null;
    let approvedComments = [];
    const context = _readRunGlobalContext(runId);
    const prMeta = _parseGlobalContextMeta(context);
    if (rawParsed && !reviewArtifactMatchesPr(rawParsed, prMeta)) rawParsed = null;
    const sourceId = /^\s*user_apply_patch:\s*(run-[A-Za-z0-9_-]+)\s*$/m.exec(context)?.[1];
    const normalize = p => String(p || '').replace(/^index [a-f0-9]+\.\.[a-f0-9]+/gm, 'index HASH..HASH').trimEnd();
    const approved = rawParsed?.approved_patch;
    const approvedHash = /^\s*approved_patch_sha256:\s*([a-f0-9]{64})\s*$/m.exec(context)?.[1];
    if (runPatch && sourceId && approvedHash && approved?.source_run_id === sourceId
        && approved.sha256 === approvedHash && approved.baseline_head_sha === _parseGlobalContextMeta(context).origHeadSha
        && approved.canonical_sha256 === createHash('sha256').update(normalize(runPatch)).digest('hex')) {
        reviewSourceRunId = sourceId;
        approvedComments = rawParsed.comments || [];
    }
    // An apply run inherits the approved review only when PR, owner, baseline and patch agree.
    if (!reviewSourceRunId && runPatch) {
        if (sourceId && sourceId !== runId) {
            const current = _parseGlobalContextMeta(context);
            const source = _parseGlobalContextMeta(_readRunGlobalContext(sourceId));
            const sourceWork = _readRunWorkingDirectory(sourceId);
            const sourcePatch = _readRunArtifactLocal(sourceId, 'fix.patch', sourceWork);
            const owner = id => {
                try { return JSON.parse(readFileSync(join(aceRunsDir(), id, 'summary.json'), 'utf8')).ownerId || ''; }
                catch { return ''; }
            };
            const ownerId = owner(runId);
            if (ownerId && ownerId === owner(sourceId) && current.owner && current.origHeadSha
                && ['owner', 'repo', 'number', 'headRepo', 'headRef', 'origHeadSha'].every(k => current[k] === source[k])
                && sourcePatch && normalize(sourcePatch) === normalize(runPatch)) {
                const original = parseJson(_readRunArtifactLocal(sourceId, 'ai-review-comments.json', sourceWork));
                if (original) {
                    reviewSourceRunId = sourceId;
                    approvedComments = original.comments || [];
                    rawParsed ||= original;
                }
            }
        }
    }
    if (reviewSourceRunId) {
        const key = c => String(c.id || `${c.path || ''}:${c.body || ''}`);
        const ids = new Set(approvedComments.map(key));
        rawParsed = { ...rawParsed,
            comments: [...(rawParsed.comments || []).filter(c => !ids.has(key(c))), ...approvedComments.map(c => ({ ...c,
                approvedPatch: true, reviewSourceRunId, appliedByRunId: runId }))],
            stale_comments: (rawParsed.stale_comments || []).filter(c => !ids.has(key(c))),
        };
    }
    const suggestion = parseJson(suggestionRaw);
    const gateCheck = parseJson(gateRaw);
    const defectReport = parseJson(defectsRaw);
    const executionEvidence = readExecutionEvidence(runId, workDir);
    const pushStatus = executionEvidence.pushStatus || _readRunPushStatus(runId);
    const pushFailed = _pushStatusFailed(pushStatus);
    const pushSucceeded = executionEvidence.pushStatus ? executionEvidence.pushSucceeded : _pushStatusSucceeded(pushStatus);
    const gateIssues = (Array.isArray(defectReport?.defects) ? defectReport.defects : []).map((item) => ({
        path: String(item.filepath || item.path || ''),
        line: item.line || null,
        rule: String(item.rule || ''),
        message: String(item.message || item.description || ''),
    })).filter((item) => item.path || item.message);
    const gateSummary = gateCheck ? {
        phase: String(gateCheck.phase || ''),
        summary: String(gateCheck.summary || ''),
        reportUrl: String(gateCheck.report_url || ''),
        failures: [['dco_fail', 'DCO'], ['static_fail', '静态检查'], ['compile_fail', '编译'], ['test_fail', '测试']]
            .filter(([key]) => gateCheck[key] === true).map(([, label]) => label),
        // 门禁日志根因核对（fetch-gate-logs.mjs）：把"抖动"从猜测变成有证据的结论。
        logVerdict: String(gateCheck.log_verdict || ''),
        rootCauseVerified: gateCheck.root_cause_verified === true,
        logReasons: Array.isArray(gateCheck.log_reasons) ? gateCheck.log_reasons.map(String).slice(0, 3) : [],
        logEvidence: Array.isArray(gateCheck.log_evidence) ? gateCheck.log_evidence.map(String).slice(0, 3) : [],
        // 重试用尽且非代码问题 → 前端提示联系门禁维护人员。
        retryBudgetExhausted: gateCheck.retry_budget_exhausted === true,
        needsMaintainer: gateCheck.needs_maintainer === true,
        logPlatformVerified: gateCheck.log_platform_verified === true,
        maintainerHint: String(gateCheck.maintainer_hint || ''),
    } : null;
    // 建议模式：本 run 生成了检视建议但未推送。文件 diff 和只改 commit 标题的建议都要进入决策。
    const suggestionMode = suggestion?.mode === 'suggestion';
    const commitPatch = commitMessagePatch(suggestion);

    // 净化分类（旧版全量数据在此被兜底过滤；新版已过滤的数据分类结果不变）。
    // comments[] 为待处理意见，stale_comments[] 为"旧代码意见"（push 后过期）——
    // 后者合并展示但带 stale 标记（前端弱化渲染），让用户知道"有过意见但已过期"。
    const { ai, human, noise } = (() => {
        if (!rawParsed) return { ai: [], human: [], noise: 0 };
        const staleMarked = (rawParsed.stale_comments || []).map(c => ({ ...c, stale: true }));
        return _classifyReviewComments([...(rawParsed.comments || []), ...staleMarked]);
    })();

    const siblingReview = _parseSiblingReviewContext(runId);

    // ── patch 三级来源：本 run fix.patch → PR 级持久化（历史 run 推送）→ GitCode 恢复 ──
    // 修复真实推送但 run 目录被清理/新 run 接管时，前两级都可能为空（1978 事故），
    // 第三级用「stale 意见之后的 push」从 GitCode 提交历史重建展示。
    let patch = runPatch || '';
    if (!suggestionMode) patch = await readPushedPatch({ runId, workingDirectory: workDir,
        baseline: prMeta.origHeadSha, commitSha: executionEvidence.commitSha, pushSucceeded }) || patch;
    let patchSource = patch ? 'run' : null;
    let patchRunId = null;
    let patchSavedAt = null;
    let historyOrigHeadSha = null;

    // 建议模式（未推送）的 patch 仅作展示，不写 PR 级持久化（那是"已推送修复"的缓存），也不走 history/recovered 回退
    if (patch && !suggestionMode && pushSucceeded && prMeta.owner && prMeta.repo && prMeta.number) {
        // 写通持久化：修复 run 一旦被清理，面板仍可展示并支持正确基线的回退
        _savePrFixEntry({
            owner: prMeta.owner, repo: prMeta.repo, number: prMeta.number,
            runId, origHeadSha: prMeta.origHeadSha || '', patch, pushed: true,
            savedAt: new Date().toISOString(),
        });
    }
    if (!patch && !suggestionMode && prMeta.owner && prMeta.repo && prMeta.number) {
        const entry = _loadPrFixEntry(prMeta.owner, prMeta.repo, prMeta.number);
        if (entry) {
            patch = entry.patch;
            patchSource = 'history';
            patchRunId = entry.runId || null;
            patchSavedAt = entry.savedAt || null;
            historyOrigHeadSha = entry.origHeadSha || null;
        }
    }
    let recoveredCommits = [];
    if (!patch) {
        const recovered = await _recoverPushedFixFromGitcode(prMeta, rawParsed?.stale_comments || []);
        if (recovered) {
            recoveredCommits = recovered.commits;
            if (recovered.patch) {
                patch = recovered.patch;
                patchSource = 'recovered';
            }
        }
    }

    return {
        hasReviewFix: !!rawParsed,
        reviewSourceRunId,
        // AI 检视意见（用户要的核心内容）——comments 字段保留为 AI 意见合集（前端主区渲染）
        comments: ai,
        aiComments: ai,
        humanComments: human,
        noiseFilteredCount: noise,
        actionableCount: ai.filter(c => !c.stale && !c.approvedPatch).length,
        staleCount: ai.filter(c => c.stale && !c.approvedPatch).length,
        patch: patch || '',
        ...executionEvidence,
        pushStatus,
        pushFailed,
        pushSucceeded,
        // 逐条配对：每条意见 + 对应文件的 diff 片段
        pairs: _buildCommentChangePairs(ai, patch || '', gateIssues),
        gateIssues,
        gateSummary,
        // 'run'（本任务推送）| 'history'（更早任务推送，已持久化）| 'recovered'（GitCode 恢复）| null
        patchSource,
        patchRunId,
        patchSavedAt,
        historyOrigHeadSha,
        recoveredCommits,
        // 建议模式：检视意见的建议修复已生成但未推送，等用户决策（应用/驳回/反馈）
        suggestionMode,
        commitPatch,
        suggestion: suggestionMode ? {
            headSha: suggestion.head_sha || '',
            commentCount: suggestion.comment_count ?? null,
            generatedAt: suggestion.generated_at || null,
            fixPatchAvailable: suggestion.fix_patch_available !== false && Boolean(runPatch),
        } : null,
        siblingReview,
        prMeta,
    };
}

/** Freeze source review artifacts before dispatch, so later workspace cleanup cannot lose attribution. */
export function archiveApprovedReview(runId, patch) {
    if (!/^run-[A-Za-z0-9_-]+$/.test(runId)) throw new Error('无效的执行编号');
    const out = join(aceRunsDir(), runId, 'outputs');
    const work = _readRunWorkingDirectory(runId);
    const artifacts = ['ai-review-comments.json', 'dcp-codecheck-defects.json', 'review-suggestion.json']
        .map(name => [name, _readRunArtifactLocal(runId, name, work)]);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'fix.patch'), patch, { mode: 0o600 });
    for (const [name, body] of artifacts) if (body) writeFileSync(join(out, name), body, { mode: 0o600 });
}

/**
 * 以用户身份启动「检视修复人工指令」run（回退修复 / 按用户反馈修改）。
 * globalContext 在常规 PR 字段之外注入指令行，工作流「识别」识别 userfix 直达「检视修复」。
 * @param {string} token - 用户 AceHarness token
 * @param {object} pr - { owner, repo, number, title, author, headRef, baseRef, headRepo, state }
 * @param {object} instruction - { kind: 'revert'|'feedback', revertFrom?, revertTo?, feedback? }
 * @returns {Promise<{runId: string, prUrl: string}>}
 */
/** 将 unified diff 按文件拆分，返回 Map<path, diffText> */
function _splitPatchByFile(patch) {
    const files = new Map();
    if (!patch) return files;
    const lines = patch.split('\n');
    let currentFile = null;
    let currentLines = [];
    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            if (currentFile) files.set(currentFile, currentLines.join('\n'));
            const m = line.match(/diff --git a\/(\S+) b\/(\S+)/);
            currentFile = m ? m[2] : 'unknown';
            currentLines = [line];
        } else if (currentFile) {
            currentLines.push(line);
        }
    }
    if (currentFile) files.set(currentFile, currentLines.join('\n'));
    return files;
}

/**
 * 逐条配对：每条 AI 意见 + 对应文件的 diff 片段。
 * comment.path 与正文里出现的补丁文件名都可以挂上，一条意见可挂多个被点名的文件。
 * 正文没写出的伴随修改：与已挂文件同一处类型改动的源文件挂回该意见；
 * 点名了仓库里旧测试、补丁里另有一个新测试文件时，挂到提出回归单测的那条意见。
 * 只有「没配上的意见恰好 1 条、剩下的文件也恰好 1 个」时才做最后兜底。
 * 没有对应代码的意见保持空白，不进附加修改。
 */
function _fileBase(file) {
    return String(file || '').split(/[/\\]/).pop().toLowerCase();
}

function _isTestFile(file) {
    return /(?:^|[._-])(?:test|spec)[._-]|[._-](?:test|spec)\.[a-z0-9]+$/i.test(_fileBase(file));
}

function _addedLines(diff) {
    return String(diff || '').split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
}

/** 正文里的类型名、限定名。用来判断另一份修改是不是同一处改动，不拿文件名本身当证据。 */
function _codeIdentifiers(text) {
    const found = new Set();
    const source = String(text || '');
    for (const match of source.matchAll(/\b[A-Za-z_][\w]*\.[A-Za-z_][\w.]*/g)) {
        if (match[0].length >= 12) found.add(match[0]);
    }
    for (const match of source.matchAll(/\b[A-Z][A-Za-z0-9_]{7,}\b/g)) found.add(match[0]);
    return found;
}

function _asksForTest(body) {
    return /单测|单元测试|回归测试|回归单测|测试用例|补测试|增加测试|新增测试|补充测试|写测试|加测试|unit test|regression test/i.test(String(body || ''));
}

function _mentionsAbsentExampleTest(body, fileDiffs) {
    const tokens = String(body || '').match(/[\w./-]+\.[A-Za-z0-9]{1,10}/g) || [];
    return tokens.some((token) => {
        const base = token.split('/').pop().toLowerCase();
        if (!/(?:^|[._-])(?:test|spec)[._-]|[._-](?:test|spec)\.[a-z0-9]+$/i.test(base)) return false;
        return ![...fileDiffs.keys()].some((file) => _fileBase(file) === base || file.toLowerCase().endsWith('/' + token.toLowerCase()));
    });
}

/* 从意见正文提取补丁里真实存在的文件。一条意见可以点名多个文件，按出现顺序全部返回。 */
function _filesNamedInCommentBody(body, fileDiffs) {
    if (!body || !fileDiffs.size) return [];
    const tokens = String(body).match(/[\w./-]+\.[A-Za-z0-9]{1,10}/g) || [];
    const found = [];
    const seen = new Set();
    for (const token of tokens) {
        const base = token.split('/').pop().toLowerCase();
        if (!base || base.length < 3) continue;
        for (const [file] of fileDiffs) {
            const sameBase = _fileBase(file) === base || file.toLowerCase().endsWith('/' + token.toLowerCase());
            if (sameBase && !seen.has(file)) {
                seen.add(file);
                found.push(file);
            }
        }
    }
    return found;
}

function _attachPairFile(pair, file, fileDiffs, usedFiles) {
    if (!file || usedFiles.has(file) || pair.diffFiles.includes(file)) return false;
    pair.diffFiles.push(file);
    pair.diff = pair.diffFiles.map((name) => fileDiffs.get(name)).filter(Boolean).join('\n');
    pair.diffFile = pair.diffFiles[0] || null;
    pair.hasDiff = pair.diffFiles.length > 0;
    usedFiles.add(file);
    return true;
}

function _gateIssueMatchesFile(issue, file) {
    const issuePath = String(issue?.path || '').replace(/^\/+/, '');
    const changedPath = String(file || '').replace(/^\/+/, '');
    return Boolean(issuePath && (issuePath === changedPath
        || changedPath.endsWith('/' + issuePath)
        || issuePath.endsWith('/' + changedPath)));
}

export function _buildCommentChangePairs(aiComments, patch, gateIssues = []) {
    const fileDiffs = _splitPatchByFile(patch);
    const usedFiles = new Set();
    const isGateFile = (file) => gateIssues.some((issue) => _gateIssueMatchesFile(issue, file));

    /* 第一遍：路径匹配（所有意见）+ 正文文件名匹配（仅待处理意见——
     * stale 意见的修复是更早的推送，当前 patch 不代表它们的修复，不参与正文匹配） */
    const canTakeFiles = (comment) => !comment.stale || comment.approvedPatch;
    const pairs = aiComments.map((c, i) => {
        const pair = {
            pairId: `pair-${i}`,
            index: i + 1,
            comment: c,
            diff: '',
            diffFile: null,
            diffFiles: [],
            hasDiff: false,
            gateRelated: false,
        };
        const pathNamed = [];
        if (c.path && canTakeFiles(c)) {
            for (const [file] of fileDiffs) {
                if (file === c.path || file.endsWith('/' + c.path) || c.path.endsWith('/' + file)) pathNamed.push(file);
            }
        }
        const bodyNamed = canTakeFiles(c) ? _filesNamedInCommentBody(c.body, fileDiffs) : [];
        const named = [...pathNamed, ...bodyNamed];
        let sawGateFile = false;
        for (const file of named) {
            if (isGateFile(file) && !c.approvedPatch) {
                sawGateFile = true;
                continue;
            }
            _attachPairFile(pair, file, fileDiffs, usedFiles);
        }
        if (!pair.hasDiff && sawGateFile) pair.gateRelated = true;
        return pair;
    });

    const actionable = (pair) => !pair.comment.stale && !pair.gateRelated;
    const leftover = () => [...fileDiffs].filter(([file]) => !isGateFile(file) && !usedFiles.has(file));

    /* 回归单测：意见点名的 *.test 不在补丁里，补丁另有一个新测试文件时挂过去。 */
    const unmatchedTests = leftover().filter(([file]) => _isTestFile(file));
    const testComments = pairs.filter((pair) => actionable(pair)
        && (_asksForTest(pair.comment.body) || _mentionsAbsentExampleTest(pair.comment.body, fileDiffs))
        && !pair.diffFiles.some(_isTestFile));
    if (unmatchedTests.length === 1 && testComments.length === 1) {
        _attachPairFile(testComments[0], unmatchedTests[0][0], fileDiffs, usedFiles);
    } else {
        for (const [file, ] of unmatchedTests) {
            const stem = _fileBase(file).replace(/\.(?:test|spec)\.[a-z0-9]+$/i, '');
            const hits = testComments.filter((pair) => stem.length >= 4
                && String(pair.comment.body || '').toLowerCase().includes(stem.toLowerCase())
                && !pair.diffFiles.some(_isTestFile));
            if (hits.length === 1) _attachPairFile(hits[0], file, fileDiffs, usedFiles);
        }
    }

    /* 同一条意见已经挂上一个文件时，把同一处类型修改带出的其他源文件挂回去。测试文件不走这里。 */
    for (const [file] of leftover()) {
        if (_isTestFile(file)) continue;
        const added = _addedLines(fileDiffs.get(file));
        const stem = _fileBase(file).replace(/\.[a-z0-9]+$/i, '');
        const scored = [];
        for (const pair of pairs) {
            if (!actionable(pair) || !pair.hasDiff) continue;
            const body = String(pair.comment.body || '');
            let score = 0;
            if (stem.length >= 8 && body.toLowerCase().includes(stem.toLowerCase())) score += 5;
            for (const identifier of _codeIdentifiers(body)) {
                if (added.includes(identifier)) score += 2;
            }
            for (const owned of pair.diffFiles) {
                if (String(fileDiffs.get(owned) || '').includes(stem) && stem.length >= 8) score += 3;
            }
            if (score > 0) scored.push({ pair, score });
        }
        scored.sort((a, b) => b.score - a.score);
        if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
            _attachPairFile(scored[0].pair, file, fileDiffs, usedFiles);
        }
    }

    /* 最后兜底：没配上的待处理意见恰好 1 条，且只剩 1 个文件。
     * 多条意见不能共用同一个 diff（PR1533 的 8 条意见曾全部显示同一份修复）。 */
    const unmatchedActionable = pairs.filter(p => !p.hasDiff && !p.comment.stale && !p.gateRelated);
    const unmatchedFiles = leftover();
    if (unmatchedActionable.length === 1 && unmatchedFiles.length === 1) {
        const [file, d] = unmatchedFiles[0];
        unmatchedActionable[0].diff = d;
        unmatchedActionable[0].diffFile = file;
        unmatchedActionable[0].diffFiles = [file];
        unmatchedActionable[0].hasDiff = true;
        usedFiles.add(file);
    }

    // 门禁问题独立配对，保留没有 patch 的问题，不混进附加修改。
    for (const [i, issue] of gateIssues.entries()) {
        const match = [...fileDiffs].find(([file]) => _gateIssueMatchesFile(issue, file));
        if (match) usedFiles.add(match[0]);
        pairs.push({ pairId: `gate-${i}`, index: pairs.length + 1, comment: null,
            isGate: true, gateIssues: [issue], diff: match?.[1] || '',
            diffFile: match?.[0] || issue.path, hasDiff: Boolean(match) });
    }
    for (const [file, diff] of fileDiffs) {
        if (!usedFiles.has(file)) pairs.push({
            pairId: `extra-${pairs.length}`, index: pairs.length + 1, comment: null,
            diff, diffFile: file, hasDiff: true, isExtra: true,
        });
    }

    return pairs;
}

export async function startReviewActionRun(token, pr, instruction, options = {}) {
    const owner = String(pr?.owner || '').trim();
    const repo = String(pr?.repo || '').trim();
    const number = String(pr?.number || '').trim();
    if (!owner || !repo || !/^\d+$/.test(number)) {
        throw new Error('PR 参数不完整（需要 owner/repo/number）');
    }
    if (!pr?.author) throw new Error('PR 元数据缺少 author（无法以正确身份推送）');

    const prUrl = `https://gitcode.com/${owner}/${repo}/merge_requests/${number}`;

    // 指令行：单行注入（多行反馈折叠为 " | "），避免破坏 globalContext 的行结构
    let instructionLine = '';
    if (instruction?.kind === 'revert') {
        if (!instruction.revertFrom || !instruction.revertTo) throw new Error('回退指令缺少 from/to sha');
        instructionLine = `user_revert: from ${instruction.revertFrom} to ${instruction.revertTo}`;
    } else if (instruction?.kind === 'feedback') {
        const feedback = String(instruction.feedback || '').trim();
        if (feedback.length < 5) throw new Error('修改建议太短（至少 5 个字符）');
        instructionLine = `user_fix_feedback: ${feedback.replace(/\s*\n\s*/g, ' | ').slice(0, 2000)}`;
    } else if (instruction?.kind === 'apply_patch') {
        const src = String(instruction.sourceRunId || '').trim();
        if (!/^run-[A-Za-z0-9-]+$/.test(src)) throw new Error('应用建议指令缺少有效的源 runId');
        instructionLine = `user_apply_patch: ${src}`;
        if (instruction.patchHash) {
            if (!/^[a-f0-9]{64}$/.test(instruction.patchHash)) throw new Error('批准补丁摘要无效');
            instructionLine += `\napproved_patch_sha256: ${instruction.patchHash}`;
        }
    } else {
        throw new Error('未知指令类型');
    }

    const sourceReview = instruction?.sourceReview;
    const sourceComments = Array.isArray(sourceReview?.comments)
        ? sourceReview.comments.slice(0, 4).map((item) => ({
            path: String(item?.path || '').slice(0, 300),
            line: item?.line ? String(item.line).slice(0, 20) : '',
            author: String(item?.author || '').slice(0, 100),
            body: String(item?.body || '').slice(0, 1000),
            html_url: String(item?.html_url || '').slice(0, 500),
        })).filter((item) => item.body.trim())
        : [];
    const globalContext = [
        'GitCode 自己的 PR 自修任务',
        'event: manual',
        'action: open',
        `pr_url: ${prUrl}`,
        `owner: ${owner}`,
        `repo: ${repo}`,
        `number: ${number}`,
        `title: ${pr.title || ''}`,
        `state: ${pr.state || 'open'}`,
        `head_ref: ${pr.headRef || ''}`,
        `head_repo: ${pr.headRepo || ''}`,
        `base_ref: ${pr.baseRef || ''}`,
        `head_sha: ${pr.headSha || ''}`,
        `author: ${pr.author}`,
        'manual-start-by: ' + pr.author,
        instructionLine,
        sourceComments.length ? `sibling_review_pr: ${String(sourceReview.number || '').replace(/\D/g, '')}` : '',
        sourceComments.length ? `sibling_review_comments_b64: ${Buffer.from(JSON.stringify(sourceComments), 'utf8').toString('base64')}` : '',
    ].filter(Boolean).join('\n');

    const safeNum = number.replace(/[^0-9A-Za-z_-]/g, '');
    const runId = options.runId || `run-${Date.now()}-pr${safeNum}-${Math.random().toString(16).slice(2, 10)}`;
    if (!/^run-[A-Za-z0-9-]+$/.test(runId)) throw new Error('无效的操作执行 runId');

    const result = await httpRequest('POST', '/api/workflow/start', {
        configFile: PR_REVIEW_CONFIG_FILE,
        runId,
        skipPreflight: true,
        initialContexts: { globalContext, phaseContexts: {} },
    }, { token, timeoutMs: 60000 });

    if (result.status !== 200) {
        const msg = result.data?.error || result.data?.message || `启动失败（HTTP ${result.status}）`;
        const error = new Error(String(msg).slice(0, 300));
        error.definitelyNotStarted = [400, 401, 403, 422].includes(result.status);
        throw error;
    }
    return { runId: result.data?.runId || runId, prUrl };
}

/* ════════════════════════════════════════════════════════════════════════
 *  GitCode PR 总览 + 监控人工控制
 * ════════════════════════════════════════════════════════════════════════ */

// 测试钩子：GITCODE_API_ROOT / GITCODE_ORG_API_ROOT 可指向本地 GitCode 模拟器（默认线上地址，行为不变）。
const GITCODE_API_BASE = process.env.GITCODE_API_ROOT || 'https://gitcode.com/api/v5';
const GITCODE_ORG_API_BASE = process.env.GITCODE_ORG_API_ROOT || 'https://api.gitcode.com/api/v5';

/**
 * 拉单个 PR 详情（列表接口的 testers 恒为空数组，测试人/审批人状态必须用详情接口）。
 * @returns {Promise<object|null>} PR 详情对象；网络失败返回 null（调用方按"无法判定"处理，不阻塞）
 */
export async function getGitcodePrDetail(owner, repo, number, timeoutMs = 5000) {
    const token = String(process.env.ACE_GITCODE_TOKEN || process.env.GITCODE_TOKEN || config.gitcodeToken || '').trim();
    const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    try {
        const resp = await fetch(
            `${GITCODE_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`,
            { headers, signal: AbortSignal.timeout(timeoutMs) },
        );
        if (resp.status !== 200) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

/** 读取仓库里某个 ref 的文本文件。失败返回空字符串，不抛凭据。 */
export async function fetchRepoFile(owner, repo, filePath, ref) {
    const safePath = String(filePath || '').replace(/^\/+/, '');
    if (!owner || !repo || !safePath || safePath.includes('..')) return '';
    const encoded = safePath.split('/').map(encodeURIComponent).join('/');
    const url = `${GITCODE_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}?ref=${encodeURIComponent(ref || 'HEAD')}`;
    try {
        const response = await fetch(url, { headers: gitcodeApiHeaders(), signal: AbortSignal.timeout(15000) });
        if (response.status !== 200) return '';
        const payload = await response.json();
        if (payload?.encoding === 'base64' && payload.content) {
            return Buffer.from(String(payload.content).replace(/\n/g, ''), 'base64').toString('utf8');
        }
        return typeof payload?.content === 'string' ? payload.content : '';
    } catch {
        return '';
    }
}

/** 测试人已通过判定：testers 非空且全部 accept=true（GitCode 网页"测试人 ✓ 已通过"） */
export function isTesterApproved(testers) {
    const list = Array.isArray(testers) ? testers : [];
    return list.length > 0 && list.every((t) => Boolean(t && t.accept));
}

/** 监听仓库规则（owner/repo 或 owner/*，逗号分隔）。 */
export function watchRepos() {
    const raw = String(process.env.GITCODE_PR_REPOS || config.gitcodePrRepos || 'CPF-Flutter/*');
    const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
    const invalid = values.filter((value) => !/^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/.test(value));
    if (invalid.length) throw new Error(`监听仓库规则格式无效：${invalid.join(', ')}（应为 owner/repo 或 owner/*）`);
    const seen = new Set();
    return values.filter((value) => {
        const key = value.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

const ORG_REPOS_TTL_MS = 10 * 60 * 1000;
const ORG_REPOS_MAX_PAGES = 100;
const _orgReposCache = new Map();

function gitcodeApiHeaders() {
    const token = String(process.env.ACE_GITCODE_TOKEN || process.env.GITCODE_TOKEN || config.gitcodeToken || '').trim();
    return { Accept: 'application/json', 'User-Agent': 'AIWeb-PRMonitor/1.0', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/** 按组织分页发现可访问的代码仓；任一页失败都拒绝返回不完整目录。 */
async function fetchOrgCodeRepos(owner, headers, force = false, type = 'all') {
    const repoType = ['all', 'public', 'private'].includes(type) ? type : 'all';
    const key = `${owner.toLowerCase()}:${repoType}`;
    let entry = _orgReposCache.get(key);
    if (!entry) {
        entry = { at: 0, repos: [], inflight: null };
        _orgReposCache.set(key, entry);
    }
    if (!force && entry.repos.length && Date.now() - entry.at < ORG_REPOS_TTL_MS) return entry.repos;
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
        const repos = [];
        for (let page = 1; page <= ORG_REPOS_MAX_PAGES; page++) {
            const url = `${GITCODE_ORG_API_BASE}/orgs/${encodeURIComponent(owner)}/repos?type=${repoType}&repo_type=code&per_page=100&page=${page}`;
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
            const payload = await response.json().catch(() => null);
            if (response.status !== 200 || !Array.isArray(payload)) {
                const message = payload?.message || payload?.error || '返回格式异常';
                throw new Error(`读取 ${owner} 代码仓目录失败（HTTP ${response.status}）：${message}`);
            }
            for (const item of payload) {
                const full = String(item?.full_name || '').trim().replace(/\.git$/i, '');
                const parts = full.split('/');
                const namespace = String(parts[0] || '').trim();
                const repoName = String(parts[1] || '').trim();
                if (parts.length === 2 && namespace.toLowerCase() === owner.trim().toLowerCase() && /^[A-Za-z0-9_.-]+$/.test(repoName)) repos.push(`${namespace}/${repoName}`);
            }
            if (payload.length < 100) {
                const unique = [...new Map(repos.map((repo) => [repo.toLowerCase(), repo])).values()];
                if (!unique.length) throw new Error(`组织 ${owner} 未返回可访问的代码仓库`);
                entry.at = Date.now();
                entry.repos = unique;
                return unique;
            }
        }
        throw new Error(`读取 ${owner} 代码仓目录超过 ${ORG_REPOS_MAX_PAGES} 页，拒绝使用不完整目录`);
    })().finally(() => { entry.inflight = null; });
    return entry.inflight;
}

/** 展开精确仓库与 owner/* 规则，结果始终是可用于 PR API 的具体仓库。 */
export async function resolveWatchRepos(opts = {}) {
    const patterns = watchRepos();
    if (!patterns.length) throw new Error('监听仓库配置无效（应为 owner/repo 或 owner/*，逗号分隔）');
    const headers = gitcodeApiHeaders();
    const exact = patterns.filter((pattern) => !pattern.endsWith('/*'));
    const owners = patterns.filter((pattern) => pattern.endsWith('/*')).map((pattern) => pattern.slice(0, -2));
    const expanded = [...exact];
    for (const owner of owners) expanded.push(...await fetchOrgCodeRepos(owner, headers, opts.fresh === true));
    const repos = [...new Map(expanded.map((repo) => [repo.toLowerCase(), repo])).values()];
    if (!repos.length) throw new Error('监听仓库配置未解析出任何代码仓');
    return repos;
}

/** 解析 GITCODE_USER_MAP（邮箱:gitcode用户名，分号分隔） */
export function parseGitcodeUserMap() {
    const raw = String(process.env.GITCODE_USER_MAP || '');
    const map = new Map();
    for (const pair of raw.split(/[;\n,]+/)) {
        const idx = pair.indexOf(':');
        if (idx <= 0) continue;
        const email = pair.slice(0, idx).trim().toLowerCase();
        const login = pair.slice(idx + 1).trim();
        if (email && login) map.set(email, login);
    }
    return map;
}

/**
 * 收集平台所有注册用户绑定的 GitCode 身份（admin 全局视图用）。
 * 来源：① 各用户已保存的 GitCode 令牌（env-vars.users/<userId>.yaml 的 GITCODE_TOKEN_<login> 键）
 *       ② 邮箱映射（GITCODE_USER_MAP）。
 * 返回 [{ username, email, gitcodeUsername, source }]。
 * 同一个 GitCode 登录名可以同时属于多个平台账号，按「平台用户 + GitCode 登录名」保留，
 * 避免先注册的账号占掉后来账号的本人 PR 查询。
 */
export function listAllGitcodeIdentities() {
    const seen = new Map();
    const dataDir = aceDataDir();
    const put = (entry) => {
        const login = String(entry.gitcodeUsername || '').trim();
        if (!login) return;
        const key = [
            String(entry.username || '').toLowerCase(),
            String(entry.email || '').toLowerCase(),
            login.toLowerCase(),
        ].join('\n');
        if (!seen.has(key)) seen.set(key, { ...entry, gitcodeUsername: login });
    };
    try {
        const users = JSON.parse(readFileSync(join(dataDir, 'users.json'), 'utf8'));
        const envDir = join(dataDir, 'env-vars.users');
        for (const u of users) {
            try {
                const raw = readFileSync(join(envDir, `${u.id}.yaml`), 'utf8');
                const logins = new Set([...raw.matchAll(/GITCODE_TOKEN_([A-Za-z0-9_]+)/g)].map((m) => m[1]));
                for (const login of logins) {
                    put({ username: u.username, email: u.email, gitcodeUsername: login, source: 'token' });
                }
            } catch { /* 单个文件读失败忽略 */ }
        }
        for (const [email, login] of parseGitcodeUserMap()) {
            const u = users.find((x) => String(x.email || '').toLowerCase() === email);
            put({ username: u?.username || '（未注册）', email, gitcodeUsername: login, source: 'email' });
        }
    } catch { /* users.json 读失败返回空 */ }
    return [...seen.values()];
}

/**
 * 拉取 GitCode 仓库里指定作者的 PR 列表（直连 GitCode API，与 AceHarness 无关）
 * 网络层间歇失败（DNS/连接抖动，实测偶发）自动重试 1 次。
 * @param {object} opts - { author, state: 'open'|'closed'|'all', page, perPage }
 * @returns {Promise<{prs: array, repo: string, author: string}>}
 */
/* ── 仓库级 PR 全量分页缓存（所有作者 / 管理员聚合视图共享，按仓库分键） ──
 * 背景：GitCode pulls 接口不支持按 author 过滤，此前实现只拉第一页
 * （全仓最近更新的 100 个，活跃仓库约等于最近 5 天），老 PR 整段不可见
 * （AndCJ 名下 43 个 PR 只显示 6 个的根因）。现改为分页拉全量并共享缓存。
 * 多仓支持：GITCODE_PR_REPOS 可用 owner/repo 精确列表或 owner/*；每仓独立缓存与分页，
 * 查询时跨仓合并——PR 对象带 repo（短名）/repoFull（全名）字段，
 * 两仓 PR 编号独立且重叠（flutter#1541 ≠ engine#1541），一切去重/查找必须用「仓库+编号」。 */
const REPO_PRS_TTL_MS = 5 * 60 * 1000;
const REPO_PRS_PARTIAL_RETRY_MS = 60 * 1000;
const REPO_PRS_MAX_PAGES = Math.max(1, parseInt(process.env.GITCODE_PRS_MAX_PAGES || '25', 10) || 25);
const REPO_PRS_BATCH = 2;
const REPO_PRS_DEADLINE_MS = 15000;
const REPO_PRS_CONCURRENCY = 4;
const _repoPrsCache = new Map();                                      // lower(owner/repo) -> { at, prs, complete, reason, inflight }
const _repoPrsQueue = [];
let _activeRepoPrsScans = 0;

function pumpRepoPrsQueue() {
    while (_activeRepoPrsScans < REPO_PRS_CONCURRENCY && _repoPrsQueue.length) {
        const job = _repoPrsQueue.shift();
        _activeRepoPrsScans++;
        Promise.resolve().then(job).finally(() => {
            _activeRepoPrsScans--;
            pumpRepoPrsQueue();
        });
    }
}

function retryAfterMs(response) {
    const value = response.headers.get('retry-after');
    if (!value) return 1000;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
}

/** GitCode API 请求：网络/5xx 重试一次；429 按 Retry-After 等待后最多重试一次。 */
async function fetchGitcodeJson(url, headers) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
            if (response.status === 429) {
                const waitMs = retryAfterMs(response);
                if (attempt === 0 && waitMs <= 30000) {
                    await new Promise((resolve) => setTimeout(resolve, waitMs));
                    continue;
                }
            } else if (response.status >= 500 && response.status <= 599 && attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, 600));
                continue;
            }
            if (response.status !== 200) {
                const body = await response.json().catch(() => ({}));
                const error = new Error(`GitCode API 请求失败（HTTP ${response.status}）：${body.message || body.error || ''}`);
                error.status = response.status;
                throw error;
            }
            return await response.json();
        } catch (error) {
            const transient = /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|aborted/i.test(`${error.message} ${error.cause?.code || ''}`);
            if (attempt === 0 && transient) {
                await new Promise((resolve) => setTimeout(resolve, 600));
                continue;
            }
            throw error;
        }
    }
    throw new Error('GitCode PR 请求重试后仍失败');
}

/** 拉取单页仓库 PR 列表。 */
async function fetchPrsPage(owner, repoName, headers, page, perPage = 100, state = 'all', filters = {}) {
    const query = new URLSearchParams({ state, per_page: String(perPage), page: String(page), sort: 'updated', direction: 'desc' });
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, String(value));
    const url = `${GITCODE_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls?${query}`;
    return fetchGitcodeJson(url, headers);
}

function normalizeGitcodePr(p, fallbackOwner = '') {
    const baseRepo = p?.base?.repo || p?.target?.repo || {};
    const repoPath = String(baseRepo.full_path || baseRepo.full_name || '').trim();
    const namespace = String(baseRepo.name_space?.path || baseRepo.owner?.login || fallbackOwner).trim();
    const repoName = String(baseRepo.path || baseRepo.name || '').trim();
    const repoFull = repoPath.includes('/') ? repoPath : (namespace && repoName ? `${namespace}/${repoName}` : '');
    const state = String(p?.state || '').toLowerCase();
    const author = p?.user?.login || p?.author?.username || p?.head?.user?.login || '';
    return {
        number: p?.number ?? p?.iid ?? '',
        title: String(p?.title || p?.subject || ''),
        description: String(p?.description || p?.body || ''),
        state: p?.merged || p?.merged_at || state === 'merged' ? 'merged' : (state === 'open' ? 'open' : 'closed'),
        author: String(author),
        headRef: String(p?.head?.ref || p?.source_branch || ''),
        baseRef: String(p?.base?.ref || p?.target_branch || ''),
        headSha: String(p?.head?.sha || p?.diff_refs?.head_sha || ''),
        headRepo: String(p?.head?.repo?.full_name || p?.head?.repo?.full_path || ''),
        htmlUrl: String(p?.html_url || p?.web_url || (repoFull && p?.number ? `https://gitcode.com/${repoFull}/merge_requests/${p.number}` : '')),
        createdAt: String(p?.created_at || ''),
        updatedAt: String(p?.updated_at || ''),
        repo: repoFull.split('/')[1] || '',
        repoFull,
        visibilityReason: String(p?.visibility_reason || ''),
        labels: Array.isArray(p?.labels)
            ? p.labels.map((label) => (typeof label === 'string' ? label : String(label?.name || '')).trim()).filter(Boolean)
            : [],
    };
}

/** 读取 CPF-Flutter 组织级 PR 页面：全作者，服务端分页/状态/标题描述搜索。 */
export async function listGitcodeOrgPrs(opts = {}) {
    const org = String(opts.org || 'CPF-Flutter').trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(org)) throw new Error('GitCode 组织名无效');
    const page = Math.min(100000, Math.max(1, Number.parseInt(opts.page, 10) || 1));
    const perPage = Math.min(100, Math.max(1, Number.parseInt(opts.perPage, 10) || 20));
    const state = ['open', 'closed', 'merged'].includes(String(opts.state)) ? String(opts.state) : 'all';
    const search = String(opts.search || '').trim().slice(0, 200);
    const author = String(opts.author || '').trim().slice(0, 100);
    const query = new URLSearchParams({ state, scope: 'all', sort: 'updated', direction: 'desc', page: String(page), per_page: String(perPage) });
    if (search) query.set('search', search);
    if (author) query.set('author', author);
    const payload = await fetchGitcodeJson(`${GITCODE_ORG_API_BASE}/org/${encodeURIComponent(org)}/pull_requests?${query}`, gitcodeApiHeaders());
    if (!Array.isArray(payload)) throw new Error('GitCode 组织 PR 接口返回格式异常');
    const prs = payload.map((item) => normalizeGitcodePr(item, org)).filter((item) => item.number && item.repoFull);
    // 组织列表响应不带 user。按作者查询时 GitCode 已按作者筛过，直接用查询的作者；
    // 逐条读详情会很快触发 GitCode 429，作者补不上，个人部署的列表就会变空。
    if (author) for (const pr of prs) if (!pr.author) pr.author = author;
    // 其余缺 title/user 的条目只补当前页详情，最多 4 个并发。
    let cursor = 0;
    const enrichWorker = async () => {
        while (cursor < prs.length) {
            const index = cursor++;
            const pr = prs[index];
            if (pr.title && pr.author) continue;
            try {
                const [owner, repoName] = pr.repoFull.split('/');
                const detail = await fetchGitcodeJson(
                    `${GITCODE_ORG_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls/${encodeURIComponent(pr.number)}`,
                    gitcodeApiHeaders(),
                );
                const enriched = normalizeGitcodePr(detail, owner);
                prs[index] = {
                    ...pr,
                    ...enriched,
                    repo: pr.repo,
                    repoFull: pr.repoFull,
                    visibilityReason: pr.visibilityReason || enriched.visibilityReason,
                    labels: pr.labels.length ? pr.labels : enriched.labels,
                };
            } catch { /* 详情补充失败时保留组织列表的原始字段，不猜测作者或标题 */ }
        }
    };
    await Promise.all(Array.from({ length: Math.min(4, prs.length) }, () => enrichWorker()));
    return {
        prs,
        page,
        perPage,
        hasMore: payload.length === perPage,
        org,
    };
}

/** 读取组织可访问的代码仓，用于仓库筛选器；目录结果由 fetchOrgCodeRepos 缓存。 */
export async function listGitcodeOrgRepos(org = 'CPF-Flutter', fresh = false, type = 'all') {
    return fetchOrgCodeRepos(String(org || 'CPF-Flutter'), gitcodeApiHeaders(), fresh, type);
}

/** 读取某个组织仓库的单页 PR；该接口不支持 search 参数。 */
export async function listGitcodeRepoPrsPage(repoFull, opts = {}) {
    const [owner, repoName, ...rest] = String(repoFull || '').split('/');
    if (owner?.toLowerCase() !== 'cpf-flutter' || !repoName || rest.length) throw new Error('只支持 CPF-Flutter 组织内的仓库');
    const page = Math.min(100000, Math.max(1, Number.parseInt(opts.page, 10) || 1));
    const perPage = Math.min(100, Math.max(1, Number.parseInt(opts.perPage, 10) || 20));
    const state = ['open', 'closed', 'merged'].includes(String(opts.state)) ? String(opts.state) : 'all';
    const author = String(opts.author || '').trim().slice(0, 100);
    const payload = await fetchPrsPage(owner, repoName, gitcodeApiHeaders(), page, perPage, state, { author });
    if (!Array.isArray(payload)) throw new Error('GitCode 仓库 PR 接口返回格式异常');
    const prs = payload.map((item) => normalizeGitcodePr(item, owner));
    return { prs, page, perPage, hasMore: payload.length === perPage, repo: repoFull };
}

/**
 * 后台扫描单仓 PR。命中页数/时间上限或分页失败时明确返回不完整状态。
 */
async function scanRepoPrs(owner, repoName, headers, previous = []) {
    const startedAt = Date.now();
    let all = [];
    let complete = false;
    let reason = '';
    let nextPage = 1;
    try {
        const first = await fetchPrsPage(owner, repoName, headers, 1);
        if (!Array.isArray(first)) throw new Error('GitCode API 返回格式异常');
        all = [...first];
        nextPage = 2;
        if (first.length < 100) complete = true;
        while (!complete && nextPage <= REPO_PRS_MAX_PAGES) {
            if (Date.now() - startedAt >= REPO_PRS_DEADLINE_MS) {
                reason = `单仓扫描超过 ${REPO_PRS_DEADLINE_MS}ms 时限`;
                break;
            }
            const pages = [];
            for (let page = nextPage; page < Math.min(nextPage + REPO_PRS_BATCH, REPO_PRS_MAX_PAGES + 1); page++) pages.push(page);
            const results = await Promise.all(pages.map((page) => fetchPrsPage(owner, repoName, headers, page)
                .then((value) => ({ value }), (error) => ({ error }))));
            for (const result of results) {
                if (result.error) {
                    reason = `第 ${nextPage} 页失败：${result.error.message}`;
                    break;
                }
                if (!Array.isArray(result.value)) {
                    reason = `第 ${nextPage} 页返回格式异常`;
                    break;
                }
                all.push(...result.value);
                nextPage++;
                if (result.value.length < 100) {
                    complete = true;
                    break;
                }
            }
            if (reason || complete) break;
        }
        if (!complete && !reason) {
            reason = nextPage > REPO_PRS_MAX_PAGES
                ? `达到单仓分页上限（${REPO_PRS_MAX_PAGES} 页）`
                : `单仓扫描超过 ${REPO_PRS_DEADLINE_MS}ms 时限`;
        }
        return { prs: all.length ? all : previous, complete, reason };
    } catch (error) {
        return { prs: previous, complete: false, reason: error.message || '首屏请求失败' };
    }
}

/** 后台有界队列：多个身份共享仓库扫描，不让几百仓同时压到 GitCode API。 */
function fetchRepoPrsAll(owner, repoName, headers, force = false) {
    const key = `${owner}/${repoName}`.toLowerCase();
    let entry = _repoPrsCache.get(key);
    if (!entry) {
        entry = { at: 0, prs: [], complete: false, reason: '', inflight: null };
        _repoPrsCache.set(key, entry);
    }
    if (entry.inflight) return entry.inflight;
    const cacheAge = Date.now() - entry.at;
    const cacheTtl = entry.complete ? REPO_PRS_TTL_MS : REPO_PRS_PARTIAL_RETRY_MS;
    if (!force && entry.at && cacheAge < cacheTtl) return Promise.resolve(entry);

    let resolveScan;
    entry.inflight = new Promise((resolve) => { resolveScan = resolve; });
    const pending = entry.inflight;
    _repoPrsQueue.push(async () => {
        try {
            const result = await scanRepoPrs(owner, repoName, headers, entry.prs);
            entry.prs = result.prs;
            entry.complete = result.complete;
            entry.reason = result.reason;
            entry.at = Date.now();
        } catch (error) {
            entry.complete = false;
            entry.reason = error.message || '扫描失败';
            entry.at = Date.now();
        } finally {
            entry.inflight = null;
            resolveScan(entry);
        }
    });
    pumpRepoPrsQueue();
    return pending;
}

/* ── run 归属仓库识别（runId 只含 PR 编号，仓库需从 state.yaml 的 globalContext 读） ──
 * 同一 run 的仓库不变 → 模块级缓存永久有效；跨仓 PR 编号重叠时这是唯一可靠的区分。
 * 注意 YAML 块样式可能是 >-（折叠）或 |-（字面），两种都要匹配。 */
const _runRepoCache = new Map();  // runId -> repo 短名（如 'flutter_engine'，读失败为 ''）

export function runRepoOf(runId) {
    const id = String(runId || '').trim();
    if (!id) return '';
    if (_runRepoCache.has(id)) return _runRepoCache.get(id);
    let repo = '';
    try {
        const yaml = readFileSync(join(aceRunsDir(), id, 'state.yaml'), 'utf8');
        const gc = /^globalContext:\s*[|>][+-]?\n([\s\S]*?)(?=\n[^\s]|(?![\s\S]))/m.exec(yaml)?.[1] || '';
        const m = /^\s*repo:\s*(\S+)/m.exec(gc);
        repo = m ? m[1] : '';
    } catch { /* run 目录不存在/损坏时返回空 */ }
    _runRepoCache.set(id, repo);
    return repo;
}

export async function listGitcodePrs(opts = {}) {
    const author = String(opts.author || '').trim();
    if (!author) throw new Error('请提供 GitCode 用户名（author）');

    const fresh = opts.fresh === true || opts.fresh === '1';
    const headers = gitcodeApiHeaders();
    const repos = await resolveWatchRepos({ fresh });

    // 列表请求只启动有界后台扫描并返回当前缓存，避免数百仓扫描撑满 HTTP 请求时限。
    const perRepo = repos.map((repoFull) => {
        const [owner, repoName] = repoFull.split('/');
        const pending = fetchRepoPrsAll(owner, repoName, headers, fresh);
        void pending.catch(() => {});
        const entry = _repoPrsCache.get(`${repoFull}`.toLowerCase());
        const complete = Boolean(entry?.at && entry.complete && !entry.inflight && Date.now() - entry.at < REPO_PRS_TTL_MS);
        const reason = complete ? '' : (entry?.inflight ? '后台扫描中' : (entry?.reason || '等待扫描'));
        return {
            repoFull,
            repoName,
            all: entry?.prs || [],
            complete,
            reason,
            status: complete ? 'complete' : (entry?.inflight ? 'scanning' : (entry?.at ? 'partial' : 'queued')),
        };
    });

    // 按作者过滤（GitCode pulls 列表接口不支持 author 筛选参数）。
    // 大小写不敏感：令牌 key 存的是小写化 login（saveGitcodeToken 的 GITCODE_TOKEN_<lowercase>），
    // 而 GitCode 返回的 login 保留真实大小写（如 AndCJ），精确匹配会导致用户看不到自己的 PR。
    const authorLower = author.toLowerCase();
    const merged = [];
    for (const { repoFull, repoName, all } of perRepo) {
        for (const p of (author === '*' ? all : all.filter(p => String(p?.user?.login || '').toLowerCase() === authorLower))) {
            merged.push({
                number: p.number,
                title: p.title || '',
                state: p.merged ? 'merged' : (p.state || 'open'),
                author: p.user?.login || '',
                headRef: p.head?.ref || '',
                baseRef: p.base?.ref || '',
                headSha: p.head?.sha || '',
                headRepo: p.head?.repo?.full_name || '',
                htmlUrl: p.html_url || `https://gitcode.com/${repoFull}/merge_requests/${p.number}`,
                createdAt: p.created_at || '',
                updatedAt: p.updated_at || '',
                repo: repoName,
                repoFull,
                // DCP 门禁标签（AI已检视/DCO/静态/编译/冒烟）：GitCode 原生字段直接透传，前端按门禁五类渲染
                labels: Array.isArray(p.labels)
                    ? p.labels.map(l => (typeof l === 'string' ? l : String(l?.name || '')).trim()).filter(Boolean)
                    : [],
            });
        }
    }
    merged.sort((a, b) => (parseInt(b.number, 10) || 0) - (parseInt(a.number, 10) || 0));

    const incompleteRepos = perRepo.filter((item) => !item.complete).map((item) => ({
        repo: item.repoFull,
        status: item.status,
        reason: item.reason,
    }));
    return { prs: merged, repo: repos[0], repos, author, complete: incompleteRepos.length === 0, incompleteRepos };
}

/**
 * 人工开启 PR 监控：以用户身份调 AceHarness /api/workflow/start
 * globalContext 格式与 webhook 自动启动完全一致（formatPrReviewContext），
 * run 归属该用户（ownerId），非管理员在 run-history 只见自己的。
 * @param {string} token - 用户 AceHarness token
 * @param {object} pr - { owner, repo, number, title, author, headRef, baseRef, headSha, headRepo, state }
 * @returns {Promise<{runId: string}>}
 */
export async function startPrMonitor(token, pr) {
    const owner = String(pr?.owner || '').trim();
    const repo = String(pr?.repo || '').trim();
    const number = String(pr?.number || '').trim();
    if (!owner || !repo || !/^\d+$/.test(number)) {
        throw new Error('PR 参数不完整（需要 owner/repo/number）');
    }

    const prUrl = `https://gitcode.com/${owner}/${repo}/merge_requests/${number}`;
    // manual-start-by：标记本次监控由该 GitCode 身份的用户在 AIWeb 手动开启。
    // 工作流的白名单校验（own_pr）据此豁免——改为校验"PR 作者 = 手动开启者本人"，
    // 让任何登录用户都能监控自己的 PR（白名单仍约束 webhook 自动启动）。
    const globalContext = [
        'GitCode 自己的 PR 自修任务',
        'event: manual',
        'action: open',
        `pr_url: ${prUrl}`,
        `owner: ${owner}`,
        `repo: ${repo}`,
        `number: ${number}`,
        `title: ${pr.title || ''}`,
        `state: ${pr.state || 'open'}`,
        `head_ref: ${pr.headRef || ''}`,
        `head_repo: ${pr.headRepo || ''}`,
        `base_ref: ${pr.baseRef || ''}`,
        `head_sha: ${pr.headSha || ''}`,
        `author: ${pr.author || ''}`,
        `manual-start-by: ${pr.author || ''}`,
        pr.policyVersion ? `policy_version: ${pr.policyVersion}` : '',
    ].filter(Boolean).join('\n');

    const safeNum = number.replace(/[^0-9A-Za-z_-]/g, '');
    const runId = `run-${Date.now()}-pr${safeNum}-${Math.random().toString(16).slice(2, 10)}`;

    const result = await httpRequest('POST', '/api/workflow/start', {
        configFile: PR_REVIEW_CONFIG_FILE,
        runId,
        skipPreflight: true,
        initialContexts: { globalContext, phaseContexts: {} },
    }, { token, timeoutMs: 60000 });

    if (result.status !== 200) {
        const msg = result.data?.error || result.data?.message || `启动失败（HTTP ${result.status}）`;
        throw new Error(String(msg).slice(0, 300));
    }
    return { runId: result.data?.runId || runId, prUrl };
}

/**
 * R08：读取某仓库/分支生效的修复策略与版本（只读，供把策略版本写入运行记录）。
 * @returns {Promise<{version: string, policy: object, scope: string}|null>}
 */
export async function getPrReviewPolicy(token, owner, repo, branch = '') {
    const qs = `owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`;
    try {
        const r = await httpRequest('GET', `/api/gitcode/policy?${qs}`, null, { token, timeoutMs: 4000 });
        if (r.status !== 200) return null;
        return r.data || null;
    } catch {
        return null;
    }
}

/**
 * 人工关闭 PR 监控：调 AceHarness /api/workflow/stop
 * 对内存中运行的 run 执行停止；对已死（crashed 等）的 run 做兜底状态清理。
 * @param {string} token - 用户 AceHarness token
 * @param {string} runId
 * @returns {Promise<{message: string, runIds: string[]}>}
 */
export async function stopPrMonitor(token, runId) {
    if (!runId) throw new Error('缺少 runId');
    // 停止涉及子进程清理（killAllSystem），耗时不稳定，给足超时
    const result = await httpRequest('POST', '/api/workflow/stop', { runId, configFile: PR_REVIEW_CONFIG_FILE }, { token, timeoutMs: 90000 });
    if (result.status !== 200) {
        const msg = result.data?.error || result.data?.message || `停止失败（HTTP ${result.status}）`;
        throw new Error(String(msg).slice(0, 300));
    }
    return { message: result.data?.message || '已停止', runIds: result.data?.runIds || [] };
}

/**
 * 删除一个 run（AceHarness 会先停掉运行中的实例再删目录）
 * 用于"一个 PR 只保留一个任务"：重新开启监控前清理旧的终态 run
 * @param {string} token
 * @param {string} runId
 */
export async function deletePrRun(token, runId) {
    if (!runId) throw new Error('缺少 runId');
    const result = await httpRequest('DELETE', `/api/runs/${encodeURIComponent(runId)}/delete`, null, { token, timeoutMs: 60000 });
    if (result.status !== 200) {
        const msg = result.data?.error || result.data?.message || `删除失败（HTTP ${result.status}）`;
        throw new Error(String(msg).slice(0, 300));
    }
    return { message: result.data?.message || '已删除' };
}

/* ── 用户 GitCode 令牌管理（存 AceHarness per-user env，工作流按 PR 作者自动匹配） ── */

const GITCODE_TOKEN_KEY_RE = /^(GITCODE_TOKEN|ACE_GITCODE_TOKEN|GITCODE_ACCESS_TOKEN)_[A-Za-z0-9_]+$/;

function maskToken(value) {
    const s = String(value || '');
    if (s.length <= 8) return s ? '****' : '';
    return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** 从 GITCODE_TOKEN_<login> 提取 GitCode 用户名 */
function authorFromKey(key) {
    return String(key || '').replace(/^(GITCODE_TOKEN|ACE_GITCODE_TOKEN|GITCODE_ACCESS_TOKEN)_/, '');
}

/**
 * 查询当前用户已配置的 GitCode 令牌（脱敏）
 * @param {string} token - 用户 AceHarness token
 * @returns {Promise<{configured: boolean, tokens: Array<{key,gitcodeUsername,masked,enabled}>}>}
 */
const credentialViews = new Map();
export async function getGitcodeTokens(token) {
    const cacheKey = createHash('sha256').update(token).digest('hex');
    const cached = credentialViews.get(cacheKey);
    if (cached && Date.now() - cached.at < 15000) return cached.value;
    const result = await httpRequest('GET', '/api/env?scope=user', null, { token, timeoutMs: 1500 });
    if (result.status !== 200) {
        throw new Error(`查询环境变量失败（HTTP ${result.status}）`);
    }
    const vars = (result.data?.vars || []).filter(v => GITCODE_TOKEN_KEY_RE.test(v?.key) && v.enabled !== false);
    const value = {
        configured: vars.length > 0,
        tokens: vars.map(v => ({
            credentialFingerprint: createHash('sha256').update(String(v.value || '')).digest('hex').slice(0, 16),
            key: v.key,
            gitcodeUsername: authorFromKey(v.key),
            masked: maskToken(v.value),
            enabled: !!v.enabled,
        })),
    };
    if (credentialViews.size > 500) credentialViews.clear();
    credentialViews.set(cacheKey, { at: Date.now(), value });
    return value;
}

/**
 * 校验 GitCode 令牌并保存到用户的 per-user env
 * 令牌键名按 GitCode 返回的 login 生成（GITCODE_TOKEN_<login>），
 * 工作流按 PR 作者名自动匹配。
 * @param {string} token - 用户 AceHarness token
 * @param {string} gitcodeToken - GitCode 个人访问令牌
 * @returns {Promise<{gitcodeUsername: string}>}
 */
export async function saveGitcodeToken(token, gitcodeToken, options = {}) {
    const value = String(gitcodeToken || '').trim();
    if (!value) throw new Error('令牌不能为空');

    // 校验令牌：GitCode /user 返回该令牌对应的账号 login
    let login = '';
    try {
        const resp = await fetch(`${process.env.GITCODE_API_ROOT || 'https://gitcode.com/api/v5'}/user`, {
            headers: { Authorization: `Bearer ${value}` },
            signal: AbortSignal.timeout(10000),
        });
        if (resp.status === 401) throw new Error('令牌无效（GitCode 返回 401），请检查后重试');
        if (resp.status !== 200) throw new Error(`令牌校验失败（HTTP ${resp.status}）`);
        const user = await resp.json();
        login = String(user?.login || '').trim();
        if (!login) throw new Error('令牌校验成功但未返回用户名，请重试');
    } catch (e) {
        if (e.name === 'TimeoutError') throw new Error('GitCode 接口超时，请稍后重试');
        throw e;
    }

    // upsert 到用户的 env vars（保留该用户已有的其他变量）
    const key = `GITCODE_TOKEN_${login.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
    const current = await httpRequest('GET', '/api/env?scope=user', null, { token });
    if (current.status !== 200) {
        throw new Error(`读取环境变量失败（HTTP ${current.status}）`);
    }
    const vars = current.data?.vars || [];
    const existing = vars.find(v => GITCODE_TOKEN_KEY_RE.test(v?.key));
    const next = vars.filter(v => v?.key !== existing?.key);
    next.push({ key, value, enabled: true });

    const save = await httpRequest('PUT', '/api/env', { scope: 'user', vars: next }, { token });
    if (save.status !== 200) {
        throw new Error(save.data?.error || `保存失败（HTTP ${save.status}）`);
    }

    // R02：保存成功后按需做一次只读能力探测（不推送、不评论），结果供页面展示。
    // 令牌已更换：先清空该身份的旧能力缓存，再用新令牌探测目标仓库。
    let capabilities = null;
    const fingerprint = createHash('sha256').update(value).digest('hex').slice(0, 16);
    const owner = String(options?.owner || '').trim();
    const repo = String(options?.repo || '').trim();
    credentialViews.clear();
    clearCapabilitiesForLogin(login);
    if (owner && repo) {
        try {
            capabilities = await probeGitcodeCapabilities(value, owner, repo);
            saveCapabilities(login, owner, repo, capabilities, fingerprint);
        } catch (e) {
            logger.warn('GitCode 能力探测失败（不影响令牌保存）', { login, error: e.message });
        }
    }
    return { gitcodeUsername: login, key, capabilities };
}

/**
 * 清除当前用户的 GitCode 令牌（只允许删 GITCODE_TOKEN_* 前缀）
 * @param {string} token
 * @returns {Promise<{removed: string[]}>}
 */
export async function clearGitcodeToken(token) {
    const current = await httpRequest('GET', '/api/env?scope=user', null, { token });
    if (current.status !== 200) {
        throw new Error(`读取环境变量失败（HTTP ${current.status}）`);
    }
    const vars = current.data?.vars || [];
    const removed = vars.filter(v => GITCODE_TOKEN_KEY_RE.test(v?.key)).map(v => v.key);
    if (!removed.length) return { removed: [] };
    const next = vars.filter(v => !GITCODE_TOKEN_KEY_RE.test(v?.key));
    const save = await httpRequest('PUT', '/api/env', { scope: 'user', vars: next }, { token });
    if (save.status !== 200) {
        throw new Error(save.data?.error || `清除失败（HTTP ${save.status}）`);
    }
    credentialViews.clear();
    for (const key of removed) clearCapabilitiesForLogin(authorFromKey(key));
    return { removed };
}

/**
 * 读取当前用户已配置的 GitCode 令牌原文（仅供服务端做只读能力探测，绝不返回给前端）。
 * @param {string} token - 用户 AceHarness token
 * @returns {Promise<Array<{key:string,login:string,value:string}>>}
 */
export async function getGitcodeTokenValues(token) {
    const result = await httpRequest('GET', '/api/env?scope=user', null, { token, timeoutMs: 1500 });
    if (result.status !== 200) {
        throw new Error(`查询环境变量失败（HTTP ${result.status}）`);
    }
    return (result.data?.vars || [])
        .filter(v => GITCODE_TOKEN_KEY_RE.test(v?.key) && v.enabled !== false)
        .map(v => ({ key: v.key, login: authorFromKey(v.key), value: String(v.value || '') }));
}
