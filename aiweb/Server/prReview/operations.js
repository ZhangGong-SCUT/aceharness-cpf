/**
 * PR 修复操作记录（R01）
 *
 * 目的：把「用户认可 → 待应用 → 已提交 → 已推送 → 待 CI → 已验证 / 受阻」这条链路
 * 落成持久化记录，作为跨重启、跨请求的操作凭据：
 *   - 每个动作有稳定的幂等键（仓库+PR+原始 head+patch 哈希+动作类型）；
 *   - 进行中/已成功的同键动作不会被重复执行（防连点、防请求重放导致重复推送/重复触发构建）；
 *   - 记录关联的用户决策、patch 哈希、基线 head、执行 run、commit/远端 SHA、构建触发凭据；
 *   - 失败可定位到具体动作，并允许在证据允许时重试。
 *
 * 存储：SQLite WAL + 唯一键 + 事务；首次迁移旧 JSON，保留源文件。
 * 注意：跨 GitCode 与本地存储无法用单事务保证「恰好一次」，因此采用
 * 「幂等键 + 可重试 + 远端结果对账」。
 */

import { createHash, randomUUID } from 'crypto';
import { readFileSync, mkdirSync, chmodSync } from 'fs';
import Database from 'better-sqlite3';
import { readExecutionEvidence } from './executionEvidence.js';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '../library/logger.js';

const logger = createLogger('PrReviewOperations');

