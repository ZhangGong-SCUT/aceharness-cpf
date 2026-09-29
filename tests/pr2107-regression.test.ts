import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { executeApprovedApply } from '@/lib/workflow/pr-approved-apply';
import { evaluatePrPushEvidence } from '@/lib/workflow/pr-push-evidence';
import { readRecoverablePush } from '@/lib/workflow/pr-push-recovery';
import { parseGitcodeWebhookPayload } from '@/lib/workflow/pr-review-input';

const workspace = vi.hoisted(() => ({ root: '' }));
vi.mock('@/lib/core/app-paths', () => ({ getWorkspaceRoot: () => workspace.root }));
const execute = promisify(execFile), sha = 'a'.repeat(40);
const push = { push_status: 'success', commit_sha: sha, remote_head_sha: sha, pushed_at: '2026-09-28T13:06:46Z',
  branch: 'fix', remote: 'https://author@gitcode.com/author/repo.git' };
const comment = { ok: true, endpoint: 'pulls', body: 'start build', comment_id: 'opaque-id', posted_at: '2026-09-28T13:07:41Z' };
const gate = { phase: 'running', head_sha: sha, checked_at: '2026-09-28T13:11:26Z' };
beforeEach(async () => { workspace.root = await mkdtemp(join(tmpdir(), 'pr2107-')); });
afterEach(async () => { await rm(workspace.root, { recursive: true, force: true }); });

test('a later gate query cannot invalidate a successful push and build receipt', () => {
  expect(evaluatePrPushEvidence(push, comment, gate)).toMatchObject({ verified: true, buildCommentId: 'opaque-id' });
  expect(evaluatePrPushEvidence(push, { ...comment, posted_at: '2026-09-28T13:00:00Z' }, gate).verified).toBe(false);
  expect(evaluatePrPushEvidence(push, comment, { ...gate, head_sha: 'b'.repeat(40) }).verified).toBe(false);
  expect(evaluatePrPushEvidence({ ...push, pushed_at: undefined }, comment, gate).verified).toBe(false);
  expect(evaluatePrPushEvidence({ push_status: 'not_attempted', attempted_at: push.pushed_at }, comment, { phase: 'need_start_build' }, true).verified).toBe(true);
  expect(evaluatePrPushEvidence({ push_status: 'not_attempted' }, comment, { phase: 'need_start_build' }, true).verified).toBe(false);
});

test('only a failed push audit with exact PR branch evidence qualifies for automatic reconciliation', async () => {
  const runId = 'run-2107-test', work = join(workspace.root, runId);
  await mkdir(join(work, 'outputs'), { recursive: true });
  for (const [name, data] of Object.entries({ 'push-result.json': push, 'pr-comment.json': comment,
    'gate-check.json': gate, 'pr-push-audit.json': { push_verified: true, build_comment_id: null } })) {
    await writeFile(join(work, 'outputs', name), JSON.stringify(data));
  }
  const state = { status: 'running', pendingHumanQuestionId: 'q',
    globalContext: 'head_repo: author/repo\nhead_ref: fix',
    humanQuestions: [{ id: 'q', status: 'unanswered', previousState: '人工确认' }],
    stateHistory: [{ from: '推送并触发', to: '人工确认' }] };
  expect(await readRecoverablePush({ runId, workingDirectory: work, state })).toBeTruthy();
  expect(await readRecoverablePush({ runId, workingDirectory: work, state: { ...state, stateHistory: [{ from: '编译修复', to: '人工确认' }] } })).toBeNull();
  expect(await readRecoverablePush({ runId, workingDirectory: work, state: { ...state, globalContext: 'head_repo: other/repo\nhead_ref: fix' } })).toBeNull();
  await writeFile(join(work, 'outputs/push-result.json'), JSON.stringify({ ...push, push_status: 'failed' }));
  expect(await readRecoverablePush({ runId, workingDirectory: work, state })).toBeNull();
});

test('webhook source head never falls back to a merge result', () => {
  const payload = { action: 'update', repository: { full_name: 'org/repo' }, pull_request: {
    number: 42, user: { login: 'author' }, html_url: 'https://gitcode.com/org/repo/pull/42', state: 'open', merge_commit_sha: sha } };
  expect(parseGitcodeWebhookPayload(payload).input.headSha).toBeNull();
  expect(parseGitcodeWebhookPayload({ ...payload, pull_request: { ...payload.pull_request, last_commit: { id: 'b'.repeat(40) } } }).input.headSha).toBe('b'.repeat(40));
});

test('approved patch is applied once with real Git, independent review evidence, and no parent changes', async () => {
  const parent = 'run-parent', parentWork = join(workspace.root, parent), archive = join(workspace.root, 'runs', parent);
  const repo = join(parentWork, 'repo'); await mkdir(repo, { recursive: true });
  const git = async (...args: string[]) => (await execute('git', ['-C', repo, ...args])).stdout;
  await git('init'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'file.txt'), 'old\n'); await git('add', '.'); await git('commit', '-m', 'baseline');
  const baseline = (await git('rev-parse', 'HEAD')).trim();
  await writeFile(join(repo, 'file.txt'), 'new\n'); const patch = await git('diff');
  const digest = createHash('sha256').update(patch).digest('hex');
  const context = `owner: org\nrepo: repo\nnumber: 42\nhead_repo: author/repo\nhead_ref: fix\nhead_sha: ${baseline}`;
  await mkdir(join(archive, 'outputs'), { recursive: true });
  await writeFile(join(archive, 'state.yaml'), stringify({ createdBy: 'owner', workingDirectory: parentWork, globalContext: context }));
  await writeFile(join(archive, 'outputs/fix.patch'), patch);
  await writeFile(join(archive, 'outputs/ai-review-comments.json'), JSON.stringify({ comments: [{ id: 'review', path: 'file.txt', body: 'review', kind: 'ai_review' }] }));
  const input = { workingDirectory: join(workspace.root, 'run-child'), runDirectory: join(workspace.root, 'runs/run-child'), userId: 'owner', env: process.env,
    globalContext: `${context}\nuser_apply_patch: ${parent}\napproved_patch_sha256: ${digest}` };
  await mkdir(input.workingDirectory, { recursive: true });
  expect(await executeApprovedApply({ ...input, operation: 'approved-apply' })).toMatchObject({ verdict: 'pass', runtime_verified: false });
  expect(await executeApprovedApply({ ...input, operation: 'approved-apply' })).toMatchObject({ verdict: 'pass' });
  expect(await executeApprovedApply({ ...input, operation: 'approved-apply-audit' })).toMatchObject({ verdict: 'pass' });
  expect(await readFile(join(input.workingDirectory, 'repo/file.txt'), 'utf8')).toBe('new\n');
  expect(await readFile(join(input.runDirectory, 'outputs/ai-review-comments.json'), 'utf8')).toContain('review');
  expect(await git('diff')).toBe(patch);
  expect(await executeApprovedApply({ ...input, operation: 'approved-apply', userId: 'different' })).toMatchObject({ verdict: 'fail' });
  expect(await executeApprovedApply({ ...input, operation: 'approved-apply', globalContext: input.globalContext.replace(digest, '0'.repeat(64)) })).toMatchObject({ verdict: 'fail' });
  await writeFile(join(input.workingDirectory, 'repo/file.txt'), 'unapproved\n');
  expect(await executeApprovedApply({ ...input, operation: 'approved-apply-audit' })).toMatchObject({ verdict: 'fail' });
  expect(await executeApprovedApply({ ...input, operation: 'approved-apply', globalContext: context })).toMatchObject({ fallback_to_agent: true });
});
