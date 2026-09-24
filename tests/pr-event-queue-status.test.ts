import { describe, expect, test } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrEventQueue } from '@/lib/workflow/pr-event-queue';

describe('PrEventQueue status（R04 监控健康与时延）', () => {
  test('reports p50/p95, failure rate and per-PR health', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'prq-')), 'q.json');
    let now = 1_000_000;
    let result: { status: number; reason: string } = { status: 200, reason: '' };
    const q = new PrEventQueue(file, async () => result, () => now);

    await q.enqueue('cfg:key1', { a: 1 });
    now += 5000;
    await q.drain(); // 成功，排队 5000ms → 产生一条 receipt

    await q.enqueue('cfg:key2', { b: 2 });
    result = { status: 503, reason: 'temporary' };
    now += 1000;
    await q.drain(); // 5xx → 保留并重试，不产生 receipt

    await q.enqueue('cfg:key3', { c: 3 });
    result = { status: 400, reason: 'bad request' };
    now += 1000;
    await q.drain(); // 4xx 非重试 → 产生一条失败 receipt

    const status = await q.status();
    expect(status.samples24h).toBe(2);
    expect(status.retryAttempts24h).toBe(1);
    expect(status.p50ms).toBeGreaterThan(0);
    expect(status.p95ms).toBeGreaterThanOrEqual(status.p50ms);
    // 失败率把重试尝试也算入：(1 条失败 receipt + 1 次重试) / (2 条 receipt + 1 次重试)
    expect(status.failureRate24h).toBeCloseTo(2 / 3, 3);
    expect(status.prs['cfg:key1'].lastStatus).toBe(200);
    expect(status.prs['cfg:key2'].pending).toBe(1);
    expect(status.prs['cfg:key2'].retrying).toBe(1);
    expect(status.prs['cfg:key2'].lastError).toBeTruthy();
    expect(status.prs['cfg:key2'].nextDueAt).toBeGreaterThan(now);
  });

  test('retains failed attempts after success and restart, expires them after 24h', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'prq-')), 'q.json');
    let now = 1000000;
    let status = 503;
    const dispatch = async () => ({ status, reason: status === 503 ? 'temporary failure' : 'ok' });
    const q = new PrEventQueue(file, dispatch, () => now);
    await q.enqueue('cfg:pr', {}); now += 1000; await q.drain();
    status = 200; now += 60000; await q.drain();
    const restarted = new PrEventQueue(file, dispatch, () => now);
    const health = await restarted.status();
    expect(health.failureRate24h).toBe(0.5);
    expect(health.retryAttempts24h).toBe(1);
    expect(health.prs['cfg:pr'].lastError).toBeNull();
    now += 86400001;
    const expired = await restarted.status();
    expect(expired.attempts24h).toBe(0);
    expect(expired.retryAttempts24h).toBe(0);
    expect(expired.prs['cfg:pr']).toBeUndefined();
  });

  test('capacity waits are visible separately from service failures', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'prq-')), 'q.json');
    let now = 1000000;
    const q = new PrEventQueue(file, async () => ({ status: 409, reason: 'busy' }), () => now);
    await q.enqueue('cfg:pr', {}); now += 1000; await q.drain();
    const health = await q.status();
    expect(health.capacityWaits24h).toBe(1);
    expect(health.failureRate24h).toBe(0);
  });
});
