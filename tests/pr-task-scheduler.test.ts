import { describe, expect, test } from 'vitest';
import { PrTaskScheduler, classifyDispatchClass } from '@/lib/workflow/pr-task-scheduler';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PrTaskScheduler（R06 分类型调度）', () => {
  test('serializes the same PR and lets a different PR proceed', async () => {
    const s = new PrTaskScheduler({ read: 4, ai: 1, build: 2, write: 2 });
    const releaseA = await s.acquire('pr1', 'ai');
    let bGranted = false;
    const bPromise = s.acquire('pr2', 'ai').then((release) => { bGranted = true; return release; });
    await tick();
    expect(bGranted).toBe(false); // 类别上限 1，pr2 等待
    releaseA();
    const releaseB = await bPromise;
    expect(bGranted).toBe(true);
    releaseB();
    expect(s.status().running).toBe(0);
  });

  test('a busy PR does not block other PRs (fairness skip)', async () => {
    const s = new PrTaskScheduler({ read: 4, ai: 1, build: 2, write: 2 });
    const releaseA = await s.acquire('pr1', 'ai');
    const order: string[] = [];
    const p1b = s.acquire('pr1', 'ai').then((r) => { order.push('pr1b'); return r; });
    const p2 = s.acquire('pr2', 'ai').then((r) => { order.push('pr2'); return r; });
    await tick();
    expect(order).toEqual([]);
    releaseA();
    const releaseP2 = await p2;
    await tick();
    expect(order).toEqual(['pr2']); // 排在前面的 pr1 因自身忙碌被跳过
    releaseP2();
    const releaseP1b = await p1b;
    releaseP1b();
  });

  test('reports per-class and per-PR status', async () => {
    const s = new PrTaskScheduler({ read: 4, ai: 2, build: 2, write: 2 });
    const r1 = await s.acquire('pr1', 'ai');
    const r2 = await s.acquire('pr2', 'write');
    const st = s.status();
    expect(st.running).toBe(2);
    expect(st.runningByClass.ai).toBe(1);
    expect(st.runningByClass.write).toBe(1);
    expect(st.runningByPr.pr1).toBe(1);
    r1(); r2();
  });

  test('classifies poll events as read and others as ai', () => {
    expect(classifyDispatchClass({ hook_name: 'monitor_poll' })).toBe('read');
    expect(classifyDispatchClass({ monitor_poll: 1 })).toBe('read');
    expect(classifyDispatchClass({ action: 'closed', hook_name: 'merge_request' })).toBe('read');
    expect(classifyDispatchClass({ action: 'open', hook_name: 'pull_request' })).toBe('ai');
  });
});
