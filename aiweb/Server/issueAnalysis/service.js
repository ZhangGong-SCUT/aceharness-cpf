/**
 * Issue 分析 — 业务服务层（AceHarness 代理模式）
 *
 * 职责：
 *  1. 接收前端 Issue URL，创建本地任务记录（taskId ↔ runId 映射）
 *  2. 调用 AceHarness /api/workflow/start 启动工作流
 *  3. 提供状态查询接口，代理到 AceHarness /api/workflow/status
 *  4. 提供报告/步骤输出读取接口，代理到 AceHarness /api/runs/{runId}/outputs
 *
 * 本系统不存储任何分析产物，所有数据实时从 AceHarness 获取。
 */

import { aceDataDir, aceRunsDir, aceRuntimeRoot } from '../library/aceRuntime.js';
import { isIsolatedRunDir, readWorkingDirectory } from '../library/runPath.js';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { singleFlight } from './singleFlight.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { HybridTaskStore } from '../library/HybridTaskStore.js';
import { STAGE, TERMINAL_STAGES } from '../orchestrator/stages.js';
import { createLogger } from '../library/logger.js';
import config from '../library/config.js';

import {
    parseIssueUrl,
    isValidIssueUrl,
    startWorkflow,
    resumeWorkflow,
    stopWorkflow,
    getWorkflowStatusCompact,
    getWorkflowStatusFull,
    getStepOutput,
    listRunOutputs,
    getOutputByRef,
    getDiagnosisReport,
    httpRequest,
    getServiceToken,
} from './aceHarnessClient.js';
import { getPersistedIssueRun } from './runRecovery.js';
import { createTerminalStatusCache } from './statusSnapshots.js';
import { listArtifactsCached, invalidateArtifactSummary } from './artifactSummaryCache.js';
import { listRunArtifacts, readRunArtifact } from './artifacts.js';
import { resolveTerminalTimes } from './terminalTimes.js';
import { EVALUATION_MODES, writeIssueSnapshot } from './snapshotInput.js';
import { computeChainMetrics } from './chainMetrics.js';

import { createFailureRecoveryService } from './failureRecoveryService.js';

const logger = createLogger('IssueAnalysisService');

// ─── HybridTaskStore 单例 ────────────────────────────────────────────────────

let _store = null;
function getStore() {
    if (!_store) {
        _store = new HybridTaskStore('issueanalysis.db');
        _store.initialize();
    }
    return _store;
}

function getFailureRecovery() {
    if (!getFailureRecovery.service) {
        getFailureRecovery.service = createFailureRecoveryService({
            store: getStore(), aceConfigFile: config.aceharness.configFile,
            resumeWorkflow, singleFlight, stageAnalyzing: STAGE.ISSUEANALYSIS_ANALYZING, logger,
        });
    }
    return getFailureRecovery.service;
}

// ─── AceHarness 状态 → 本地 stage 映射 ────────────────────────────────────────

const ACEHARNESS_STATUS_TO_STAGE = {
    idle:       STAGE.ISSUEANALYSIS_PENDING,
    preparing:  STAGE.ISSUEANALYSIS_FETCHING,
    running:    STAGE.ISSUEANALYSIS_ANALYZING,
    paused:     STAGE.ISSUEANALYSIS_ANALYZING,  // 暂停仍视为分析中
    completed:  STAGE.ISSUEANALYSIS_COMPLETE,
    failed:     STAGE.FAILED,
    crashed:    STAGE.FAILED,
    stopped:    'cancelled',
};

/**
 * 将 AceHarness 的状态响应映射为本地 stage
 */
function mapAceHarnessStatus(ahStatus) {
    if (!ahStatus?.status) return STAGE.ISSUEANALYSIS_PENDING;
    return ACEHARNESS_STATUS_TO_STAGE[ahStatus.status] || STAGE.ISSUEANALYSIS_ANALYZING;
}

// ─── 查询可用性与运行存在性判定（R03：查询失败不得落终态） ─────────────────────

/** 网络/超时/服务不可用等“查询暂不可用”类错误——保留最近状态，不写终态。 */
function _isTransientQueryError(err) {
    const msg = String(err?.message || err || '');
    return /超时|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network|不可用|HTTP 5\d\d|502|503|504/i.test(msg);
}

/** 读取任务的 queryHealth（存在 metadata 里，避免新增数据库列）。 */
function _readQueryHealth(task) {
    try {
        const metadata = _metadata(task);
        return metadata.queryHealth || null;
    } catch {
        return null;
    }
}

/** 把查询健康信息写入 metadata（合并保留历史字段，失败不阻断主流程）。 */
function _patchQueryHealth(store, task, patch) {
    try {
        const metadata = _metadata(task);
        const prev = metadata.queryHealth || {};
        const now = new Date().toISOString();
        const queryHealth = patch === null
            ? { ...prev, error: null, lastAttemptAt: now, lastSuccessAt: now }
            : { ...prev, ...patch, lastAttemptAt: now };
        const next = { ...metadata, queryHealth };
        store.patch(task.taskId, { metadata: next });
    } catch (e) {
        logger.warn('写入查询健康信息失败', { taskId: task.taskId, error: e.message });
    }
}

// ─── 启动任务 ──────────────────────────────────────────────────────────────

function _metadata(task) {
    try { return typeof task?.metadata === 'string' ? JSON.parse(task.metadata) : task?.metadata || {}; }
    catch { return {}; }
}

