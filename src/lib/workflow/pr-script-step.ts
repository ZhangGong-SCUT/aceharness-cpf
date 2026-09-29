import { execFile } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildConfiguredProcessEnv } from '@/lib/core/configured-env';
import { evaluatePrPushEvidence } from '@/lib/workflow/pr-push-evidence';
import { markPrInstructionComplete } from '@/lib/workflow/pr-push-recovery';

import { executeApprovedApply } from './pr-approved-apply';

const execute = promisify(execFile);
export type PrScript = 'identity' | 'gates' | 'route' | 'review' | 'park' | 'ready' | 'human' | 'finish' | 'push-audit' | 'approved-apply' | 'approved-apply-audit';

/** Fixed PR operations and exact approved-patch application. Never execute model output as a command. */
export async function executePrScript(input: {
  operation: PrScript; stateName: string; workingDirectory: string;
  runDirectory: string; globalContext: string; userId?: string; signal?: AbortSignal;
}) {
  const out = resolve(input.workingDirectory, 'outputs');
  await mkdir(out, { recursive: true });
  const stateFile = resolve(input.runDirectory, 'state.yaml');
  const env = await buildConfiguredProcessEnv(undefined, process.env, { userId: input.userId });
  const field = (key: string) => new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(input.globalContext)?.[1]?.trim() || '';
  const read = async (name: string) => JSON.parse(await readFile(resolve(out, name), 'utf8'));
  const run = async (name: string, args: string[]) => {
    const script = [resolve(process.cwd(), 'skills/gitcode-pr-review/scripts', name),
      resolve(input.workingDirectory, 'skills/gitcode-pr-review/scripts', name)].find(existsSync);
    if (!script) throw new Error(`PR 脚本不存在：${name}`);
    try {
      const { stdout } = await execute(process.execPath, [script, ...args], {
        cwd: input.workingDirectory, env, signal: input.signal, timeout: 90000, maxBuffer: 4 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    } catch (error: any) {
      // Closed/foreign PR is a valid gate verdict, emitted with exit status 2.
      if (name === 'check-pr-gates.mjs' && error.code === 2 && error.stdout) return JSON.parse(error.stdout);
      if (['check-pr-gates.mjs', 'fetch-ai-review.mjs'].includes(name) && !input.signal?.aborted) {
        const status = /GitCode HTTP (\d{3})/.exec(String(error.stderr || ''))?.[1];
        const permission = status === '401' || status === '403';
        const failure = { verdict: permission ? 'pass' : 'conditional_pass',
          phase: permission ? 'blocked_permission' : 'read_error',
          summary: permission ? `GitCode 读取权限不足（${status}），请更新令牌` : 'GitCode 数据读取失败，保留监控等待重试',
          checked_at: new Date().toISOString(), read_failed: true };
        await writeFile(resolve(out, 'gate-check.json'), JSON.stringify(failure));
        return failure;
      }
      // Child stderr may contain API credentials. Keep only safe operation metadata.
      throw new Error(`PR 脚本 ${name} 执行失败（${error.code || error.name || 'error'}）`);
    }
  };
  const common = ['--pr-url', field('pr_url'), '--author', field('author'), '--out', out];
  const optionalRead = async (name: string) => { try { return await read(name); } catch { return null; } };
  const hasUnpushedChanges = async () => {
    const repo = resolve(input.workingDirectory, 'repo');
    if (!existsSync(repo)) return false;
    const git = async (args: string[]) => (await execute('git', ['-C', repo, ...args], {
      timeout: 5000, signal: input.signal, maxBuffer: 1024 * 1024,
    })).stdout.trim();
    if (await git(['status', '--porcelain'])) return true;
    const head = await git(['rev-parse', 'HEAD']);
    const gate = await optionalRead('gate-check.json');
    const push = await optionalRead('push-result.json');
    return head !== gate?.head_sha && !(push?.push_status === 'success'
      && push.commit_sha === head && push.remote_head_sha === head);
  };
  if (input.operation === 'approved-apply' || input.operation === 'approved-apply-audit') {
    const applied = await executeApprovedApply({ ...input, operation: input.operation, env });
    return '<step-conclusion>' + JSON.stringify(applied) + '</step-conclusion>';
  }
  let result;
  switch (input.operation) {
    case 'identity':
      result = await run('validate-pr-identity.mjs', ['--out', out, '--state', stateFile]);
      break;
    case 'gates': {
      const gate = await run('check-pr-gates.mjs', [...common, '--state', stateFile]);
      // Probes may finish without a state transition; preserve the actual check time for the UI.
      const archive = resolve(input.runDirectory, 'outputs');
      await mkdir(archive, { recursive: true });
      await writeFile(resolve(archive, 'gate-check.json'), JSON.stringify(gate));
      const waiting = ['running', 'review_pending_decision', 'read_error'].includes(gate.phase);
      const terminal = gate.closed || gate.merged || gate.own_pr === false || gate.verdict === 'fail' || gate.phase === 'tester_approved';
      result = { ...gate, verdict: terminal ? 'fail' : waiting ? 'conditional_pass' : 'pass' };
      break;
    }
    case 'route':
      result = await run('route-pr-phase.mjs', ['--from', input.stateName, '--in', resolve(out, 'gate-check.json')]);
      if (input.stateName === '分流触发' && await hasUnpushedChanges()) result = { ...result, verdict: 'fail', next_state: '推送并触发' };
      break;
    case 'park': {
      const gate = await read('gate-check.json');
      const suggestion = await optionalRead('review-suggestion.json');
      const userDecision = gate.phase === 'review_pending_decision' || (suggestion?.mode === 'suggestion'
        && !!suggestion.head_sha && suggestion.head_sha === gate.head_sha);
      result = { verdict: 'pass', phase: gate.phase, summary: gate.summary,
        waiting_for: userDecision ? 'user_decision' : 'webhook' };
      break;
    }
    case 'review': {
      const gate = await read('gate-check.json');
      let suggestion;
      try { suggestion = await read('review-suggestion.json'); } catch { /* no suggestion yet */ }
      if (suggestion?.mode === 'suggestion' && suggestion.head_sha && suggestion.head_sha === gate.head_sha) {
        result = { verdict: 'conditional_pass', next_state: '挂起', summary: '检视建议等待用户决策' };
        break;
      }
      const review = await run('fetch-ai-review.mjs', common);
      if (review.read_failed) {
        result = { ...review, verdict: review.phase === 'blocked_permission' ? 'fail' : 'conditional_pass',
          next_state: review.phase === 'blocked_permission' ? '人工确认' : '挂起' };
        break;
      }
      result = review.actionable_count > 0 || review.ai_reviewed === false
        ? { verdict: 'fail', next_state: '检视修复', ...review }
        : await run('route-pr-phase.mjs', ['--from', '分流检视', '--in', resolve(out, 'gate-check.json')]);
      break;
    }
    case 'ready': {
      const gate = await read('gate-check.json');
      result = { verdict: await hasUnpushedChanges() ? 'fail' : gate.phase === 'green' ? 'pass' : 'conditional_pass',
        phase: gate.phase, summary: gate.summary, pr_url: field('pr_url'), submitted: false, merged: gate.merged === true };
      break;
    }
    case 'human':
    case 'finish': {
      const gate = await optionalRead('gate-check.json');
      const push = await optionalRead('push-result.json');
      result = { verdict: 'pass', pr_url: field('pr_url'), phase: gate?.phase,
        summary: push?.error || gate?.summary || (input.stateName === '完成' ? '流程结束，请查看步骤记录' : '无法继续自动处理，请查看步骤记录'),
        push_status: push?.push_status || 'not_attempted', submitted: false, merged: gate?.merged === true,
        waiting_for: input.operation === 'human' ? 'user_decision' : undefined };
      break;
    }
    case 'push-audit': {
      const push = await optionalRead('push-result.json');
      const gate = await optionalRead('gate-check.json');
      const comment = await optionalRead('pr-comment.json');
      const { success, verified, buildCommentId, reason } = evaluatePrPushEvidence(push, comment, gate,
        push?.push_status === 'not_attempted' && !(await hasUnpushedChanges()));
      if (success) await markPrInstructionComplete(input.workingDirectory, input.runDirectory, input.globalContext, push.commit_sha);
      // Preserve script-checked facts; filesystem copy times are not push/build times.
      const audit = { commit_sha: push?.commit_sha || '', remote_head_sha: push?.remote_head_sha || '',
        push_verified: success, build_comment_id: buildCommentId, verified, reason,
        checked_at: new Date().toISOString() };
      await writeFile(resolve(out, 'pr-push-audit.json'), JSON.stringify(audit));
      await mkdir(resolve(input.runDirectory, 'outputs'), { recursive: true });
      await writeFile(resolve(input.runDirectory, 'outputs/pr-push-audit.json'), JSON.stringify(audit));
      result = { verdict: verified ? 'pass' : 'fail', reason, push_status: push?.push_status || 'unknown',
        summary: !verified ? '推送或本轮 start build 缺少成功凭据，需要人工确认'
          : success ? '本地提交与远端提交一致，start build 已发送' : '没有待推送修改，本轮触发状态已核对' };
      break;
    }
  }
  if (!result || !['pass', 'fail', 'conditional_pass'].includes(result.verdict)) throw new Error('PR 脚本未返回有效裁决');
  return '```json\n' + JSON.stringify(result, null, 2) + '\n```';
}
