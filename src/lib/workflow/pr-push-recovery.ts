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
  // head_changed 同样只是「推送凭据没对上」；是否真需要人工判断由 proof.verified 决定。
  if (!audit?.push_verified || audit.verified === true
    || (audit.reason && !['build_receipt_unverified', 'head_changed'].includes(audit.reason))) return null;
  const proof = evaluatePrPushEvidence(push, comment, gate);
  if (!proof.verified) return null;
  // These fields bind the evidence to this workflow's PR branch, not just a SHA pair.
  const field = (key: string) => new RegExp(`^\\s*${key}:\\s*([^\\n]+)`, 'm').exec(state.globalContext || '')?.[1]?.trim();
  const headRef = field('head_ref'), headRepo = (field('head_repo') || '').toLowerCase();
  const sameRef = (repo: unknown, ref: unknown) => !!repo && !!ref
    && String(repo).replace(/^\//, '').replace(/\.git$/, '').toLowerCase() === headRepo && String(ref) === headRef;
  let bound = false;
  if (push.branch && push.remote) {
    try {
      const remote = new URL(push.remote);
      bound = remote.protocol === 'https:' && !remote.port && remote.hostname === 'gitcode.com'
        && sameRef(remote.pathname, push.branch);
    } catch { bound = false; }
  } else if (push.push_target) {
    // 部分运行只写 push_target=<head_repo>@<head_ref>。
    const at = String(push.push_target).lastIndexOf('@');
    bound = at > 0 && sameRef(String(push.push_target).slice(0, at), String(push.push_target).slice(at + 1));
  } else {
    // push-result 未自带分支信息时，用本 run 门禁快照记录的 PR 身份绑定。
    bound = gate?.own_pr === true && sameRef(gate?.head_repo, gate?.head_ref);
  }
  if (!bound) return null;
  return { push, comment, questionId: q.id, archive: join(getWorkspaceRoot(), 'runs', input.runId) };
}
