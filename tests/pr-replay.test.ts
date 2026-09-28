import { describe, expect, test } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrEventQueue } from '@/lib/workflow/pr-event-queue';

/**
 * R10：离线回放固定场景（脱敏事件），记录成功率/重试/耗时基线。
 * 不发送任何真实评论或推送；dispatch 为模拟实现。
 */
type Scenario = {
  name: string;
  events: Array<{ key: string; payload: unknown; advanceMsBefore?: number }>;
  dispatch: (payload: any, state: { calls: number }) => { status: number; reason: string; started?: boolean; woken?: boolean };
  expected: { queued?: number; dispatched?: number; duplicated?: number; retried?: number; hardFailed?: number };
};

async function replay(scenario: Scenario) {
  const dir = await mkdtemp(join(tmpdir(), 'pr-replay-'));
  let clock = 1_000_000;
  const calls: Array<{ key: string; payload: any }> = [];
  const state = { calls: 0 };
  const q = new PrEventQueue(join(dir, 'queue.json'), async (payload: any) => {
    calls.push({ key: '', payload });
    state.calls += 1;
    return scenario.dispatch(payload, state);
  }, () => clock);

  const enqueueResults: Array<{ queued: boolean; duplicate: boolean }> = [];
  for (const event of scenario.events) {
    if (event.advanceMsBefore) clock += event.advanceMsBefore;
    const r: any = await q.enqueue(event.key, event.payload);
    enqueueResults.push({ queued: r.queued, duplicate: !!r.duplicate });
  }
  // 推进时间并反复 drain 直到队列稳定
  for (let i = 0; i < 20; i += 1) {
    clock += 60_000;
    await q.drain();
  }
  const status = await q.status();
  return { status, enqueueResults, calls, clock };
}

const scenarios: Scenario[] = [
  {
    name: 'duplicate webhook is merged',
    events: [
      { key: 'cfg:o/r#1', payload: { a: 1 } },
      { key: 'cfg:o/r#1', payload: { a: 1 } },
    ],
    dispatch: () => ({ status: 200, reason: 'ok', started: true }),
    expected: { dispatched: 1, duplicated: 1 },
  },
  {
    name: 'newer revision supersedes older and only newest is dispatched',
    events: [{ key: 'cfg:o/r#2', payload: { rev: 'a' } }, { key: 'cfg:o/r#2', payload: { rev: 'b' } }],
    dispatch: () => ({ status: 200, reason: 'ok' }),
    expected: { dispatched: 1 },
  },
  {
    name: '429 then success is retried',
    events: [{ key: 'cfg:o/r#3', payload: { a: 3 } }],
    dispatch: (_p, s) => (s.calls <= 1 ? { status: 429, reason: 'rate limited' } : { status: 200, reason: 'ok' }),
    expected: { dispatched: 2, retried: 1 },
  },
  {
    name: 'hard 400 failure is not retried',
    events: [{ key: 'cfg:o/r#4', payload: { a: 4 } }],
    dispatch: () => ({ status: 400, reason: 'bad request' }),
    expected: { dispatched: 1, hardFailed: 1 },
  },
];

describe('R10 离线回放基线', () => {
  test('fixed scenarios produce stable outcomes and a baseline artifact', async () => {
    const report: any = { scenarios: [] };
    for (const scenario of scenarios) {
      const { status, enqueueResults, calls } = await replay(scenario);
      if (scenario.expected.dispatched !== undefined) {
        expect(calls.length, `${scenario.name} dispatch count`).toBe(scenario.expected.dispatched);
      }
      if (scenario.expected.duplicated !== undefined) {
        expect(enqueueResults.filter((r) => r.duplicate).length, `${scenario.name} duplicates`).toBe(scenario.expected.duplicated);
      }
      if (scenario.expected.hardFailed !== undefined) {
        // 非重试失败产生一条 receipt（recentDispatchMs），不进入 retrying
        expect(status.recentDispatchMs.length).toBeGreaterThanOrEqual(scenario.expected.hardFailed);
      }
      report.scenarios.push({
        name: scenario.name,
        dispatched: calls.length,
        duplicated: enqueueResults.filter((r) => r.duplicate).length,
        pending: status.pending,
        failureRate24h: status.failureRate24h,
      });
    }
    report.generatedAt = new Date().toISOString();
    report.note = '离线回放，不发送真实评论或推送；样本为本机模拟。';
    const baseline = JSON.parse(await readFile(join(process.cwd(), 'docs', 'pr-replay-baseline.json'), 'utf8'));
    expect(report.scenarios).toEqual(baseline.scenarios);
  });

  test('a restart reloads queued events from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pr-replay-restart-'));
    const file = join(dir, 'queue.json');
    let clock = 1_000_000;
    const q1 = new PrEventQueue(file, async () => ({ status: 500, reason: 'during restart' }), () => clock);
    await q1.enqueue('cfg:o/r#9', { a: 9 });
    // 模拟进程在派发前退出：新实例从磁盘恢复
    const dispatched: any[] = [];
    const q2 = new PrEventQueue(file, async (payload: any) => { dispatched.push(payload); return { status: 200, reason: 'ok' }; }, () => clock);
    clock += 60_000;
    await q2.drain();
    expect(dispatched.length).toBe(1);
    expect((await q2.status()).pending).toBe(0);
  });

  test('long comment payload is handled without truncation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pr-replay-long-'));
    let clock = 1_000_000;
    const seen: number[] = [];
    const q = new PrEventQueue(join(dir, 'queue.json'), async (payload: any) => { seen.push(payload.comment.length); return { status: 200, reason: 'ok' }; }, () => clock);
    await q.enqueue('cfg:o/r#10', { comment: 'x'.repeat(200_000) });
    clock += 60_000;
    await q.drain();
    expect(seen[0]).toBe(200_000);
  });
});
