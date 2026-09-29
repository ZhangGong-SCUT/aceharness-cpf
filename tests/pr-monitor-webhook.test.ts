import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mocks = vi.hoisted(() => ({ managers: [] as any[], manager: null as any, persisted: null as any, root: '', gate: vi.fn() }));
vi.mock('@/lib/workflow/registry', () => ({
  workflowRegistry: { getRunningManagers: () => mocks.managers, getManagerByRunId: async () => mocks.manager },
  isStateMachineManagerLike: () => true,
}));
vi.mock('@/lib/run/state-persistence', () => ({ loadRunState: async () => mocks.persisted }));
vi.mock('@/lib/core/app-paths', () => ({ getWorkspaceRoot: () => mocks.root }));
vi.mock('@/lib/workflow/pr-script-step', () => ({ executePrScript: (...args: any[]) => mocks.gate(...args) }));
vi.mock('@/lib/config/system-settings', () => ({ loadSystemSettings: async () => ({ gitcodeAutoMonitor: false }) }));
vi.mock('@/lib/core/user-store', () => ({ loadUsers: async () => [], storeToken: vi.fn() }));
import { startPrReviewFromWebhook, snapshotRunningPrs } from '@/lib/workflow/gitcode-webhook';

const context = 'owner: org\nrepo: repo\nnumber: 42\npr_url: https://gitcode.com/org/repo/pull/42\nauthor: me';
const payload = { action: 'update', repository: { full_name: 'org/repo' }, pull_request: {
  number: 42, html_url: 'https://gitcode.com/org/repo/pull/42', state: 'open', user: { login: 'me' },
} };
beforeEach(async () => {
  vi.clearAllMocks(); mocks.managers = []; mocks.persisted = null;
  mocks.root = await mkdtemp(join(tmpdir(), 'pr-webhook-'));
  vi.stubEnv('ACE_WEBHOOK_DISK_SNAPSHOT', '1'); vi.stubEnv('ACE_GITCODE_AUTO_MONITOR', 'false');
  vi.stubEnv('ACE_GITCODE_PR_AUTHOR', 'me'); vi.stubEnv('ACE_GITCODE_WATCH_REPOS', 'org/repo');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(mocks.root, { recursive: true, force: true }); });
async function manager(previousState = '挂起') {
  const runId = 'run-pr42-test';
  const dir = join(mocks.root, runId); await mkdir(join(dir, 'outputs'), { recursive: true });
  const question = { id: 'q', previousState, answerSchema: { type: 'approval-transition' }, result: { stepOutputs: [] } };
  const m = Object.assign(new EventEmitter(), {
    getStatus: () => ({ runId, status: 'running', currentState: '__human_approval__', globalContext: context, workingDirectory: dir }),
    getPendingHumanQuestion: () => question,
    answerHumanQuestion: vi.fn(async () => {}), setContext: vi.fn(), forceTransition: vi.fn(),
  });
  mocks.manager = m; mocks.managers = [{ configFile: 'gitcode-pr-review.yaml', manager: m }];
  return { m, dir };
}
test('compacted question outputs cannot bypass approval of an unpushed suggestion', async () => {
  const { m, dir } = await manager();
  await writeFile(join(dir, 'outputs/review-suggestion.json'), JSON.stringify({ mode: 'suggestion', head_sha: 'abc' }));
  const result = await startPrReviewFromWebhook({ payload });
  expect(result.woken).not.toBe(true); expect(m.answerHumanQuestion).not.toHaveBeenCalled(); expect(mocks.gate).not.toHaveBeenCalled();
});
test('unchanged running CI causes no transition and no approval answer', async () => {
  const { m } = await manager(); mocks.gate.mockResolvedValue('```json\n{"phase":"running","summary":"等待 CI"}\n```');
  const result = await startPrReviewFromWebhook({ payload });
  expect(result).toMatchObject({ status: 202, woken: false }); expect(m.answerHumanQuestion).not.toHaveBeenCalled();
});
test('a relevant gate change wakes the existing task even in manual monitor mode', async () => {
  const { m } = await manager(); mocks.gate.mockResolvedValue('```json\n{"phase":"static_failed"}\n```');
  expect(await startPrReviewFromWebhook({ payload })).toMatchObject({ woken: true, started: false });
  expect(m.answerHumanQuestion).toHaveBeenCalledOnce();
});
test('human confirmation for push permission is not answered by a CI event', async () => {
  const { m } = await manager('人工确认');
  expect((await startPrReviewFromWebhook({ payload })).woken).not.toBe(true);
  expect(mocks.gate).not.toHaveBeenCalled(); expect(m.answerHumanQuestion).not.toHaveBeenCalled();
});
test('temporary gate fetch failure remains retryable in the durable event queue', async () => {
  const { m } = await manager(); mocks.gate.mockResolvedValue('```json\n{"phase":"read_error","read_failed":true}\n```');
  expect(await startPrReviewFromWebhook({ payload })).toMatchObject({ status: 503, woken: false });
  expect(m.answerHumanQuestion).not.toHaveBeenCalled();
});
test('closed PR notifications never create new monitors', async () => {
  expect(await startPrReviewFromWebhook({ payload: { ...payload, pull_request: { ...payload.pull_request, state: 'closed' } } }))
    .toMatchObject({ started: false, reason: '已结束的 PR 不新建监控' });
});
test('a restart restores the waiting execution loop, rather than transitioning an empty manager', async () => {
  const configFile = `test-${Date.now()}.yaml`; // separate disk snapshot cache
  const runId = 'run-pr42-restored';
  const dir = join(mocks.root, runId); const runDir = join(mocks.root, 'runs', runId);
  await mkdir(dir, { recursive: true }); await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'summary.json'), JSON.stringify({ configFile, status: 'running' }));
  mocks.persisted = { runId, status: 'running', configFile, currentState: '__human_approval__', globalContext: context,
    workingDirectory: dir, pendingHumanQuestionId: 'q', humanQuestions: [{ id: 'q', status: 'unanswered', previousState: '挂起' }] };
  const m = Object.assign(new EventEmitter(), { getStatus: () => ({ status: 'idle' }), forceTransition: vi.fn(),
    forceJumpToState: vi.fn(async () => { m.emit('status', { runId, status: 'running' }); }),
  }); mocks.manager = m;
  mocks.gate.mockResolvedValue('```json\n{"phase":"green"}\n```');
  expect((await snapshotRunningPrs(configFile))).toHaveLength(1);
  expect(await startPrReviewFromWebhook({ payload, configFile })).toMatchObject({ woken: true });
  expect(m.forceJumpToState).toHaveBeenCalledOnce(); expect(m.forceTransition).not.toHaveBeenCalled();
});