function _requestKey(parts) {
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function _activeRequestCandidates(key) {
    return getStore().list().filter(task => !TERMINAL_STAGES.has(task.stage) && _metadata(task).requestKey === key);
}

// F08 引擎对账：本地"活跃"记录可能是陈旧的（引擎已终态/重启丢 run），复用前必须核实

async function _activeRequest(key) {
    for (const task of _activeRequestCandidates(key)) {
        const metadata = _metadata(task);
        const runId = metadata.runId || task.analysisSessionId;
        if (!runId) {
            // 尚未拿到 runId 的记录只在创建后很短时间内可信（dispatch 中断的孤儿占位不得永久拦截重提）
            const ageMs = Date.now() - new Date(task.createdAt || 0).getTime();
            if (Number.isFinite(ageMs) && ageMs < 2 * 60 * 1000) return task;
            continue;
        }
        try {
            const status = await getWorkflowStatusCompact(runId, metadata.configFile || config.aceharness.configFile);
            if (status?.runId && status.runId !== runId) return task;
            // A09：crashed 也是终态（状态映射已将其归为 failed），不能当作活跃任务继续复用。
            if (!status?.status || !['completed', 'failed', 'stopped', 'crashed'].includes(status.status)) return task;
            // 引擎已终态或查无此 run：本地记录陈旧，不复用（stage 由状态轮询自愈修正）
        } catch {
            return task; // 引擎查询失败时保守复用，避免重复提交
        }
    }
    return null;
}

async function _dispatchTask(taskId, configFile, globalContext, metadata = {}) {
    const store = getStore();
    const runId = `run-${Date.now()}-ia-${crypto.randomBytes(4).toString('hex')}`;
    // F03：合并而非替换——保留创建时写入的 inputMode/inputSha256/evaluationMode 等审计字段
    const receipt = { ..._metadata(store.get(taskId)), ...metadata, runId, configFile, startState: 'dispatching' };
    store.patch(taskId, { analysisSessionId: runId, metadata: receipt });
    try {
        const result = await startWorkflow({ runId, configFile, globalContext });
        if (result.runId !== runId) throw new Error('引擎返回的运行 ID 与启动回执不一致，请等待对账');
        const latest = store.get(taskId);
        const latestMetadata = _metadata(latest);
        store.patch(taskId, { stage: latest.stage === STAGE.ISSUEANALYSIS_PENDING ? STAGE.ISSUEANALYSIS_FETCHING : latest.stage,
            metadata: { ...latestMetadata, startState: latestMetadata.startState === 'confirmed' ? 'confirmed' : 'accepted', frontendSessionId: result.frontendSessionId },
            updatedAt: new Date().toISOString() });
        return { runId, frontendSessionId: result.frontendSessionId };
    } catch (error) {
        const latestMetadata = _metadata(store.get(taskId));
        // A concurrent status lookup may have already confirmed execution.
        if (latestMetadata.startState === 'confirmed') return { runId, frontendSessionId: latestMetadata.frontendSessionId || null };
        if (error.definitelyNotStarted) {
            store.patch(taskId, { stage: STAGE.FAILED, error: error.message,
                metadata: { ...latestMetadata, startState: 'rejected' }, finishedAt: new Date().toISOString() });
            throw error;
        }
        // A lost response is not proof of rejection. Keep the preallocated run and never replay POST.
        store.patch(taskId, { metadata: { ...latestMetadata, startState: 'uncertain', startError: error.message },
            updatedAt: new Date().toISOString() });
        return { runId, frontendSessionId: null, startPending: true };
    }
}

/**
 * 启动 Issue 分析任务
 * @param {object} opts
 * @param {string} opts.issueUrl - Issue URL
 * @param {string} [opts.accessToken] - GitCode/GitHub Token（注入到 globalContext）
 * @param {string} [opts.priority] - 优先级
 * @param {string} [opts.issueType] - Issue 类型
 * @param {string} [opts.configFile] - AceHarness 工作流配置文件
 * @returns {Promise<{taskId: string, runId: string, dirName: string}>}
 */
export async function startIssueAnalysis(opts) {
    const { issueUrl, accessToken, priority, issueType, configFile, ownerUsername, issueContent, evaluationMode } = opts;
    if (!issueUrl) throw new Error('缺少 issueUrl');
    if (!isValidIssueUrl(issueUrl)) {
        throw new Error('Issue URL 格式无效（仅支持 gitcode/github/gitee，形如 /owner/repo/issues/123）');
    }
    // F03：快照输入（盲测/受控回放）。issueUrl 仍必填以确定仓库身份；
    // 快照仅固定输入；未有执行隔离时只能进行 guided_replay。
    let snapshot = null;
    let effectiveEvaluationMode = null;
    if (issueContent != null && issueContent !== '') {
        snapshot = writeIssueSnapshot(issueContent);
        effectiveEvaluationMode = evaluationMode || 'guided_replay';
    } else if (evaluationMode) {
        effectiveEvaluationMode = evaluationMode;
    }
    if (effectiveEvaluationMode && !EVALUATION_MODES.has(effectiveEvaluationMode)) {
        throw new Error(`evaluationMode 无效（可选：${[...EVALUATION_MODES].join('/')}）`);
    }
    // F03 闭环：声明 blind_eval 却不给快照，会静默退回线上采集——必须拒绝而不是放行
    if (effectiveEvaluationMode === 'blind_eval' && !snapshot) {
        throw new Error('blind_eval 模式必须提供 issueContent 快照（否则将退回线上实时采集，评估不可复现）');
    }

    if (effectiveEvaluationMode === 'blind_eval') throw new Error('blind_eval 暂不可用：执行器尚未隔离答案文件、未来 Git 历史和网络；可使用 guided_replay 演练，不计独立盲测成绩');

    const meta = parseIssueUrl(issueUrl);
    // A02：用户指定配置必须命中服务端白名单（纯文件名，禁止路径分隔符），
    // 防止借服务身份启动任意工作流；未指定时用默认诊断配置。
    let effectiveConfigFile = configFile || config.aceharness.configFile;
    if (configFile != null) {
        if (typeof configFile !== 'string'
            || /[\\/]|\.\./.test(configFile)
            || !config.aceharness.allowedDiagnosisConfigFiles.includes(configFile.trim())) {
            throw new Error(`不允许使用该工作流配置（仅限：${config.aceharness.allowedDiagnosisConfigFiles.join(' / ')}）`);
        }
        effectiveConfigFile = configFile.trim();
    }
    // F03/F08 修复 _activeRequest 复用：同一 URL 以不同输入（线上/各快照/各评估模式）提交不得互相复用
    const requestKey = _requestKey([ownerUsername || '', meta, effectiveConfigFile, issueType || '',
        snapshot?.sha256 || 'live', effectiveEvaluationMode || 'default']);
    return singleFlight(requestKey, async () => {
        const existing = await _activeRequest(requestKey);
        if (existing) return { taskId: existing.taskId, runId: existing.analysisSessionId, dirName: existing.dirName,
            frontendSessionId: _metadata(existing).frontendSessionId || null };
        const taskId = `ia-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const dirName = `issueanalysis-${meta.owner}__${meta.repo}-${meta.issueNumber}-${crypto.randomBytes(2).toString('hex')}`;
        const now = new Date().toISOString();

        // 1. 创建本地任务记录
        const store = getStore();
        store.create({
            taskId,
            cliType: 'aceharness',
            stage: STAGE.ISSUEANALYSIS_PENDING,
            issueUrl,
            issueType: issueType || null,
            dirName,
            accessToken: accessToken || null,
            priorityLevel: priority || null,
            ownerUsername: ownerUsername || null,
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            metadata: { requestKey, configFile: effectiveConfigFile,
                // F03：记录最终生效输入，可审计、可复核
                inputMode: snapshot ? 'snapshot' : 'live', evaluationIntegrity: 'not_independent',
                inputSha256: snapshot?.sha256 || null,
                evaluationMode: effectiveEvaluationMode || null },
    });
    logger.info('Issue 分析任务已创建', { taskId, issueUrl, dirName, inputMode: snapshot ? 'snapshot' : 'live' });

    // 2. 调用 AceHarness 启动工作流
    const globalContext = [
        `issue-url: ${issueUrl}`,
        `issue-platform: ${meta.platform}`,
        `issue-owner: ${meta.owner}`,
        `issue-repo: ${meta.repo}`,
        `issue-number: ${meta.issueNumber}`,
        accessToken ? `access-token: ${accessToken}` : '',
        priority ? `priority: ${priority}` : '',
        issueType ? `issue-type: ${issueType}` : '',
        snapshot ? `issue-snapshot-path: ${snapshot.path}` : '',
        snapshot ? `issue-snapshot-sha256: ${snapshot.sha256}` : '',
        effectiveEvaluationMode ? `evaluation-mode: ${effectiveEvaluationMode}` : '',
    ].filter(Boolean).join('\n');

    const result = await _dispatchTask(taskId, effectiveConfigFile, globalContext, { requestKey });
    return { taskId, dirName, ...result };
    });
}

// ─── 用户反馈迭代（fork 继承式：从方案设计阶段重新收敛） ─────────────────────

/**
 * run 丢失原因描述（同机判定，区分两种症状）：
 * - run 目录存在但无 state.yaml → run 从未真正启动（引擎运行前校验未通过 / 启动异常，
 *   AceHarness 启动接口为异步发射后不管，失败只写服务日志 "[Workflow] start failed"）
 * - run 目录不存在 / 有 state.yaml → 内存 Manager 丢失（服务重启或目录被清理）
 */
function _describeRunLoss(runId) {
    const fallback = `AceHarness run ${runId} 已丢失（服务可能已重启）`;
    try {
        const runDir = join(aceRunsDir(), runId);
        if (existsSync(runDir) && !existsSync(join(runDir, 'state.yaml'))) {
            return `AceHarness run ${runId} 启动失败（引擎运行前校验未通过或启动异常，详见 AceHarness 服务日志 "[Workflow] start failed"）`;
        }
        return fallback;
    } catch {
        return fallback;
    }
}


/** 反馈迭代专用工作流配置 */
const ITERATE_CONFIG_FILE = 'cpf-ohos-diagnosis-iterate.yaml';

/** 用户反馈长度限制 */
const MAX_FEEDBACK_LENGTH = 10000;

/**
 * 提交用户反馈，fork 出反馈迭代任务（不全量重跑）
 *
 * 继承原 run：Issue 元信息、复现 Demo（引用原 run 目录）、根因结论、冻结黄金标志。
 * 用户反馈注入方案设计阶段作为特权约束（仍需过质疑/裁决/真机验证）。
 *
 * @param {string} parentTaskId - 原任务 ID（须为终态）
 * @param {string} feedback - 用户修改意见
 * @returns {Promise<{taskId: string, runId: string, parentTaskId: string}>}
 */
export async function submitFeedback(parentTaskId, feedback) {
    const text = String(feedback || '').trim();
    if (!text) throw new Error('反馈内容不能为空');
    if (text.length > MAX_FEEDBACK_LENGTH) {
        throw new Error(`反馈内容过长（${text.length} 字符，上限 ${MAX_FEEDBACK_LENGTH}）`);
    }

    const store = getStore();
    const parent = store.get(parentTaskId);
    if (!parent) throw new Error(`父任务不存在：${parentTaskId}`);
    if (!TERMINAL_STAGES.has(parent.stage)) {
        throw new Error(`父任务未结束（当前状态 ${parent.stage}），只有终态任务才能提交反馈`);
    }
    if (!parent.issueUrl) throw new Error('父任务缺少 issueUrl，无法迭代');
    if (!parent.analysisSessionId) throw new Error('父任务缺少 runId（analysisSessionId），无法定位原 run 产物');

    const meta = parseIssueUrl(parent.issueUrl);
    const parentRunId = parent.analysisSessionId;
    let parentRunDir = join(homedir(), parentRunId);
    try {
        const state = readFileSync(join(aceRunsDir(), parentRunId, 'state.yaml'), 'utf8');
        const recorded = readWorkingDirectory(state);
        if (isIsolatedRunDir(recorded, parentRunId)) parentRunDir = recorded;
    } catch { /* old runs retain the original home/runId layout */ }
    const requestKey = _requestKey([parent.ownerUsername || '', parentTaskId, text, ITERATE_CONFIG_FILE]);
    return singleFlight(requestKey, async () => {
        const existing = await _activeRequest(requestKey);
        if (existing) return { taskId: existing.taskId, runId: existing.analysisSessionId, parentTaskId };

        // 原 run 工作目录已不存在时（如被清理），上下文装载会 fail 终止——这里提前校验给用户直接反馈
        if (!existsSync(parentRunDir)) {
            throw new Error(`原 run 工作目录已不存在（${parentRunId}），无法继承上下文。请重新提交完整诊断。`);
        }

        // 组装迭代 globalContext：issue 元信息 + 继承锚点 + 用户反馈
        const globalContext = [
            `issue-url: ${parent.issueUrl}`,
            `issue-platform: ${meta.platform}`,
            `issue-owner: ${meta.owner}`,
            `issue-repo: ${meta.repo}`,
            `issue-number: ${meta.issueNumber}`,
            parent.accessToken ? `access-token: ${parent.accessToken}` : '',
            'iterate-mode: true',
            `parent-run-id: ${parentRunId}`,
            `parent-run-dir: ${parentRunDir}`,
            `parent-task-id: ${parentTaskId}`,
            'user-feedback: |',
            ...text.split('\n').map(l => `  ${l}`),
        ].filter(Boolean).join('\n');

        // 创建本地迭代任务（挂迭代链）
        const taskId = `ia-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const now = new Date().toISOString();
        store.create({
            taskId,
            cliType: 'aceharness',
            stage: STAGE.ISSUEANALYSIS_PENDING,
            issueUrl: parent.issueUrl,
            issueType: parent.issueType ?? null,
            dirName: parent.dirName,
            accessToken: parent.accessToken ?? null,
            priorityLevel: parent.priorityLevel ?? null,
            parentTaskId,
            userFeedback: text,
            ownerUsername: parent.ownerUsername ?? null,  // 迭代任务继承提交人（身份隔离）
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            metadata: { requestKey, configFile: ITERATE_CONFIG_FILE, parentRunId },
    });
    const result = await _dispatchTask(taskId, ITERATE_CONFIG_FILE, globalContext, { requestKey, parentRunId });
    logger.info('用户反馈迭代任务已创建', {
        taskId, parentTaskId, runId: result.runId, feedbackLength: text.length,
    });

    return { taskId, runId: result.runId, parentTaskId };
    });
}

/**
 * 查询任务的迭代链（沿 parentTaskId 向上追溯到根，再向下展开全部轮次）
 * @param {string} taskId
 * @returns {{ rootTaskId: string, iterations: Array<object> }}
 */
export function getIterationChain(taskId) {
    const store = getStore();
    let current = store.get(taskId);
    if (!current) return null;

    // 向上找根
    const chain = [];
    let guard = 0;
    while (current && guard++ < 20) {
        chain.unshift(current);
        if (!current.parentTaskId) break;
        current = store.get(current.parentTaskId);
    }

    // 从根向下展开全部后代
    // A11：向下展开走持久化层 listByParent 查询——重启后已完成任务不在内存缓存里，
    // 用内存 list() 会在根处截断，导致历史迭代轮次缺失。
    const root = chain[0];
    const out = [root];
    const walk = (pid) => {
        for (const child of store.listByParent(pid)) {
            out.push(child);
            walk(child.taskId);
        }
    };
    walk(root.taskId);

    return {
        rootTaskId: root.taskId,
        iterations: out.map(t => ({
            taskId: t.taskId,
            parentTaskId: t.parentTaskId ?? null,
            stage: t.stage,
            isUserRound: Boolean(t.parentTaskId),
            userFeedback: t.userFeedback ?? null,
            runId: t.analysisSessionId ?? null,
            createdAt: t.createdAt,
            finishedAt: t.finishedAt ?? null,
        })),
    };
}

// ─── 状态查询（代理到 AceHarness） ────────────────────────────────────────────

/** 沿 parentTaskId 向上找到迭代链根任务 ID（深度上限防环） */
function _iterationRoot(task) {
    const store = getStore();
    let current = task;
    let guard = 0;
    while (current?.parentTaskId && guard++ < 20) {
        const parent = store.get(current.parentTaskId);
        if (!parent) break;
        current = parent;
    }
    return current ? current.taskId : null;
}

/**
 * 查询任务状态（合并本地元数据 + AceHarness 实时状态）
 * @param {string} taskId
 * @returns {Promise<object>}
 */
export async function getTaskStatus(taskId) { return queryTaskStatus(taskId, false); }
export async function getTaskFullStatus(taskId) { return queryTaskStatus(taskId, true); }

// ─── F09：诊断链健康与指标（与 PortingOrchestrator 队列分开统计） ────────────

async function _probeAceHarness() {
    try {
        const token = await getServiceToken();
        const r = await httpRequest('GET', '/api/auth/me', null, { token, timeoutMs: 3000 });
        return { ok: r.status === 200, status: r.status, target: 'ACEHarness API（/api/auth/me，含令牌链路）' };
    } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 200), target: 'ACEHarness API（/api/auth/me，含令牌链路）' };
    }
}

