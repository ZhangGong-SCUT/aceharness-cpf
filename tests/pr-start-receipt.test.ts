import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPrStartFailure, resolveWorkflowRunId, reserveWorkflowRunId } from '@/lib/workflow/pr-start-receipt';

const workspace = vi.hoisted(() => ({ root: '' }));
vi.mock('@/lib/core/app-paths', () => ({ getWorkspaceRoot: () => workspace.root }));
afterEach(async () => { if (workspace.root) await rm(workspace.root, { recursive: true, force: true }); });

test('caller run IDs are retained and invalid paths receive a fresh safe ID', () => {
  expect(resolveWorkflowRunId('  run-2026-pr42-abcd  ')).toBe('run-2026-pr42-abcd');
  for (const value of [undefined, '../run-test', 'run-../../etc', {}, 'run-' + 'a'.repeat(100)]) {
    expect(resolveWorkflowRunId(value)).toMatch(/^run-\d+-[a-f0-9-]{8}$/);
  }
});

test('startup rejection before state creation leaves a durable failure receipt', async () => {
  workspace.root = await mkdtemp(join(tmpdir(), 'pr-start-'));
  await recordPrStartFailure('run-test', 'gitcode-pr-review.yaml', { status: 'idle' });
  const receipt = JSON.parse(await readFile(join(workspace.root, 'runs/run-test/outputs/start-result.json'), 'utf8'));
  expect(receipt).toMatchObject({ run_id: 'run-test', status: 'failed' });
  expect(Date.parse(receipt.checked_at)).toBeGreaterThan(0);
});

test('concurrent starts can reserve a caller run ID only once, including across restarts', async () => {
  workspace.root = await mkdtemp(join(tmpdir(), 'pr-start-'));
  const attempts = await Promise.all(Array.from({ length: 8 }, () => reserveWorkflowRunId('run-test', 'run-test')));
  expect(attempts.filter(Boolean)).toHaveLength(1);
  expect(await reserveWorkflowRunId('run-test', 'run-test')).toBe(false);
});

test.each(['running', 'preparing', 'completed', 'paused'])('a rejected duplicate does not corrupt a %s run', async status => {
  workspace.root = await mkdtemp(join(tmpdir(), 'pr-start-'));
  await recordPrStartFailure('run-test', 'gitcode-pr-review.yaml', { runId: 'run-test', status });
  await expect(readFile(join(workspace.root, 'runs/run-test/outputs/start-result.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('different runs, workflows and invalid IDs cannot receive this failure receipt', async () => {
  workspace.root = await mkdtemp(join(tmpdir(), 'pr-start-'));
  await recordPrStartFailure('run-test', 'other.yaml', { status: 'idle' });
  await recordPrStartFailure('run-test', 'gitcode-pr-review.yaml', { runId: 'run-other', status: 'failed' });
  await recordPrStartFailure('../run-test', 'gitcode-pr-review.yaml', { status: 'failed' });
  await expect(readFile(join(workspace.root, 'runs/run-test/outputs/start-result.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
