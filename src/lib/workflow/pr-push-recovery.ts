import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { getWorkspaceRoot } from '@/lib/core/app-paths';
import { evaluatePrPushEvidence } from './pr-push-evidence';

const json = async (path: string) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };

export async function markPrInstructionComplete(work: string, archive: string, context: string, commit: string) {
  const instruction = context.match(/^\s*(user_(?:apply_patch|fix_feedback|revert):[^\n]*)/m)?.[1]?.trim();
  if (!instruction) return;
  const receipt = { instruction, commit_sha: commit, completed_at: new Date().toISOString() };
  for (const root of [work, archive]) {
    await mkdir(join(root, 'outputs'), { recursive: true });
    await writeFile(join(root, 'outputs/user-instruction-result.json'), JSON.stringify(receipt));
  }
}

/** Only the specific failed push audit can be reconciled; arbitrary approvals stay human. */
export async function readRecoverablePush(input: { runId?: string; workingDirectory?: string; state: any }) {
  if (!input.runId || !input.workingDirectory || basename(input.workingDirectory) !== input.runId) return null;
  const state = input.state;
  const q = state?.humanQuestions?.find((q: any) => q.id === state.pendingHumanQuestionId && q.status === 'unanswered');
  const history = state?.stateHistory || [];
  const enteredHuman = [...history].reverse().find((x: any) => x.to === '人工确认');
  if (state?.status !== 'running' || q?.previousState !== '人工确认'
    || enteredHuman?.from !== '推送并触发') return null;
  const out = join(input.workingDirectory, 'outputs');
  const [push, comment, gate, audit] = await Promise.all(['push-result.json', 'pr-comment.json', 'gate-check.json', 'pr-push-audit.json'].map(n => json(join(out, n))));
  if (!audit?.push_verified || audit.verified === true
    || (audit.reason && audit.reason !== 'build_receipt_unverified')) return null;
  const proof = evaluatePrPushEvidence(push, comment, gate);
  if (!proof.verified) return null;
  // These fields bind the evidence to this workflow's PR branch, not just a SHA pair.
  const field = (key: string) => new RegExp(`^\\s*${key}:\\s*([^\\n]+)`, 'm').exec(state.globalContext || '')?.[1]?.trim();
  if (push.branch !== field('head_ref')) return null;
  try {
    const remote = new URL(push.remote);
    if (remote.protocol !== 'https:' || remote.port || remote.hostname !== 'gitcode.com'
      || remote.pathname.replace(/^\//, '').replace(/\.git$/, '').toLowerCase() !== field('head_repo')?.toLowerCase()) return null;
  } catch { return null; }
  return { push, comment, questionId: q.id, archive: join(getWorkspaceRoot(), 'runs', input.runId) };
}