async function _probeOpencodeCli() {
    const { execFile } = await import('node:child_process');
    const which = await new Promise((resolve) => {
        execFile('which', ['opencode'], { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
    });
    const vendored = existsSync(join(homedir(), '.opencode/bin/opencode'))
        ? join(homedir(), '.opencode/bin/opencode') : null;
    // 与 ACEHarness SDK 包装器一致：诊断链真正依赖的是"可 spawn 的 CLI"（按需随机端口起服务）
    return { ok: !!(which || vendored), path: which || vendored, target: 'opencode CLI（SDK 按需 spawn，随机端口）' };
}

async function _probeOpencodeServe() {
    const http = await import('node:http');
    const port = config.opencode?.port || '4096';
    const ok = await new Promise((resolve) => {
        const req = http.request({ host: 'localhost', port, path: '/', method: 'GET', timeout: 2000 }, (res) => {
            res.resume();
            resolve(res.statusCode < 500);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
        req.end();
    });
    return { ok, target: `opencode serve :${port}（辅助参考：诊断链实际使用随机端口服务，此项不代表会话可用性）` };
}

const RESTART_INTERRUPT = /服务重启时检测到运行中断/;

function _interruptDetail(reason) {
    const text = String(reason || '');
    if (!RESTART_INTERRUPT.test(text)) return null;
    const phase = (text.match(/当前阶段:\s*([^，。]+)/) || [])[1]?.trim() || '';
    const step = (text.match(/当前步骤:\s*([^，。]+)/) || [])[1]?.trim() || '';
    const completed = (text.match(/已完成\s*(\d+)\s*步/) || [])[1] || '';
    return { phase, step, completed };
}

/**
 * 从已定位的失败步骤恢复，保留之前成功的步骤并注入定向恢复指令。
 * 支持普通基础设施失败；真实 Issue 验证失败不可被当作平台故障绕过。
 */
export async function continueIssueAnalysis(taskId, options = {}) {
    // 先失效终态快照，防止恢复期间上游短暂超时又展示旧的失败/完成详情。
    terminalStatusSnapshots.invalidate(taskId);
    invalidateArtifactSummary(runId);
    return getFailureRecovery().continueTask(taskId, options);
}

export async function diagnoseIssueAnalysisFailure(taskId, options = {}) {
    return getFailureRecovery().diagnose(taskId, options);
}

export async function listIssuePlatformDefects() {
    return getFailureRecovery().listDefects();
}

const DEVICE_LOCK_SCRIPT = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../skills/cpf-ohos-issue-analysis/scripts/device-lock.mjs',
);

/** 停掉分析之后再按 runId 放锁。引擎停止路径也会放一次，这里兜住引擎没走到 finally 的情况。 */
function releaseIssueDeviceLocks(runId) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [DEVICE_LOCK_SCRIPT, 'release', '--all', '--run', runId], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error('释放设备锁超时'));
        }, 20000);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => {
            clearTimeout(timer);
            const line = String(stdout).trim().split('\n').filter(Boolean).pop() || '';
            let parsed = null;
            try { parsed = JSON.parse(line); } catch { /* 按退出码处理 */ }
            if (code) {
                reject(new Error(parsed?.error || stderr.trim().slice(0, 300) || `释放设备锁失败（退出码 ${code}）`));
                return;
            }
            resolve(parsed || { released: true });
        });
    });
}

