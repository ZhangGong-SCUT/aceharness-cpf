import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeIgnoredPr, isWatchedRepo, type PrReviewInput } from '@/lib/workflow/pr-review-input';
import { decideGitcodeWebhookRun, isPrGateWait, isPrHumanWait } from '@/lib/workflow/pr-monitor-policy';

const mocks = vi.hoisted(() => ({
  root: '',
  snapshot: vi.fn(async () => [] as any[]),
  start: vi.fn(async () => ({ status: 202, started: false, reason: 'test' })),
}));
vi.mock('@/lib/core/app-paths', () => ({ getWorkspaceRoot: () => mocks.root }));
vi.mock('@/lib/workflow/gitcode-webhook', () => ({
  GITCODE_PR_REVIEW_CONFIG: 'gitcode-pr-review.yaml',
  snapshotRunningPrs: (...args: any[]) => mocks.snapshot(...args),
  startPrReviewFromWebhook: (...args: any[]) => mocks.start(...args),
}));
import { enqueuePrWebhook, reconcilePrGateWaits } from '@/lib/workflow/pr-monitor';

const dirs: string[] = [];
const secret = 's3cret-token-value';

function incoming(number: string, owner = 'CPF-Flutter', repo = 'flutter_flutter'): PrReviewInput {
  return {
    mode: 'event', prUrl: null, owner, repo, number, action: 'update', title: null,
    author: 'me', headRef: null, baseRef: null, headSha: null, headRepo: null,
  };
}

function context(number: string) {
  return [
    'owner: CPF-Flutter',
    'repo: flutter_flutter',
    `number: ${number}`,
    'author: me',
    `pr_url: https://gitcode.com/CPF-Flutter/flutter_flutter/pull/${number}`,
  ].join('\n');
}

function pull(number: number, extra: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    password: secret,
    token: secret,
    repository: { full_name: 'CPF-Flutter/flutter_flutter.git' },
    pull_request: {
      number,
      html_url: `https://gitcode.com/CPF-Flutter/flutter_flutter/pull/${number}`,
      title: 'smoke',
      state: 'open',
      user: { login: 'Me' },
      head: { ref: 'fix', sha: 'abc', repo: { full_name: 'Me/flutter_flutter' } },
      base: { ref: 'main' },
      ...extra,
    },
  };
}

