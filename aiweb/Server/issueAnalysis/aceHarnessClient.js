/**
 * AceHarness 客户端 — 调用 AceHarness 工作流 API
 *
 * 职责：
 *  1. 调用 AceHarness 的 /api/workflow/start 启动工作流
 *  2. 调用 /api/workflow/status 查询状态（含 finalReview）
 *  3. 调用 /api/runs/{runId}/outputs 读取步骤输出
 *  4. 管理 JWT 认证（登录获取 token）
 *
 * AceHarness API 文档：ACEHarness/docs/workflow-api-spec.md
 * Base URL 默认 http://127.0.0.1:3000（与 ACE 默认端口一致）
 */

import { resolveLocalAdminSession } from '../library/localSession.js';
import { aceDataDir } from '../library/aceRuntime.js';
import https from 'node:https';
import http  from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import config from '../library/config.js';

/** AceHarness 服务地址（公网，用于构造展示/跳转链接） */
export const ACEHARNESS_BASE_URL = config.aceharness.baseUrl;

/** AceHarness API 调用地址（同机直连，绕过公网回环，避免隧道/IPv6 波动导致超时） */
export const ACEHARNESS_API_BASE_URL = config.aceharness.apiBaseUrl;

/** 默认工作流配置文件 */
export const DEFAULT_CONFIG_FILE = config.aceharness.configFile;

/** 请求超时 */
export const REQUEST_TIMEOUT_MS = config.aceharness.timeoutMs;

// ── HTTP 连接复用 ─────────────────────────────────────────────────────────────

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 32,
    keepAliveMsecs: 30000,
});

const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 32,
    keepAliveMsecs: 30000,
});

// ── JWT Token 缓存 ────────────────────────────────────────────────────────────

let _cachedToken = null;
let _tokenExpiry = 0;

/**
 * 登录 AceHarness 获取 JWT
 * @returns {Promise<string>}
 */
export async function loginAceHarness() {
    const { email, password } = config.aceharness;
    if (!email || !password) {
        throw new Error('AceHarness 邮箱/密码未配置（ACEHARNESS_EMAIL / ACEHARNESS_PASSWORD）');
    }

    const result = await httpRequest('POST', '/api/auth/login', { email, password }, {
        baseUrl: ACEHARNESS_API_BASE_URL,
        timeoutMs: 10000,
    });

    if (result.status !== 200 || !result.data?.token) {
        throw new Error(`AceHarness 登录失败（HTTP ${result.status}）：${JSON.stringify(result.data)}`);
    }

    _cachedToken = result.data.token;
    // JWT 默认 24h，提前 5 分钟过期
    _tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
    return _cachedToken;
}

/**
 * 获取有效的 JWT（带缓存）
 * @returns {Promise<string>}
 */
async function getToken() {
    if (_cachedToken && Date.now() < _tokenExpiry) {
        return _cachedToken;
    }
    if (process.env.AIWEB_DEPLOYMENT === 'personal') {
        const { token, expiresAt } = await resolveLocalAdminSession(async candidate => {
            const result = await httpRequest('GET', '/api/auth/me', null, {
                baseUrl: ACEHARNESS_API_BASE_URL,
                token: candidate,
                timeoutMs: 10000,
            });
            return result.status === 200 ? result.data?.user : null;
        });
        _cachedToken = token;
        _tokenExpiry = Math.min(Date.now() + 60 * 60 * 1000, expiresAt);
        return token;
    }
    // 公网多用户部署仍只使用原有服务令牌或显式配置的服务账号。
    const diskToken = _readAdminTokenFromDisk();
    if (diskToken) {
        _cachedToken = diskToken;
        // 服务 token 有自身 expiry，缓存短于其有效期即可；保守用 1h
        _tokenExpiry = Date.now() + 60 * 60 * 1000;
        return _cachedToken;
    }
    return loginAceHarness();
}

