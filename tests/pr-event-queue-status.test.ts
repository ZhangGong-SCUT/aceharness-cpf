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
    expect(status.p50ms).toBeGreaterThan(0);
    expect(status.p95ms).toBeGreaterThanOrEqual(status.p50ms);
    expect(status.failureRate24h).toBeCloseTo(0.5, 5);
    expect(status.prs['cfg:key1'].lastStatus).toBe(200);
    expect(status.prs['cfg:key2'].pending).toBe(1);
    expect(status.prs['cfg:key2'].retrying).toBe(1);
    expect(status.prs['cfg:key2'].nextDueAt).toBeGreaterThan(now);
  });
});