async function jobs() {
  const text = await readFile(join(mocks.root, 'data', 'pr-monitor-events.json'), 'utf8');
  return JSON.parse(text).jobs as Array<{ key: string; payload: { payload: any } }>;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('ACE_GITCODE_REVIEW_CONFIG', '');
  delete (globalThis as { __prMonitorRuntime?: unknown }).__prMonitorRuntime;
  mocks.root = await mkdtemp(join(tmpdir(), 'pr-enqueue-'));
  dirs.push(mocks.root);
  mocks.snapshot.mockResolvedValue([]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  delete (globalThis as { __prMonitorRuntime?: unknown }).__prMonitorRuntime;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('incomplete payload is rejected and nothing is written', async () => {
  const result = await enqueuePrWebhook({ action: 'open', password: secret });
  expect(result).toMatchObject({ accepted: false, started: false });
  expect(result.reason).toContain('缺少');
  await expect(jobs()).rejects.toThrow();
});

test('open event keeps only normalized PR fields and drops secrets', async () => {
  const result = await enqueuePrWebhook(pull(42));
  expect(result).toMatchObject({
    accepted: true, started: false, duplicate: false, reason: '事件已持久化，等待处理',
  });
  const saved = await jobs();
  expect(saved).toHaveLength(1);
  expect(saved[0].key).toBe('gitcode-pr-review.yaml:cpf-flutter/flutter_flutter#42');
  expect(saved[0].payload.payload).toMatchObject({
    hook_name: 'merge_request',
    action: 'opened',
    repository: { full_name: 'CPF-Flutter/flutter_flutter' },
    pull_request: {
      number: '42',
      state: 'open',
      user: { login: 'Me' },
      head: { ref: 'fix', sha: 'abc', repo: { full_name: 'Me/flutter_flutter' } },
      base: { ref: 'main' },
    },
  });
  expect(JSON.stringify(saved)).not.toContain(secret);
  expect(mocks.start).not.toHaveBeenCalled();
});

test('identical event is merged and a new comment replaces the snapshot', async () => {
  expect(await enqueuePrWebhook(pull(42))).toMatchObject({ duplicate: false });
  expect(await enqueuePrWebhook(pull(42))).toMatchObject({ duplicate: true, reason: '重复事件已合并' });
  const changed = await enqueuePrWebhook({ ...pull(42), note: { id: 1, body: 'please recheck' } });
  expect(changed).toMatchObject({ duplicate: false, queued: true });
  const saved = await jobs();
  expect(saved).toHaveLength(1);
  expect(saved[0].payload.payload.action).toBe('opened');
});

test('close is stored as closed and a label event is ignored', async () => {
  const closed = await enqueuePrWebhook({ ...pull(7), action: 'closed' });
  expect(closed.accepted).toBe(true);
  expect((await jobs())[0].payload.payload.pull_request.state).toBe('closed');
  const labeled = await enqueuePrWebhook({ ...pull(8), action: 'labeled' });
  expect(labeled).toMatchObject({ accepted: false });
  expect(labeled.reason).toContain('忽略事件');
  expect(await jobs()).toHaveLength(1);
});

test('gate poll enqueues idle gate waits only, including push reconcile', async () => {
  mocks.snapshot.mockResolvedValue([
    { runId: 'gate', status: 'running', currentState: '挂起', globalContext: context('7') },
    {
      runId: 'human', status: 'running', currentState: '__human_approval__', waitingFor: 'user_decision',
      pendingHumanQuestion: { previousState: '人工确认' }, globalContext: context('8'),
    },
    { runId: 'fix', status: 'running', currentState: '静态修复', globalContext: context('9') },
    {
      runId: 'push', status: 'running', currentState: '__human_approval__', waitingFor: 'push_reconcile',
      pendingHumanQuestion: { previousState: '人工确认' }, globalContext: context('10'),
    },
    { runId: 'broken', status: 'running', currentState: '挂起', globalContext: 'owner: CPF-Flutter\nrepo: flutter_flutter' },
  ]);
  await reconcilePrGateWaits();
  await reconcilePrGateWaits();
  expect((await jobs()).map((job) => job.key).sort()).toEqual([
    'gitcode-pr-review.yaml:cpf-flutter/flutter_flutter#10',
    'gitcode-pr-review.yaml:cpf-flutter/flutter_flutter#7',
  ]);
});

test('a failed gate poll does not leave the poller stuck', async () => {
  mocks.snapshot.mockRejectedValueOnce(new Error('disk'));
  await expect(reconcilePrGateWaits()).rejects.toThrow('disk');
  mocks.snapshot.mockResolvedValue([
    { runId: 'gate', status: 'running', currentState: '挂起', globalContext: context('7') },
  ]);
  await reconcilePrGateWaits();
  expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  expect(await jobs()).toHaveLength(1);
});

test('watch rules accept owner wildcard and exact repo, and reject another org', () => {
  expect(isWatchedRepo('CPF-Flutter', 'flutter_flutter', ['cpf-flutter/*'])).toBe(true);
  expect(isWatchedRepo('CPF-Flutter', 'other.git', ['CPF-Flutter/*'])).toBe(true);
  expect(isWatchedRepo('Other', 'flutter_flutter', ['CPF-Flutter/*'])).toBe(false);
  expect(isWatchedRepo('Acme', 'App.git', ['acme/app'])).toBe(true);
  expect(isWatchedRepo('Acme', '', ['acme/*'])).toBe(false);
  expect(isWatchedRepo('Acme', 'App', [])).toBe(true);
  expect(describeIgnoredPr({
    author: 'me', owner: 'me', repo: 'fork', allowedAuthors: ['me'], watchedRepos: ['cpf-flutter/*'],
  })).toContain('忽略未监听仓库 me/fork');
});

test('scheduler ignores a payload without identity and still wakes a case-different gate wait', () => {
  expect(decideGitcodeWebhookRun({ incoming: incoming('') })).toMatchObject({
    action: 'ignore', reason: 'payload 缺少 owner/repo/number',
  });
  const pushWait = {
    runId: 'run-push', status: 'preparing', currentState: '__human_approval__',
    waitingFor: 'push_reconcile' as const,
    pendingHumanQuestion: { previousState: '人工确认' },
    globalContext: context('1900'),
  };
  expect(isPrGateWait(pushWait)).toBe(true);
  expect(isPrHumanWait(pushWait)).toBe(false);
  expect(decideGitcodeWebhookRun({
    incoming: incoming('1900', 'cpf-flutter', 'Flutter_Flutter'),
    running: pushWait,
  })).toMatchObject({ action: 'wake', mode: 'resume-wait', runId: 'run-push' });
});
