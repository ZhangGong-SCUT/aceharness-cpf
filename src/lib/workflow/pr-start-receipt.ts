import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWorkspaceRoot } from '@/lib/core/app-paths';

/** Keep a valid caller receipt ID so a timed-out request can be reconciled. */
export function resolveWorkflowRunId(requested: unknown): string {
  const value = typeof requested === 'string' ? requested.trim() : '';
  return /^run-[A-Za-z0-9_-]{4,80}$/.test(value) ? value : `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/** Reserve caller-supplied IDs before snapshots or managers can overwrite a run. */
export async function reserveWorkflowRunId(runId: string, requested: unknown): Promise<boolean> {
  if (typeof requested !== 'string' || requested.trim() !== runId) return true;
  if (!/^run-[A-Za-z0-9_-]{4,80}$/.test(runId)) return false;
  const runs = join(getWorkspaceRoot(), 'runs');
  await mkdir(runs, { recursive: true });
  try { await mkdir(join(runs, runId)); return true; }
  catch (error: any) { if (error.code === 'EEXIST') return false; throw error; }
}

/** Record an asynchronous failure even when startup never created a run state. */
export async function recordPrStartFailure(runId: string, configFile: string, status: { runId?: string | null; status?: string },
  owner?: { id: string; username?: string }) {
  if (!['gitcode-pr-review.yaml', 'cpf-ohos-diagnosis.yaml', 'flutter-ohos-diagnosis.yaml', 'cpf-ohos-diagnosis-iterate.yaml'].includes(configFile)
    || !/^run-[A-Za-z0-9_-]{4,80}$/.test(runId)) return;
  // A rejected duplicate must not poison an existing active or completed run.
  if (status.runId === runId && !['idle', 'failed', 'crashed', 'stopped'].includes(status.status || '')) return;
  if (status.runId && status.runId !== runId) return;
  const outputs = join(getWorkspaceRoot(), 'runs', runId, 'outputs');
  await mkdir(outputs, { recursive: true });
  const file = join(outputs, 'start-result.json');
  await writeFile(file + '.tmp', JSON.stringify({ run_id: runId, config_file: configFile, status: 'failed',
    error: '工作流未能启动，请查看引擎日志后重试', checked_at: new Date().toISOString() }));
  await rename(file + '.tmp', file);
  // Issue proxies can recover this through authenticated run history even before state.yaml exists.
  if (owner?.id) {
    const now = new Date().toISOString();
    await writeFile(join(outputs, '..', 'summary.json'), JSON.stringify({ version: 1, id: runId, runId,
      configFile, configName: configFile, status: 'failed', currentPhase: null,
      ownerId: owner.id, ownerName: owner.username || '', startTime: now, endTime: now, updatedAt: now,
      totalSteps: 0, completedSteps: 0, failedSteps: 0, statusReason: '工作流未能启动，请查看引擎日志后重试' }),
    { flag: 'wx', mode: 0o600 }).catch((error: any) => { if (error.code !== 'EEXIST') throw error; });
  }
}