test.each([true, false])('verified push audit recovery resumes CI monitoring (live=%s)', async live => {
  const { m, dir } = await manager('人工确认');
  const runId = 'run-pr42-test', sha = 'a'.repeat(40);
  const gc = `${context}\nhead_repo: me/repo\nhead_ref: fix\nuser_apply_patch: run-original`;
  m.getStatus = () => ({ runId, status: 'running', currentState: '__human_approval__', globalContext: gc, workingDirectory: dir });
  mocks.persisted = { ...m.getStatus(), pendingHumanQuestionId: 'q',
    humanQuestions: [{ ...m.getPendingHumanQuestion(), status: 'unanswered' }], stateHistory: [{ from: '推送并触发', to: '人工确认' }] };
  const files = {
    'push-result.json': { push_status: 'success', commit_sha: sha, remote_head_sha: sha, pushed_at: '2026-09-28T13:06:46Z', branch: 'fix', remote: 'https://gitcode.com/me/repo.git' },
    'pr-comment.json': { ok: true, body: 'start build', endpoint: 'pulls', comment_id: 'receipt', posted_at: '2026-09-28T13:07:41Z' },
    'gate-check.json': { phase: 'running', head_sha: sha, checked_at: '2026-09-28T13:11:26Z' },
    'pr-push-audit.json': { push_verified: true, verified: false },
  };
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, 'outputs', name), JSON.stringify(body));
  const configFile = live ? 'gitcode-pr-review.yaml' : `recovery-${Date.now()}.yaml`;
  if (!live) {
    const archive = join(mocks.root, 'runs', runId); await mkdir(archive, { recursive: true });
    await writeFile(join(archive, 'summary.json'), JSON.stringify({ configFile, status: 'running' }));
    mocks.persisted.configFile = configFile;
    mocks.managers = [];
    m.getStatus = () => ({ status: 'idle' });
    m.forceJumpToState = vi.fn(async () => { m.emit('status', { runId, status: 'running' }); });
  }
  mocks.gate.mockResolvedValue(JSON.stringify({ phase: 'running', own_pr: true, head_sha: sha }));
  expect(await startPrReviewFromWebhook({ payload, configFile })).toMatchObject({ woken: true, started: false });
  expect(live ? m.answerHumanQuestion : m.forceJumpToState).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(join(dir, 'outputs/user-instruction-result.json'), 'utf8'))).toMatchObject({ instruction: 'user_apply_patch: run-original', commit_sha: sha });
});
