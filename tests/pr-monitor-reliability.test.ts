import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrEventQueue } from '@/lib/workflow/pr-event-queue';
import { isPersistedHumanWait, mergePrEventContext } from '@/lib/workflow/pr-monitor-state';
import { decideGitcodeWebhookRun } from '@/lib/workflow/pr-monitor-policy';
import { gitcodeRead, gitcodeReadPages } from '../skills/gitcode-pr-review/scripts/gitcode-read.mjs';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture(dispatch = vi.fn(async (_payload: unknown) => ({ status: 202, reason: 'done' }))) {
  const dir = await mkdtemp(join(tmpdir(), 'pr-monitor-')); dirs.push(dir);
  let now = 1000;
  const file = join(dir, 'queue.json');
  return { file, dispatch, clock: () => now, advance: (n = 1000) => { now += n; }, queue: new PrEventQueue(file, dispatch, () => now) };
}

test('burst events coalesce and only the latest PR snapshot is dispatched', async () => {
  const f = await fixture();
  for (let i = 0; i < 100; i++) await f.queue.enqueue('pr1', { sha: i });
  expect((await f.queue.status()).pending).toBe(1);
  await f.queue.drain(); expect(f.dispatch).not.toHaveBeenCalled();
  f.advance(); await f.queue.drain();
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith({ sha: 99 });
  expect((await f.queue.status()).pending).toBe(0);
});
test('queued notifications survive process restart', async () => {
  const f = await fixture(); await f.queue.enqueue('pr1', { sha: 'a' }); f.advance();
  const restored = new PrEventQueue(f.file, f.dispatch, f.clock);
  await restored.drain(); expect(f.dispatch).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(f.file, 'utf8')).jobs).toHaveLength(0);
});
test('capacity pressure and transient failures retain jobs with bounded retry delay', async () => {
  const f = await fixture(vi.fn().mockResolvedValueOnce({ status: 409 }).mockRejectedValueOnce(new Error('network')).mockResolvedValue({ status: 202 }));
  await f.queue.enqueue('pr1', {}); f.advance(); await f.queue.drain();
  expect(await f.queue.status()).toMatchObject({ pending: 1, retrying: 1 });
  f.advance(5000); await f.queue.drain(); expect((await f.queue.status()).pending).toBe(1);
  f.advance(60000); await f.queue.drain(); expect((await f.queue.status()).pending).toBe(0);
});
test('an update received during dispatch is not deleted by completion of an older event', async () => {
  let release!: () => void;
  const f = await fixture(vi.fn(async () => { await new Promise<void>(r => { release = r; }); return { status: 202, reason: 'ok' }; }));
  await f.queue.enqueue('pr1', { sha: 'a' }); f.advance();
  const draining = f.queue.drain();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await f.queue.enqueue('pr1', { sha: 'b' }); release(); await draining;
  expect((await f.queue.status()).pending).toBe(1);
});
test('slow PR does not block unrelated PR; concurrent drain calls never duplicate dispatch', async () => {
  let release!: () => void;
  const calls: number[] = [];
  const f = await fixture(vi.fn(async (payload: any) => {
    calls.push(payload.id);
    if (payload.id === 1) await new Promise<void>(r => { release = r; });
    return { status: 202, reason: 'ok' };
  }));
  await f.queue.enqueue('pr1', { id: 1 }); await f.queue.enqueue('pr2', { id: 2 }); f.advance();
  const draining = f.queue.drain();
  await vi.waitFor(() => expect(calls).toEqual([1, 2]));
  await f.queue.drain(); expect(calls).toHaveLength(2); release(); await draining;
});
test('redelivery shortly after completion is deduplicated', async () => {
  const f = await fixture(); await f.queue.enqueue('pr1', {}); f.advance(); await f.queue.drain();
  expect(await f.queue.enqueue('pr1', {})).toMatchObject({ duplicate: true, queued: false });
});
test('approval waiting survives restart only with a real unanswered question', () => {
  const state = { currentState: '__human_approval__', pendingHumanQuestionId: 'q', humanQuestions: [{ id: 'q', status: 'unanswered' }] };
  expect(isPersistedHumanWait(state)).toBe(true);
  expect(isPersistedHumanWait({ ...state, humanQuestions: [] })).toBe(false);
  expect(isPersistedHumanWait({ ...state, currentState: '静态修复' })).toBe(false);
});
test('thousands of notifications retain user instructions without growing the prompt', () => {
  const initial = 'pr_url: https://gitcode.com/org/repo/pull/1\nuser_apply_patch: source-run';
  let context = initial;
  for (let i = 0; i < 1000; i++) context = mergePrEventContext(context, `head_sha: ${i}`);
  expect(context).toContain(initial); expect(context).toContain('999'); expect(context.length).toBeLessThan(200);
});
test('idle gate waits and user decisions do not consume active execution slots', () => {
  const waiting = Array.from({ length: 12 }, (_, i) => ({ runId: `run-${i}`, status: 'running', currentState: '挂起',
    globalContext: `owner: org\nrepo: repo\nnumber: ${i + 1}` }));
  expect(decideGitcodeWebhookRun({ incoming: { owner: 'org', repo: 'repo', number: '99' } as any, running: waiting, maxParallel: 1 }).action).toBe('start');
  expect(decideGitcodeWebhookRun({ incoming: { owner: 'org', repo: 'repo', number: '1' } as any,
    running: [{ ...waiting[0], waitingFor: 'user_decision' }] }).action).toBe('ignore');
});
test('GitCode reader retries a transient read once; never retries authorization failures', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch); expect(await gitcodeRead('/pr', 'secret')).toEqual({ ok: true }); expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockReset().mockResolvedValue(new Response('', { status: 403 }));
  await expect(gitcodeRead('/pr', 'secret')).rejects.toThrow('HTTP 403'); expect(fetch).toHaveBeenCalledTimes(1);
});
test('malformed successful API data is an error, never an empty successful review', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('bad json', { status: 200 }))));
  await expect(gitcodeRead('/pr', 'secret')).rejects.toThrow('读取失败');
});
test('pagination includes the newest comment after 300 entries', async () => {
  let page = 0;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(++page < 4 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 'latest' }])));
  expect((await gitcodeReadPages('/comments', '')).at(-1)).toEqual({ id: 'latest' });
});
