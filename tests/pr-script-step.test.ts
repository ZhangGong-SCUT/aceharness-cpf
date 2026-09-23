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
  test('an existing suggestion on the same head needs no model or network call', async () => {
    const input = await fixture();
    await writeFile(join(input.workingDirectory, 'outputs/gate-check.json'), JSON.stringify({ head_sha: 'abc' }));
    await writeFile(join(input.workingDirectory, 'outputs/review-suggestion.json'), JSON.stringify({ mode: 'suggestion', head_sha: 'abc' }));
    expect(result(await executePrScript({ ...input, operation: 'review', stateName: '分流检视' })).verdict).toBe('conditional_pass');
  });
});
