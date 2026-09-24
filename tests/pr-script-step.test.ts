import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { executePrScript } from '@/lib/workflow/pr-script-step';

vi.mock('@/lib/core/configured-env', () => ({
  buildConfiguredProcessEnv: async () => ({ ...process.env, ACE_GITCODE_PR_AUTHOR: 'author', ACE_GITCODE_WATCH_REPOS: 'org/repo' }),
}));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pr-script-'));
  dirs.push(dir);
  const workingDirectory = join(dir, 'work');
  const runDirectory = join(dir, 'run');
  await mkdir(join(workingDirectory, 'outputs'), { recursive: true });
  await mkdir(runDirectory);
  const globalContext = ['pr_url: https://gitcode.com/org/repo/pull/42', 'owner: org', 'repo: repo',
    'number: 42', 'author: author', 'head_repo: author/repo', 'head_ref: fix', 'base_ref: main',
    'manual-start-by: author'].join('\n');
  await writeFile(join(runDirectory, 'state.yaml'), stringify({ globalContext }));
  return { workingDirectory, runDirectory, globalContext };
}
function result(text: string) { return JSON.parse(text.replace(/^```json\n|\n```$/g, '')); }

describe('deterministic PR steps', () => {
  test('identity reads this run state even when workspace has another PR state', async () => {
    const input = await fixture();
    await writeFile(join(input.workingDirectory, 'state.yaml'), stringify({ globalContext: 'author: intruder' }));
    const data = result(await executePrScript({ ...input, operation: 'identity', stateName: '识别' }));
    expect(data).toMatchObject({ verdict: 'pass', own_pr: true, number: '42' });
  });
  test('identity mismatch fails without asking a model to repair the result', async () => {
    const input = await fixture();
    await writeFile(join(input.runDirectory, 'state.yaml'), stringify({ globalContext: input.globalContext.replace('manual-start-by: author', 'manual-start-by: intruder') }));
    expect(result(await executePrScript({ ...input, operation: 'identity', stateName: '识别' })).verdict).toBe('fail');
  });
  test('routes a static failure directly to repair', async () => {
    const input = await fixture();
    await writeFile(join(input.workingDirectory, 'outputs/gate-check.json'), JSON.stringify({ phase: 'static_failed' }));
    expect(result(await executePrScript({ ...input, operation: 'route', stateName: '分类处置' }))).toMatchObject({ verdict: 'fail', next_state: '静态修复' });
  });
  test('parks review suggestions as user decisions, not CI waits', async () => {
    const input = await fixture();
    await writeFile(join(input.workingDirectory, 'outputs/gate-check.json'), JSON.stringify({ phase: 'review_pending_decision' }));
    expect(result(await executePrScript({ ...input, operation: 'park', stateName: '挂起' }))).toMatchObject({ verdict: 'pass', waiting_for: 'user_decision' });
  });
  test('a newly generated suggestion is a user wait before the next gate refresh', async () => {
    const input = await fixture();
    await writeFile(join(input.workingDirectory, 'outputs/gate-check.json'), JSON.stringify({ phase: 'green', head_sha: 'abc' }));
    await writeFile(join(input.workingDirectory, 'outputs/review-suggestion.json'), JSON.stringify({ mode: 'suggestion', head_sha: 'abc' }));
    expect(result(await executePrScript({ ...input, operation: 'park', stateName: '挂起' })).waiting_for).toBe('user_decision');
  });
  test('an existing suggestion on the same head needs no model or network call', async () => {
    const input = await fixture();
    await writeFile(join(input.workingDirectory, 'outputs/gate-check.json'), JSON.stringify({ head_sha: 'abc' }));
    await writeFile(join(input.workingDirectory, 'outputs/review-suggestion.json'), JSON.stringify({ mode: 'suggestion', head_sha: 'abc' }));
    expect(result(await executePrScript({ ...input, operation: 'review', stateName: '分流检视' })).verdict).toBe('conditional_pass');
  });
  test('trigger routing and ready/finish summaries execute without model calls', async () => {
    const input = await fixture();
    await writeFile(join(input.workingDirectory, 'outputs/gate-check.json'), JSON.stringify({ phase: 'green', summary: '门禁通过' }));
    expect(result(await executePrScript({ ...input, operation: 'route', stateName: '分流触发' })).next_state).toBe('就绪');
    expect(result(await executePrScript({ ...input, operation: 'ready', stateName: '就绪' }))).toMatchObject({ verdict: 'pass', merged: false, submitted: false });
    expect(result(await executePrScript({ ...input, operation: 'finish', stateName: '完成' })).summary).toBe('门禁通过');
  });
  test('push audit requires both remote SHA evidence and a current build trigger', async () => {
    const input = await fixture(); const out = join(input.workingDirectory, 'outputs');
    await writeFile(join(out, 'gate-check.json'), JSON.stringify({ phase: 'static_failed', checked_at: '2026-09-24T00:00:00Z' }));
    await writeFile(join(out, 'push-result.json'), JSON.stringify({ push_status: 'success', commit_sha: 'abc', remote_head_sha: 'abc' }));
    const audit = async () => result(await executePrScript({ ...input, operation: 'push-audit', stateName: '推送并触发' }));
    expect((await audit()).verdict).toBe('fail');
    await writeFile(join(out, 'pr-comment.json'), JSON.stringify({ ok: true, body: 'start build', endpoint: 'pulls', comment_id: 1, posted_at: '2026-09-24T00:01:00Z' }));
    expect((await audit()).verdict).toBe('pass');
    await writeFile(join(out, 'push-result.json'), JSON.stringify({ push_status: 'success', commit_sha: 'abc', remote_head_sha: 'old' }));
    expect((await audit()).verdict).toBe('fail');
  });
  test('missing push record cannot be treated as success', async () => {
    const input = await fixture();
    expect(result(await executePrScript({ ...input, operation: 'push-audit', stateName: '推送并触发' })).verdict).toBe('fail');
  });
  test('human confirmation records the failure without using a model', async () => {
    const input = await fixture();
    await writeFile(join(input.workingDirectory, 'outputs/push-result.json'), JSON.stringify({ push_status: 'failed', error: '403 无写权限' }));
    expect(result(await executePrScript({ ...input, operation: 'human', stateName: '人工确认' }))).toMatchObject({ summary: '403 无写权限', waiting_for: 'user_decision' });
  });
});
