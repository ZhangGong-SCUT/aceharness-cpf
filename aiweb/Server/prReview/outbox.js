/**
 * R09：可靠通知出站（outbox）
 *
 * 通知（邮件/机器人回执）先持久化为待发送记录，再投递；具备：
 *   - 去重：相同 dedupeKey 在窗口内不重复入队（同一事件不刷屏）；
 *   - 重试：失败按指数退避安排下次尝试，可投递/不可投递分别记录；
 *   - 投递结果：sent / failed 与其时间、错误、尝试次数；
 *   - 可见性：status() 汇总待发送、失败、24h 已发送，便于"SMTP 未配置/发送失败可见"。
 *
 * 存储：~/.aceharness/data/aiweb-notify-outbox.json（原子写）。
 */

import { aceDataDir, aceRunsDir, aceRuntimeRoot } from '../library/aceRuntime.js';
import { createHash, randomUUID } from 'crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '../library/logger.js';

const logger = createLogger('PrReviewOutbox');
const OUTBOX_FILE = join(aceDataDir(), 'aiweb-notify-outbox.json');
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 2000;

function _read() {
    try {
        const data = JSON.parse(readFileSync(OUTBOX_FILE, 'utf8'));
        return Array.isArray(data?.items) ? data.items : [];
    } catch { return []; }
}
function _write(items) {
    try {
        mkdirSync(aceDataDir(), { recursive: true });
        const tmp = `${OUTBOX_FILE}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ items }, null, 2));
        renameSync(tmp, OUTBOX_FILE);
    } catch (e) {
        logger.error('通知出站写入失败', { error: e.message });
        throw e;
    }
}
function _prune(items, now) {
    return items
        .filter((item) => !(item.status === 'sent' && now - (item.sentAt || 0) > SENT_RETENTION_MS))
        .slice(-MAX_ITEMS);
}
export function outboxDedupeKey(kind, ref) {
    return createHash('sha256').update(`${kind}|${ref}`).digest('hex').slice(0, 24);
}

/**
 * 入队一条待发送通知。相同 dedupeKey 在窗口内视为重复，不重复入队。
 * @returns {{id: string|null, duplicate: boolean}}
 */
export function enqueue(record, now = Date.now()) {
    const items = _read();
    const dedupeKey = record.dedupeKey || '';
    if (dedupeKey && items.some((item) => item.dedupeKey === dedupeKey && now - (item.createdAtMs || 0) < DEDUPE_WINDOW_MS)) {
        return { id: null, duplicate: true };
    }
    const id = randomUUID();
    items.push({
        id, kind: record.kind || 'email', to: record.to || '', subject: record.subject || '',
        body: record.body || '', dedupeKey, meta: record.meta || {},
        status: 'pending', attempts: 0, createdAt: new Date(now).toISOString(), createdAtMs: now,
        nextAttemptAt: now, lastError: null,
    });
    _write(_prune(items, now));
    return { id, duplicate: false };
}

/** 到期待发送（供投递器轮询）。 */
export function listPending(now = Date.now()) {
    return _read().filter((item) => item.status === 'pending' && (item.nextAttemptAt || 0) <= now);
}

export function markSent(id, result = {}, now = Date.now()) {
    const items = _read();
    const item = items.find((x) => x.id === id);
    if (!item) return null;
    item.status = 'sent';
    item.sentAt = now;
    item.result = result;
    item.lastError = null;
    _write(_prune(items, now));
    return item;
}

export function markFailed(id, error, { retryable = true, maxAttempts = 5 } = {}, now = Date.now()) {
    const items = _read();
    const item = items.find((x) => x.id === id);
    if (!item) return null;
    item.attempts = (item.attempts || 0) + 1;
    item.lastError = String(error || '发送失败');
    const giveUp = !retryable || item.attempts >= maxAttempts;
    if (giveUp) {
        item.status = 'failed';
        item.finishedAt = now;
    } else {
        item.status = 'pending';
        item.nextAttemptAt = now + Math.min(60_000, 2000 * 2 ** Math.min(item.attempts, 5));
    }
    _write(_prune(items, now));
    return item;
}

export function getItem(id) {
    return _read().find((x) => x.id === id) || null;
}

/** 供页面/诊断查看（脱敏：不返回正文）。 */
export function status(now = Date.now()) {
    const items = _read();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const pending = items.filter((x) => x.status === 'pending');
    return {
        pending: pending.length,
        failed: items.filter((x) => x.status === 'failed').length,
        sent24h: items.filter((x) => x.status === 'sent' && (x.sentAt || 0) >= dayAgo).length,
        oldestWaitMs: pending.length ? now - Math.min(...pending.map((x) => x.createdAtMs || now)) : 0,
        nextAttemptAt: pending.length ? Math.min(...pending.map((x) => x.nextAttemptAt || now)) : null,
        items: items.slice(-50).map((x) => ({
            id: x.id, kind: x.kind, status: x.status, attempts: x.attempts,
            subject: x.subject, lastError: x.lastError || null,
            nextAttemptAt: x.nextAttemptAt || null, sentAt: x.sentAt || null,
        })),
    };
}