function _readAdminTokenFromDisk() {
    try {
        const dataDir = aceDataDir();
        const users = JSON.parse(readFileSync(join(dataDir, 'users.json'), 'utf8'));
        const adminIds = new Set(users.filter(isActiveAdmin).map(u => u.id));
        const tokens = JSON.parse(readFileSync(join(dataDir, 'tokens.json'), 'utf8'));
        const now = Date.now();
        let best = null, bestExp = 0;
        for (const [token, info] of tokens) {
            if (info?.userId && adminIds.has(info.userId) && info.expiry > now && info.expiry > bestExp) {
                best = token; bestExp = info.expiry;
            }
        }
        return best;
    } catch { return null; }
}

// ── URL 解析（保留原有功能） ────────────────────────────────────────────────

/**
 * 解析 Issue 地址，提取平台、owner、repo 和 issueNumber
 */
export function parseIssueUrl(issueUrl) {
    try {
        const url = new URL(issueUrl);
        const hostname = url.hostname.toLowerCase();

        const platform = { 'gitcode.com': 'gitcode', 'github.com': 'github', 'gitee.com': 'gitee' }[hostname];
        if (!platform || url.protocol !== 'https:' || url.username || url.password || url.port) {
            throw new Error('不支持的 Issue 地址（请使用 gitcode / github / gitee 官方 HTTPS 地址）');
        }
        const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
        if (!match) throw new Error('Issue 地址格式无效，需形如 /owner/repo/issues/123');
        const [, owner, repo, rawNumber] = match;
        if (['.', '..'].includes(owner) || ['.', '..'].includes(repo)) throw new Error('Issue 仓库地址无效');
        const numeric = /^[1-9][0-9]*$/.test(rawNumber);
        if (!numeric && !(platform === 'gitee' && /^I[A-Za-z0-9]+$/i.test(rawNumber))) {
            throw new Error('Issue 序号无效');
        }
        const issueNumber = numeric ? Number(rawNumber) : rawNumber.toUpperCase();
        if (numeric && !Number.isSafeInteger(issueNumber)) throw new Error('Issue 序号超出范围');

        return { platform, owner, repo, issueNumber };
    } catch (err) {
        if (err.message.startsWith('不支持') || err.message.startsWith('Issue')) throw err;
        throw new Error(`Issue 地址解析失败：${err.message}`);
    }
}

export function isValidIssueUrl(issueUrl) {
    try {
        parseIssueUrl(issueUrl);
        return true;
    } catch {
        return false;
    }
}

// Internal recovery queries share the same authenticated service session.
export { getToken as getServiceToken };

// ── HTTP 请求 ────────────────────────────────────────────────────────────────

/**
 * 通用 HTTP 请求
 * @param {string} method - GET / POST
 * @param {string} path - 路径（如 /api/workflow/start）
 * @param {object|null} body - 请求体
 * @param {object} [opts]
 * @param {string} [opts.baseUrl] - 覆盖默认 baseUrl
 * @param {number} [opts.timeoutMs] - 超时
 * @param {string} [opts.token] - JWT
 * @returns {Promise<{status: number, data: any, headers: object}>}
 */
export function httpRequest(method, path, body, opts = {}) {
    const deadline = Date.now() + (opts.timeoutMs || REQUEST_TIMEOUT_MS);
    const once = () => _httpRequestOnce(method, path, body, { ...opts, timeoutMs: Math.max(1, deadline - Date.now()) });
    return once().catch((err) => {
        // keepAlive 复用被服务端空闲断开的死连接（ECONNRESET/socket hang up，典型 94ms 内失败）：
        // 立即用新连接重试一次即可成功。请求体需可重复发送（JSON 字符串安全）。
        const retriable = /ECONNRESET|EPIPE|socket hang up|fetch failed/i
            .test(String(err.message) + String(err.code || ''));
        if (!retriable || !['GET', 'HEAD'].includes(method.toUpperCase()) || Date.now() >= deadline) throw err;
        return once();
    });
}

