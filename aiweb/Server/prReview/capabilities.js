/**
 * GitCode 令牌能力探测（R02）
 *
 * 目标：在真正执行「应用建议 / 推送」之前，尽量让用户看清当前令牌能做什么：
 *   - identity：令牌归属身份（能否读取 /user）
 *   - read    ：能否读取目标仓库
 *   - comment ：能否在目标 PR 发表评论（发布评论需要写权限）
 *   - push    ：能否向目标分支推送
 *
 * 原则（与需求文档一致）：
 *   1. 只做只读探测，绝不通过真实推送/评论来"测试"权限；
 *   2. API 无法证明的能力一律返回 'unknown'，不猜成 ok；
 *   3. 探测结果按「身份 + 仓库」缓存，供页面展示，不阻断主流程。
 *
 * 能力取值：'ok' | 'denied' | 'unknown'
 */

import { createHash } from 'crypto';
import { createLogger } from '../library/logger.js';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const logger = createLogger('PrReviewCapabilities');

const GITCODE_API_BASE = 'https://gitcode.com/api/v5';
const CAPABILITIES_FILE = join(homedir(), '.aceharness', 'data', 'aiweb-gitcode-capabilities.json');

export const CAPABILITY_UNKNOWN = 'unknown';
export const CAPABILITY_OK = 'ok';
export const CAPABILITY_DENIED = 'denied';

/** 读取只读探测响应体（不抛错，返回 {status, body}） */
async function _fetchJson(url, token, timeoutMs = 8000) {
    const headers = {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await resp.json(); } catch { /* 非 JSON 视为无 body */ }
    return { status: resp.status, body };
}

/**
 * 对一个 GitCode 令牌做只读能力探测。
 * @param {string} gitcodeToken - GitCode 个人访问令牌（明文，仅本次探测使用，不落盘）
 * @param {string} [owner]
 * @param {string} [repo]
 * @returns {Promise<{identity, read, comment, push, login, checkedAt, notes}>}
 */
export async function probeGitcodeCapabilities(gitcodeToken, owner = '', repo = '') {
    const out = {
        identity: CAPABILITY_UNKNOWN,
        read: CAPABILITY_UNKNOWN,
        comment: CAPABILITY_UNKNOWN,
        push: CAPABILITY_UNKNOWN,
        login: '',
        checkedAt: new Date().toISOString(),
        credentialFingerprint: createHash('sha256').update(String(gitcodeToken || '').trim()).digest('hex').slice(0, 16),
        notes: [],
    };
    const value = String(gitcodeToken || '').trim();
    if (!value) {
        out.notes.push('未提供令牌');
        return out;
    }

    try {
        const user = await _fetchJson(`${GITCODE_API_BASE}/user`, value);
        if (user.status === 200) {
            out.login = String(user.body?.login || '').trim();
            out.identity = out.login ? CAPABILITY_OK : CAPABILITY_UNKNOWN;
        } else if (user.status === 401 || user.status === 403) {
            out.identity = CAPABILITY_DENIED;
            out.notes.push(`身份校验返回 HTTP ${user.status}`);
        } else {
            out.notes.push(`身份校验返回 HTTP ${user.status}`);
        }
    } catch (e) {
        out.notes.push(`身份校验失败：${e.message}`);
    }

    if (out.identity !== CAPABILITY_OK || !owner || !repo) return out;

    try {
        const repoResp = await _fetchJson(
            `${GITCODE_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
            value,
        );
        if (repoResp.status === 200) {
            out.read = CAPABILITY_OK;
            out.notes.push('仓库成员角色不能证明令牌的评论 scope 或目标分支推送能力，分别标记为未知');
        } else if (repoResp.status === 404) {
            out.read = CAPABILITY_DENIED;
            out.notes.push('仓库不存在或令牌无权访问');
        } else {
            out.notes.push(`仓库读取返回 HTTP ${repoResp.status}`);
        }
    } catch (e) {
        out.notes.push(`仓库读取失败：${e.message}`);
    }

    return out;
}

// ─── 探测结果缓存（按「身份|owner/repo」） ─────────────────────────────────────

function _readStore() {
    try {
        return JSON.parse(readFileSync(CAPABILITIES_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function _writeStore(store) {
    try {
        mkdirSync(join(homedir(), '.aceharness', 'data'), { recursive: true });
        const tmp = `${CAPABILITIES_FILE}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(store, null, 2));
        renameSync(tmp, CAPABILITIES_FILE);
    } catch (e) {
        logger.warn('能力探测结果写入失败', { error: e.message });
    }
}