/**
 * 停止一条分析，并释放它占用的设备锁和排队。
 * 已经结束的任务不会被改回运行中，但仍会清掉残留的锁。
 */
export async function stopIssueAnalysis(taskId) {
    const store = getStore();
    const task = store.get(taskId);
    if (!task) {
        const error = new Error('任务不存在');
        error.status = 404;
        throw error;
    }
    const metadata = _metadata(task);
    const runId = metadata.runId || task.analysisSessionId;
    terminalStatusSnapshots.invalidate(taskId);
    invalidateArtifactSummary(runId);
    if (!runId) {
        if (!TERMINAL_STAGES.has(task.stage)) {
            store.patch(taskId, {
                stage: STAGE.CANCELLED,
                error: null,
                finishedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
        }
        return { taskId, runId: null, locks: null, message: '已停止' };
    }

    let stopError = null;
    try {
        await stopWorkflow(runId);
    } catch (error) {
        stopError = error;
    }
    let locks = null;
    try {
        locks = await releaseIssueDeviceLocks(runId);
    } catch (error) {
        const message = stopError
            ? `${stopError.message}；设备锁也没有释放：${error.message}`
            : `分析已停止，但设备锁没有释放：${error.message}`;
        const wrapped = new Error(message);
        wrapped.status = 502;
        throw wrapped;
    }
    if (stopError) {
        const wrapped = new Error(`设备锁已释放，但分析没有停下来：${stopError.message}`);
        wrapped.status = stopError.status || 502;
        throw wrapped;
    }
    if (!TERMINAL_STAGES.has(task.stage)) {
        store.patch(taskId, {
            stage: STAGE.CANCELLED,
            error: null,
            finishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
    }
    const released = [...(locks?.releasedKeys || []), ...(locks?.platforms || []), ...(locks?.released || [])];
    return {
        taskId,
        runId,
        locks,
        message: released.length ? `已停止，并释放设备锁：${released.join('、')}` : '已停止，这轮分析没有占用设备锁',
    };
}

export async function getIssueChainHealth() {
    const store = getStore();
    const metrics = computeChainMetrics(store.list());
    const [aceharness, opencodeCli, opencodeServe] = await Promise.all([
        _probeAceHarness(), _probeOpencodeCli(), _probeOpencodeServe(),
    ]);
    return {
        ...metrics,
        dependencies: { aceharness, opencodeCli, opencodeServe },
        healthy: aceharness.ok && opencodeCli.ok,
    };
}

const statusRequests = new Map();
const terminalStatusSnapshots = createTerminalStatusCache();
// 测试可替换传输与快照实现，但生产服务始终沿用同一鉴权和状态协调入口。
export function setIssueStatusTestDependencies({ readStatus, snapshots, store } = {}) {
    if (process.env.NODE_ENV !== 'test') throw new Error('仅测试环境允许替换状态读取依赖');
    queryTaskStatus.readStatus = readStatus || null;
    queryTaskStatus.snapshots = snapshots || null;
    if (store) _store = store;
}
function queryTaskStatus(taskId, full) {
    const key = `${taskId}:${full ? 'full' : 'compact'}`;
    const pending = statusRequests.get(key);
    if (pending) return pending;
    const request = _queryTaskStatus(taskId, full).finally(() => {
        if (statusRequests.get(key) === request) statusRequests.delete(key);
    });
    statusRequests.set(key, request);
    return request;
}

async function _queryTaskStatus(taskId, full) {
    const store = getStore();
    const task = store.get(taskId);
    if (!task) return null;
    const metadata = _metadata(task);
    const runId = metadata.runId || task.analysisSessionId;
    const configFile = metadata.configFile || (task.parentTaskId ? ITERATE_CONFIG_FILE : config.aceharness.configFile);
    if (!runId) return { ...task, aceharnessStatus: null };
    const snapshots = queryTaskStatus.snapshots || terminalStatusSnapshots;
    // 已成功读取过的历史状态是不可变展示快照，刷新详情不再重复加载 ACE 大型状态。
    // 恢复/停止同 run 前必须显式失效；没有缓存的终态仍向引擎核实。
    const terminal = snapshots.get(task, runId);
    if (terminal) {
        const latest = store.get(taskId);
        return { ...latest, failureDiagnosis: _metadata(latest).failureRecovery?.diagnosis || null,
            aceharnessStatus: terminal, queryUnavailable: false, aceharnessError: null, lastQueryError: null,
            statusAsOf: latest.updatedAt || null };
    }
    const previousAsOf = _readQueryHealth(task)?.lastSuccessAt || task.updatedAt || null;
    let ahStatus = null;
    let ahError = null;
    let usedTerminalSnapshot = false;
    try {
        let timer;
        const lookup = async () => {
            let found = queryTaskStatus.readStatus
                ? await queryTaskStatus.readStatus(runId, configFile, full)
                : await (full ? getWorkflowStatusFull : getWorkflowStatusCompact)(runId, configFile);
            if (!found?.status || (found.status === 'idle' && !found.runId)) {
                const persisted = await getPersistedIssueRun(runId, configFile);
                if (persisted) found = persisted;
                else {
                    if (['dispatching', 'uncertain'].includes(metadata.startState)) {
                        throw new Error('启动结果尚未确认，正在按运行 ID 对账，请勿重复提交');
                    }
                    // Preserve completed results even if an old run has been archived away.
                    const report = await getDiagnosisReport(runId, configFile);
                    if (report?.content) found = { status: 'completed', runId };
                    else if (TERMINAL_STAGES.has(task.stage)) return { preserveLocal: true };
                    else found = { status: 'failed', runId, error: _describeRunLoss(runId) };
                }
            }
            return found;
        };
        // 首次状态读取失败后还可能走持久化对账，给底层请求与恢复查询留出完整窗口。
        // 前端的 30 秒详情读取超时仍是最终边界。
        const queryDeadlineMs = 20000;
        try {
            ahStatus = await Promise.race([lookup(), new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('状态查询超时，保留最近进度')), queryDeadlineMs);
            })]);
        } finally { clearTimeout(timer); }
        if (ahStatus.preserveLocal) return { ...task, aceharnessStatus: snapshots.get(store.get(taskId), runId), statusAsOf: previousAsOf };
        if (ahStatus.status === 'idle') throw new Error('运行状态尚未恢复，保留最近状态');
        snapshots.put(task, runId, ahStatus);
        if (metadata.failureRecovery?.lastResumeAt && ['failed', 'crashed'].includes(ahStatus.status)) {
            const failureTimes = [ahStatus.endTime, ahStatus.runEndTime, ...(ahStatus.stepLogs || []).map(log => log.timestamp)]
                .filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
            const latestFailureMs = Math.max(0, ...failureTimes);
            if (latestFailureMs < new Date(metadata.failureRecovery.lastResumeAt).getTime()) {
                return { ...store.get(taskId), aceharnessStatus: ahStatus, statusAsOf: previousAsOf,
                    recoveryPending: true };
            }
        }
        const stage = mapAceHarnessStatus(ahStatus);
        const patch = { stage, updatedAt: new Date().toISOString(),
            error: stage === STAGE.FAILED ? ahStatus.error || ahStatus.statusReason || task.error || '工作流执行失败' : null };
        if (metadata.startState && metadata.startState !== 'confirmed') patch.metadata = { ...metadata, startState: 'confirmed' };
        if (TERMINAL_STAGES.has(stage)) {
            // F08：finishedAt 只使用引擎时间；缺失时固化为首次观察到终态的时间，不随查询漂移
            const times = resolveTerminalTimes(ahStatus, metadata, task);
            patch.finishedAt = times.finishedAt;
            patch.metadata = { ...(patch.metadata || metadata),
                engineStartedAt: times.engineStartedAt,
                engineEndedAt: times.engineEndedAt,
                terminalObservedAt: times.terminalObservedAt };
        }
        else patch.finishedAt = null;
        // F01/F04：归档与验证状态透传到任务，"完成"不再掩盖归档异常或验证受限
        if (ahStatus.diagnosisArtifactStatus || ahStatus.diagnosisVerificationStatus) {
            const base = patch.metadata || metadata;
            patch.metadata = { ...base,
                artifactStatus: ahStatus.diagnosisArtifactStatus || base.artifactStatus || null,
                verificationStatus: ahStatus.diagnosisVerificationStatus || base.verificationStatus || null };
        }
        if (ahStatus.finalReview?.summary) patch.summary = ahStatus.finalReview.summary;
        store.patch(taskId, patch);
        _patchQueryHealth(store, store.get(taskId), null);
    } catch (err) {
        ahError = err.message;
        if (_isTransientQueryError(err)) {
            const cached = snapshots.get(store.get(taskId), runId);
            if (cached) {
                ahStatus = cached;
                usedTerminalSnapshot = true;
            }
        }
        _patchQueryHealth(store, store.get(taskId), { error: ahError, reason: _isTransientQueryError(err) ? 'transient' : 'query_failed',
            lastSuccessAt: previousAsOf, lastStage: task.stage });
        logger.warn('查询运行状态失败，保留最近状态', { taskId, runId, error: ahError, usedTerminalSnapshot });
    }
    const fresh = store.get(taskId);
    const freshMetadata = _metadata(fresh);
    const failureDiagnosis = freshMetadata.failureRecovery?.diagnosis || null;
    // 浏览历史不得触发监督模型审查或自动恢复；完整分诊仅在用户主动继续时执行。
    // 已有分诊随状态直接展示，避免与报告、截图争抢上游连接。
    return { ...store.get(taskId), failureDiagnosis, aceharnessStatus: ahStatus, aceharnessError: ahError,
        queryUnavailable: !!ahError, lastQueryError: ahError,
        statusAsOf: _readQueryHealth(store.get(taskId))?.lastSuccessAt || previousAsOf };
}