function _httpRequestOnce(method, path, body, opts = {}) {
    const baseUrl = opts.baseUrl || ACEHARNESS_API_BASE_URL;
    const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
    const url = new URL(path, baseUrl);

    return new Promise((resolve, reject) => {
        const lib = url.protocol === 'https:' ? https : http;
        const agent = url.protocol === 'https:' ? httpsAgent : httpAgent;

        const headers = { 'Accept': 'application/json' };
        if (body) {
            headers['Content-Type'] = 'application/json';
        }
        if (opts.token) {
            headers['Authorization'] = `Bearer ${opts.token}`;
        }

        const req = lib.request(url, {
            method,
            headers,
            agent,
            timeout: timeoutMs,
        }, (res) => {
            let chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                let data;
                try { data = raw ? JSON.parse(raw) : null; }
                catch { data = raw; }
                resolve({ status: res.statusCode, data, headers: res.headers });
            });
        });

        // 从创建请求起计时，涵盖连接池排队、连接建立以及响应体读取。
        const timer = setTimeout(() => req.destroy(new Error(`请求超时（${timeoutMs}ms）：${method} ${path}`)), timeoutMs);
        req.once('close', () => clearTimeout(timer));
        req.on('response', (res) => {
            res.once('aborted', () => reject(new Error('响应在读取完成前中断')));
            res.once('error', reject);
        });
        req.on('timeout', () => {
            req.destroy(new Error(`请求超时（${timeoutMs}ms）：${method} ${path}`));
        });
        req.on('error', reject);

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// ── AceHarness 工作流 API ────────────────────────────────────────────────────

/**
 * 启动工作流
 * @param {object} opts
 * @param {string} opts.issueUrl - Issue URL
 * @param {string} [opts.configFile] - 工作流配置文件，默认 cpf-ohos-diagnosis.yaml
 * @param {string} [opts.globalContext] - 全局上下文（issue 描述等）
 * @param {object} [opts.phaseContexts] - 按阶段注入的上下文
 * @returns {Promise<{runId: string, frontendSessionId: string, sessionWorkbenchState: object}>}
 */
export async function startWorkflow(opts) {
    const { configFile = DEFAULT_CONFIG_FILE, globalContext, phaseContexts, runId } = opts;
    let token;
    try { token = await getToken(); }
    catch (error) { error.definitelyNotStarted = true; throw error; }

    const body = {
        configFile,
        initialContexts: {},
        ...(runId ? { runId } : {}),
    };
    if (globalContext) {
        body.initialContexts.globalContext = globalContext;
    }
    if (phaseContexts) {
        body.initialContexts.phaseContexts = phaseContexts;
    }

    const result = await httpRequest('POST', '/api/workflow/start', body, { token, timeoutMs: 12000 });

    if (result.status !== 200 || !result.data?.runId) {
        const msg = result.data?.error || result.data?.message || `HTTP ${result.status}`;
        const error = new Error(`AceHarness 启动工作流失败：${msg}`);
        error.definitelyNotStarted = [400, 401, 403, 412, 422].includes(result.status);
        throw error;
    }

    return {
        runId: result.data.runId,
        frontendSessionId: result.data.frontendSessionId,
        sessionWorkbenchState: result.data.sessionWorkbenchState,
    };
}

/**
 * 让已有运行从中断的步骤继续。AceHarness 会保留已完成步骤，只重跑当前步骤。
 * @param {string} runId
 * @param {string} feedback - 只针对恢复步骤的补充指令，注入工作流全局上下文
 */
export async function resumeWorkflow(runId, feedback = '') {
    const token = await getToken();
    const result = await httpRequest('POST', '/api/workflow/resume', {
        runId, action: 'iterate', feedback: String(feedback || '').slice(0, 20000),
    }, { token, timeoutMs: 20000 });
    if (result.status !== 200 || !result.data?.success) {
        const msg = result.data?.error || result.data?.message || `HTTP ${result.status}`;
        const error = new Error(`继续运行失败：${msg}`);
        error.status = result.status === 409 ? 409 : 502;
        throw error;
    }
    return result.data;
}

/**
 * 停止一条工作流。只传 runId，避免停掉同一配置下的其他分析。
 * @param {string} runId
 */
export async function stopWorkflow(runId) {
    if (!runId) throw new Error('缺少 runId');
    const token = await getToken();
    const result = await httpRequest('POST', '/api/workflow/stop', { runId }, { token, timeoutMs: 90000 });
    if (result.status !== 200) {
        const msg = result.data?.error || result.data?.message || `HTTP ${result.status}`;
        const error = new Error(`停止分析失败：${msg}`);
        error.status = result.status === 409 ? 409 : 502;
        throw error;
    }
    return result.data;
}

// ── 磁盘回退：AceHarness 重启后 API 返回 idle，从磁盘读取 state.yaml ──────────

/**
 * 查询工作流状态（精简模式，适合轮询）
 * ⚠️ 必须携带 configFile：AceHarness 无 configFile 时会走兜底分支，
 * 返回任意正在运行的 manager（可能是其他任务的 run），导致状态串号
 * @param {string} runId
 * @param {string} [configFile] - 工作流配置文件名，默认取全局配置
 * @returns {Promise<object>} 精简状态 JSON
 */
// 历史状态会读取较大的 state.yaml，不能用启动接口的短超时切断详情加载。
const STATUS_QUERY_TIMEOUT_MS = 12000;

export async function getWorkflowStatusCompact(runId, configFile) {
    const token = await getToken();
    const cf = configFile || config.aceharness.configFile || DEFAULT_CONFIG_FILE;
    const result = await httpRequest('GET', `/api/workflow/status?runId=${encodeURIComponent(runId)}&configFile=${encodeURIComponent(cf)}&compact=1`, null, { token, timeoutMs: STATUS_QUERY_TIMEOUT_MS });

    if (result.status !== 200) {
        throw new Error(`查询状态失败（HTTP ${result.status}）：${JSON.stringify(result.data)}`);
    }

    return result.data;
}

/**
 * 查询工作流完整状态（含 finalReview、stepLogs）
 * ⚠️ 必须携带 configFile，原因同上
 * @param {string} runId
 * @param {string} [configFile]
 * @returns {Promise<object>} 完整状态 JSON
 */
export async function getWorkflowStatusFull(runId, configFile) {
    const token = await getToken();
    const cf = configFile || config.aceharness.configFile || DEFAULT_CONFIG_FILE;
    const result = await httpRequest('GET', `/api/workflow/status?runId=${encodeURIComponent(runId)}&configFile=${encodeURIComponent(cf)}`, null, { token, timeoutMs: STATUS_QUERY_TIMEOUT_MS });

    if (result.status !== 200) {
        throw new Error(`查询完整状态失败（HTTP ${result.status}）：${JSON.stringify(result.data)}`);
    }

    return result.data;
}

/**
 * 读取步骤输出文件内容
 * @param {string} runId
 * @param {string} stepName - 步骤名
 * @returns {Promise<{stepName: string, content: string}>}
 */
export async function getStepOutput(runId, stepName) {
    const token = await getToken();
    const result = await httpRequest(
        'GET',
        `/api/runs/${encodeURIComponent(runId)}/outputs?step=${encodeURIComponent(stepName)}`,
        null,
        { token }
    );

    if (result.status !== 200) {
        throw new Error(`读取步骤输出失败（HTTP ${result.status}）：${JSON.stringify(result.data)}`);
    }

    return result.data;
}

/**
 * 列出 run 的所有输出文件
 * @param {string} runId
 * @returns {Promise<{files: array}>}
 */
export async function listRunOutputs(runId) {
    const token = await getToken();
    const result = await httpRequest(
        'GET',
        `/api/runs/${encodeURIComponent(runId)}/outputs`,
        null,
        { token }
    );

    if (result.status !== 200) {
        throw new Error(`列出输出文件失败（HTTP ${result.status}）：${JSON.stringify(result.data)}`);
    }

    return result.data;
}

/**
 * 按 outputRef 读取文件内容
 * @param {string} runId
 * @param {string} outputRef - run 内部相对路径
 * @returns {Promise<{stepName: string, content: string}>}
 */
export async function getOutputByRef(runId, outputRef) {
    const token = await getToken();
    const result = await httpRequest(
        'GET',
        `/api/runs/${encodeURIComponent(runId)}/outputs?outputRef=${encodeURIComponent(outputRef)}`,
        null,
        { token }
    );

    if (result.status !== 200) {
        throw new Error(`读取输出文件失败（HTTP ${result.status}）：${JSON.stringify(result.data)}`);
    }

    return result.data;
}

// ── 完整诊断报告获取 ──────────────────────────────────────────────────────────

/**
 * 调用 AceHarness 新接口 GET /api/runs/{runId}/step-logs?step=xxx
 * 读取 outputs/step-logs/ 目录中的完整步骤输出（含 UUID，自动匹配）
 *
 * @param {string} runId
 * @param {string} stepName - 步骤名（如"报告沉淀-生成诊断报告"）
 * @returns {Promise<{stepName: string, content: string}|null>}
 */
export async function getStepLogOutput(runId, stepName) {
    const token = await getToken();
    const result = await httpRequest(
        'GET',
        `/api/runs/${encodeURIComponent(runId)}/step-logs?step=${encodeURIComponent(stepName)}`,
        null,
        { token }
    );

    if (result.status !== 200) {
        throw new Error(`读取 step-logs 失败（HTTP ${result.status}）：${JSON.stringify(result.data)}`);
    }

    if (!result.data || !result.data.content) {
        return null;
    }
    return result.data;
}

/**
 * 获取完整诊断报告
 *
 * 优先用 step-logs 接口（完整版），回退到 outputRef 和 step 方式
 *
 * 流程：
 *  1. 调用 GET /api/runs/{runId}/step-logs?step=报告沉淀-生成诊断报告 读取完整版
 *  2. 若失败，尝试从 status 获取 outputRef，用 outputs?outputRef=xxx 读取
 *  3. 若都失败，回退用 outputs?step=xxx 读取精简版
 *
 * @param {string} runId
 * @param {string} [configFile]
 * @returns {Promise<{content: string, stepName: string}|null>}
 */
export async function getDiagnosisReport(runId, configFile) {
    const stepName = '报告沉淀-生成诊断报告';

    // 步骤 1：优先用 step-logs 接口读取完整版
    try {
        const result = await getStepLogOutput(runId, stepName);
        if (result && result.content) {
            return {
                content: result.content,
                stepName: result.stepName || stepName,
            };
        }
    } catch {
        // step-logs 接口失败，继续尝试其他方式
    }

    // 步骤 2：尝试从 status 获取 outputRef
    let outputRef = null;
    try {
        const ahStatus = await getWorkflowStatusFull(runId, configFile);
        const stepLogs = ahStatus.stepLogs || [];
        const reportStep = stepLogs.find(sl =>
            sl.stepName && (sl.stepName.includes('报告沉淀') || sl.stepName.includes('生成诊断报告'))
        );
        if (reportStep) {
            outputRef = reportStep.outputRef || null;
        }
    } catch {
        // status 接口失败，继续尝试 step 方式
    }

    if (outputRef) {
        try {
            const result = await getOutputByRef(runId, outputRef);
            if (result && result.content) {
                return {
                    content: result.content,
                    stepName,
                    outputRef,
                };
            }
        } catch {
            // outputRef 读取失败，回退到 step 方式
        }
    }

    // 步骤 3：回退用 outputs?step=xxx 读取（精简版）
    const result = await getStepOutput(runId, stepName);
    if (!result || !result.content) {
        return null;
    }
    return {
        content: result.content,
        stepName: result.stepName || stepName,
    };
}