/** 缓存键：身份（小写）+ 仓库 */
export function capabilityKey(login, owner = '', repo = '') {
    const id = String(login || '').trim().toLowerCase();
    const repoKey = owner && repo ? `${owner}/${repo}`.toLowerCase() : '';
    return repoKey ? `${id}|${repoKey}` : `${id}|`;
}

/**
 * 判断一次推送失败是否属于「权限被拒」。
 * 只有明确的权限信号才算 denied；超时/网络/非快进等一律不算，避免把普通失败误报成 403。
 */
export function isPermissionFailure(status) {
    const s = String(status || '').trim();
    if (!s) return false;
    if (/timeout|network|socket|econn|fetch failed|rate.?limit|429|non-?fast|stale info|conflict|锁|超时/i.test(s)) return false;
    return /403|forbidden|permission|denied|无(写)?权限|upload permission|拒绝/i.test(s);
}

/** 保存某身份在某仓库的探测结果（可带凭据指纹，用于判断凭据是否已更新） */
export function saveCapabilities(login, owner, repo, capabilities, fingerprint = null) {
    if (!login) return;
    const store = _readStore();
    store[capabilityKey(login, owner, repo)] = {
        ...capabilities,
        credentialFingerprint: fingerprint || capabilities?.credentialFingerprint || null,
    };
    _writeStore(store);
}

/**
 * 读取缓存的探测结果；无则返回 null。
 * 若提供 fingerprint 且与缓存记录不一致（令牌已更换），视为失效返回 null。
 */
export function loadCapabilities(login, owner = '', repo = '', fingerprint = null) {
    if (!login) return null;
    const store = _readStore();
    const entry = store[capabilityKey(login, owner, repo)] || null;
    if (entry && (Date.now() - Date.parse(entry.checkedAt || '') > 300000 || !entry.checkedAt)) return null;
    if (entry && fingerprint && entry.credentialFingerprint !== fingerprint) return null;
    return entry;
}

/** 令牌更新/删除时清空该身份的所有能力缓存，避免旧结论被沿用。 */
export function clearCapabilitiesForLogin(login) {
    const id = String(login || '').trim().toLowerCase();
    if (!id) return 0;
    const store = _readStore();
    const prefix = `${id}|`;
    let removed = 0;
    for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) { delete store[key]; removed += 1; }
    }
    if (removed) _writeStore(store);
    return removed;
}

/**
 * 结合「令牌是否已绑定」「缓存探测结果」「本次 run 的推送结果」推导当前 PR 的能力视图。
 * 推送结果只在明确权限失败时才判 denied；其他失败如实呈现原因，不谎称 403。
 * @returns {{identity,read,comment,push,bound,checkedAt,notes,blocked,blockedReason}}
 */
export function deriveCapabilities({ bound = false, login = '', stored = null, pushFailed = false, pushSucceeded = false, pushStatus = '', currentFingerprint = '', evidenceFingerprint = '' } = {}) {
    const caps = {
        identity: stored?.identity || CAPABILITY_UNKNOWN,
        read: stored?.read || CAPABILITY_UNKNOWN,
        comment: stored?.comment || CAPABILITY_UNKNOWN,
        push: stored?.push || CAPABILITY_UNKNOWN,
        bound: !!bound,
        checkedAt: stored?.checkedAt || null,
        notes: Array.isArray(stored?.notes) ? [...stored.notes] : [],
        blocked: false,
        blockedReason: '',
    };
    if (!bound) {
        caps.blocked = true;
        caps.blockedReason = '尚未绑定可用于该 PR 的 GitCode 令牌';
        return caps;
    }
    const matchingCredential = !!currentFingerprint && currentFingerprint === evidenceFingerprint;
    if (pushSucceeded && matchingCredential) {
        caps.push = CAPABILITY_OK;
    }
    if (pushFailed && matchingCredential) {
        caps.blocked = true;
        if (isPermissionFailure(pushStatus)) {
            caps.push = CAPABILITY_DENIED;
            caps.permissionDenied = true;
            caps.blockedReason = '令牌推送被拒绝（403/无写权限），需重新绑定具备写权限的令牌后再继续';
        } else {
            // 非权限失败：不谎称 403，保留 push 的既有判断（未知即未知）
            caps.blockedReason = `推送未完成：${String(pushStatus || '失败')}（请核对任务状态和 PR 后重试）`;
        }
    }
    if (pushFailed && !matchingCredential) caps.notes.push('历史推送失败未绑定当前凭据，当前推送能力保持未知，请查看操作失败原因');
    return caps;
}