// ─── 报告/输出读取（代理到 AceHarness） ───────────────────────────────────────

/**
 * 获取完整诊断报告（通过 AceHarness /api/runs/{runId}/outputs?outputRef= 接口）
 *
 * 按文档推荐流程：
 *  1. 列出所有输出文件
 *  2. 找到"报告沉淀-生成诊断报告"步骤的 outputRef
 *  3. 用 outputRef 读取完整报告内容（Markdown 格式）
 *
 * @param {string} taskId
 * @returns {Promise<{content: string, stepName: string, outputRef: string}|null>}
 */
export async function getFinalReview(taskId) {
    const task = getTask(taskId);
    if (!task) return null;

    const metadata = _metadata(task);
    const runId = metadata.runId || task.analysisSessionId;
    if (!runId) return null;

    return getDiagnosisReport(runId);
}

/**
 * 读取步骤输出（代理到 AceHarness）
 * @param {string} taskId
 * @param {string} stepName
 * @returns {Promise<{stepName: string, content: string}>}
 */
export async function getStepOutputByTask(taskId, stepName) {
    const task = getTask(taskId);
    if (!task) return null;

    const metadata = _metadata(task);
    const runId = metadata.runId || task.analysisSessionId;
    if (!runId) return null;

    return getStepOutput(runId, stepName);
}