const OPERATIONS_FILE = join(homedir(), '.aceharness', 'data', 'aiweb-pr-operations.json');
let database;
function db() {
    if (database) return database;
    const dir = join(homedir(), '.aceharness', 'data');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'aiweb-pr-operations.sqlite');
    const connection = new Database(file);
    chmodSync(file, 0o600);
    connection.pragma('journal_mode = WAL');
    connection.pragma('busy_timeout = 5000');
    connection.exec('CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS migration (id INTEGER PRIMARY KEY)');
    connection.transaction(() => {
        if (connection.prepare('SELECT id FROM migration WHERE id=1').get()) return;
        let legacy = {};
        try { legacy = JSON.parse(readFileSync(OPERATIONS_FILE, 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (!legacy || Array.isArray(legacy) || typeof legacy !== 'object') throw new Error('操作记录格式错误，拒绝覆盖');
        const insert = connection.prepare('INSERT OR IGNORE INTO operations VALUES (?, ?)');
        for (const [key, value] of Object.entries(legacy)) insert.run(key, JSON.stringify(value));
        connection.prepare('INSERT INTO migration VALUES (1)').run();
    }).immediate();
    database = connection;
    return database;
}

/** 展示状态（页面按此顺序渲染） */
export const OPERATION_STATES = ['approved', 'to_apply', 'submitted', 'pushed', 'waiting_ci', 'verified', 'blocked'];
export const OPERATION_STATE_LABELS = {
    approved: '已认可',
    to_apply: '待应用',
    submitted: '已提交',
    pushed: '已推送',
    waiting_ci: '待 CI',
    verified: '已验证',
    blocked: '受阻',
};

function _readAll() {
    return Object.fromEntries(db().prepare('SELECT key,data FROM operations').all().map(r => [r.key, JSON.parse(r.data)]));
}

function _writeOperation(key, value) {
    db().prepare('INSERT OR REPLACE INTO operations VALUES (?, ?)').run(key, JSON.stringify(value));
}

/** patch 哈希（用于幂等键与证据） */
export function hashPatch(patch) {
    return createHash('sha256').update(String(patch || '')).digest('hex').slice(0, 16);
}

/** 动作幂等键：仓库 + PR + 原始 head + patch 哈希 + 动作类型 */
export function operationKey({ owner, repo, number, origHead, patchHash, action }) {
    return createHash('sha256')
        .update([owner, repo, number, origHead || '', patchHash || '', action].join('|'))
        .digest('hex')
        .slice(0, 32);
}

export function findOperation(key) {
    const row = db().prepare('SELECT data FROM operations WHERE key=?').get(key);
    return row ? JSON.parse(row.data) : null;
}

/**
 * 开始一个操作：同键若处于 pending/running/succeeded，则视为重复，返回既有记录。
 * failed/blocked 允许重新开始（重试）。
 * 例外：pending 且明确仍为 prepared（从未派发）超过租约时间可回收重试——
 * 此时外部动作尚未发生，重试不会造成重复推送。
 * @returns {{created: boolean, operation: object}}
 */
const PENDING_RECLAIM_MS = 120_000;

export function beginOperation(record) {
    return db().transaction(() => {
    const existing = findOperation(record.key);
    const nowMs = Date.now();
    const existingAge = existing ? nowMs - Date.parse(existing.updatedAt || existing.createdAt || 0) : 0;
    const reclaimablePending = existing?.status === 'pending' && existing.dispatchState === 'prepared' && existingAge > PENDING_RECLAIM_MS;
    if (existing && !reclaimablePending && (['pending', 'running', 'succeeded', 'uncertain'].includes(existing.status)
        || existing.retrySafe === false)) {
        return { created: false, operation: existing };
    }
    const now = new Date().toISOString();
    const operation = {
        ...record,
        status: 'pending',
        state: record.state || 'to_apply',
        attempts: (existing?.attempts || 0) + 1,
        attemptId: randomUUID(),
        dispatchState: 'prepared',
        runId: record.runId || `run-${Date.now()}-pr${String(record.number || '0').replace(/\D/g, '')}-${randomUUID().slice(0, 8)}`,
        history: existing ? [...(existing.history || []), { runId: existing.runId, status: existing.status, state: existing.state, updatedAt: existing.updatedAt }] : [],
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };
    if (record.decision) operation.decision = { ...record.decision, newRunId: operation.runId, operationKey: record.key };
    _writeOperation(record.key, operation);
    return { created: true, operation };
    }).immediate();
}

/** 更新操作记录（合并字段）；记录不存在时返回 null */
export function patchOperation(key, patch, attemptId) {
    return db().transaction(() => {
    const current = findOperation(key);
    if (!current) return null;
    if (attemptId && current.attemptId !== attemptId) throw new Error('操作尝试已变化，请刷新状态');
    if (Object.entries(patch).every(([k,v]) => JSON.stringify(current[k]) === JSON.stringify(v))) return current;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    _writeOperation(key, next);
    return next;
    }).immediate();
}

/** 列出与某 run（作为发起 run 或执行 run）相关的操作记录 */
export function listOperations({ runId, repo, number } = {}) {
    const all = _readAll();
    let list = Object.values(all);
    if (runId) list = list.filter((op) => op.sourceRunId === runId || op.runId === runId);
    if (repo && number) list = list.filter((op) => op.repo === repo && String(op.number) === String(number));
    return list.sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
}

/**
 * 依据执行 run 的证据推导操作的展示状态。只依据结构化事实：
 *   - 有实际 commit SHA 才算「已提交」；
 *   - 核对到远端 SHA 才算「已推送」；
 *   - 有构建触发凭据才算「待 CI」；
 *   - 只有同一 SHA 的所需检查通过才算「已验证」；
 *   - 仅受理/执行中（无 commit 证据）只能算「待应用」。
 * 推送结果与错误分类由 evidence 传入，不在此处臆测 HTTP 状态。
 */
export function deriveOperationState(op, evidence = {}) {
    const { pushSucceeded, pushFailed, runStatus, commitSha, remoteHeadSha, buildCredential, ciPassed, ciSha } = evidence;
    const rs = String(runStatus || '').toLowerCase();
    const pushed = pushSucceeded && commitSha && remoteHeadSha === commitSha;
    if (pushed && ciPassed && ciSha === commitSha) return 'verified';
    if (pushed) return buildCredential ? 'waiting_ci' : 'pushed';
    if (pushFailed || ['failed', 'crashed', 'stopped'].includes(rs)) return 'blocked';
    if (commitSha) return 'submitted';
    if (!rs && op?.state) return op.state;
    return 'to_apply';
}

/**
 * 用对账证据刷新一条操作记录并返回最新值（不改变幂等键）。
 * 同步更新控制用的 status：blocked→failed（允许安全重试），verified→succeeded（锁定），
 * 其余保持 running。这样执行失败后同键重试不会被永久拒绝。
 */
export function reconcileOperation(key, evidence = {}) {
    return db().transaction(() => {
    const op = findOperation(key);
    if (!op) return null;
    if (evidence.evidenceRunId && evidence.evidenceRunId !== op.runId) return op;
    if (!evidence.runStatus && !evidence.pushStatus && !evidence.commitSha && !evidence.ciObserved && !evidence.buildCredential) return op;
    const patch = {};
    if (evidence.commitSha && op.commitSha && evidence.commitSha !== op.commitSha) {
        Object.assign(patch, { remoteHeadSha: '', pushStatus: '', pushSucceeded: false, pushFailed: false,
            buildCredential: null, ciPassed: false, ciSha: '' });
    }
    if (typeof evidence.commitSha === 'string' && evidence.commitSha) patch.commitSha = evidence.commitSha;
    if (typeof evidence.remoteHeadSha === 'string' && evidence.remoteHeadSha) patch.remoteHeadSha = evidence.remoteHeadSha;
    if (evidence.buildCredential) patch.buildCredential = evidence.buildCredential;
    if (typeof evidence.runStatus === 'string' && evidence.runStatus) patch.runStatus = evidence.runStatus;
    if (evidence.pushStatus) {
        patch.pushStatus = evidence.pushStatus;
        patch.pushSucceeded = !!evidence.pushSucceeded;
        patch.pushFailed = !!evidence.pushFailed;
    } else if (evidence.pushSucceeded && evidence.commitSha && evidence.remoteHeadSha === evidence.commitSha) {
        patch.pushSucceeded = true; patch.pushFailed = false;
    }
    if (evidence.ciSha && (evidence.ciPassed || evidence.ciObserved)) {
        patch.ciPassed = !!evidence.ciPassed; patch.ciSha = evidence.ciSha;
    }
    if (evidence.evidenceRunId !== undefined) patch.evidenceRunId = evidence.evidenceRunId;
    const facts = { ...op, ...patch };
    const state = deriveOperationState(op, facts);
    patch.state = state;
    if (state === 'blocked') {
        const terminal = ['failed', 'crashed', 'stopped'].includes(facts.runStatus);
        patch.status = terminal ? 'failed' : 'running';
        patch.retrySafe = terminal && !facts.pushSucceeded;
        patch.error = evidence.error || op.error || evidence.pushStatus || '执行任务已结束，请核对当前 PR 后重试';
    }
    else if (['pushed', 'waiting_ci', 'verified'].includes(state)) { patch.status = 'succeeded'; patch.retrySafe = false; patch.error = null; }
    else patch.status = 'running';
    return patchOperation(key, patch);
    }).immediate();
}

let recoveryTimer;
export function startOperationReconciler() {
    if (recoveryTimer) return;
    recoveryTimer = setInterval(() => {
        try {
            for (const op of listOperations()) {
                if (op.state === 'verified' || (op.status === 'failed' && op.retrySafe)) continue;
                if (op.runId) reconcileOperation(op.key, readExecutionEvidence(op.runId));
            }
        } catch (error) { logger.error('操作回执恢复失败', { error: error.message }); }
    }, 10000);
    recoveryTimer.unref?.();
}