/**
 * 列出 run 的所有输出文件（代理到 AceHarness）
 * @param {string} taskId
 * @returns {Promise<{files: array}>}
 */
export async function listOutputs(taskId) {
    const task = getTask(taskId);
    if (!task) return null;

    const metadata = _metadata(task);
    const runId = metadata.runId || task.analysisSessionId;
    if (!runId) return null;

    return listRunOutputs(runId);
}

/**
 * 按 outputRef 读取文件（代理到 AceHarness）
 * @param {string} taskId
 * @param {string} outputRef
 * @returns {Promise<{stepName: string, content: string}>}
 */
export async function getOutputRef(taskId, outputRef) {
    const task = getTask(taskId);
    if (!task) return null;

    const metadata = _metadata(task);
    const runId = metadata.runId || task.analysisSessionId;
    if (!runId) return null;

    return getOutputByRef(runId, outputRef);
}

// ─── Run 产物（本地磁盘直读：截图/日志/补丁/步骤日志） ────────────────────────

/**
 * 列出任务的 run 产物（截图、日志、补丁、HAR、步骤日志）
 * @param {string} taskId
 * @returns {{ runId: string, artifacts: object } | null} 任务不存在返回 null
 */
export async function listTaskArtifacts(taskId) {
    const task = getStore().get(taskId);
    if (!task) return null;
    const metadata = _metadata(task);
    const runId = metadata.runId || task.analysisSessionId;
    if (!runId) return { runId: null, artifacts: { images: [], logs: [], files: [], steps: [] } };
    const artifacts = await listArtifactsCached(runId, TERMINAL_STAGES.has(task.stage), listRunArtifacts);
    return { runId, artifacts };
}

/**
 * 读取任务的单个 run 产物文件
 * @param {string} taskId
 * @param {string} ref - work/<rel> 或 arch/<rel>
 */
export function readTaskArtifact(taskId, ref) {
    const task = getStore().get(taskId);
    if (!task) return null;
    const metadata = _metadata(task);
    const runId = metadata.runId || task.analysisSessionId;
    if (!runId) return null;
    return readRunArtifact(runId, ref);
}

// ─── 基础查询 ──────────────────────────────────────────────────────────────────

export function getTask(taskId) {
    return getStore().get(taskId);
}

/**
 * 列出任务（A10：按提交人过滤 + 分页都下沉到存储层查询）。
 * @param {object} [opts]
 * @param {string|null} [opts.ownerUsername] - 限定提交人；null/undefined 表示不过滤（admin）
 * @param {number} [opts.page=1] - 页码，从 1 开始
 * @param {number} [opts.pageSize=20] - 每页条数
 * @returns {{ tasks: TaskRecord[], total: number }}
 */
export function listTasks(opts = {}) {
    const store = getStore();
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.max(1, opts.pageSize || 20);
    // 优先走 SQLite（含已完成的历史任务）；内存 fallback 由 HybridTaskStore 内部兜底
    if (opts.ownerUsername) {
        return {
            tasks: store.listRecentByOwner(opts.ownerUsername, pageSize, (page - 1) * pageSize),
            total: store.countByOwner(opts.ownerUsername),
        };
    }
    return {
        tasks: store.listPage(page, pageSize),
        total: store.count(),
    };
}

/**
 * 两轮修复对比（AI 轮 vs 用户反馈轮）
 * 数据源：两个 run 的 outputs/（patch、验证证据）+ 任务元数据
 * @param {string} taskIdA
 * @param {string} taskIdB
 * @returns {Promise<object>} 对比数据
 */
export async function compareIterations(taskIdA, taskIdB) {
    const store = getStore();
    const taskA = store.get(taskIdA);
    const taskB = store.get(taskIdB);
    if (!taskA || !taskB) throw new Error('任务不存在');
    if (!taskA.analysisSessionId || !taskB.analysisSessionId) throw new Error('任务缺少 runId，无法对比');
    // 对比语义是"同一 Issue 的 AI 轮 vs 用户反馈轮"：两任务必须属于同一迭代链
    const rootA = _iterationRoot(taskA);
    const rootB = _iterationRoot(taskB);
    if (rootA !== rootB) throw new Error('只能对比同一迭代链内的两轮任务');

    const pick = (task) => {
        const runDir = join(homedir(), task.analysisSessionId);
        const outDir = join(runDir, 'outputs');
        const patchNames = ['fix.patch', 'fix-engine.patch'];
        const patches = {};
        for (const name of patchNames) {
            const p = join(outDir, name);
            if (existsSync(p)) {
                try {
                    patches[name] = readFileSync(p, 'utf-8').slice(0, 512 * 1024);
                } catch { /* ignore */ }
            }
        }
        // listRunArtifacts 返回 { images, logs, files, steps } 分组结构
        let artifactCount = 0;
        try {
            const arts = listRunArtifacts(task.analysisSessionId);
            artifactCount = (arts.images?.length || 0) + (arts.logs?.length || 0)
                + (arts.files?.length || 0) + (arts.steps?.length || 0);
        } catch { /* ignore */ }
        return {
            taskId: task.taskId,
            stage: task.stage,
            isUserRound: Boolean(task.parentTaskId),
            userFeedback: task.userFeedback ?? null,
            runId: task.analysisSessionId,
            createdAt: task.createdAt,
            finishedAt: task.finishedAt ?? null,
            summary: task.summary ?? null,
            patches,
            artifactCount,
        };
    };

    return { taskA: pick(taskA), taskB: pick(taskB) };
}

export { STAGE, TERMINAL_STAGES, parseIssueUrl, isValidIssueUrl };
