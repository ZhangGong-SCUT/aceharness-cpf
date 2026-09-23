import { execFile } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildConfiguredProcessEnv } from '@/lib/core/configured-env';

const execute = promisify(execFile);
export type PrScript = 'identity' | 'gates' | 'route' | 'review' | 'park';

/** Fixed, read-only PR operations. Never interpret a model response as a command. */
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
      // Child stderr may contain API credentials. Keep only safe operation metadata.
      throw new Error(`PR 脚本 ${name} 执行失败（${error.code || error.name || 'error'}）`);
    }
  };
  const common = ['--pr-url', field('pr_url'), '--author', field('author'), '--out', out];
  let result;
  switch (input.operation) {
    case 'identity':
      result = await run('validate-pr-identity.mjs', ['--out', out, '--state', stateFile]);
      break;
    case 'gates': {
      const gate = await run('check-pr-gates.mjs', [...common, '--state', stateFile]);
      const waiting = ['running', 'review_pending_decision'].includes(gate.phase);
      const terminal = gate.closed || gate.merged || gate.own_pr === false || gate.verdict === 'fail' || gate.phase === 'tester_approved';
      result = { ...gate, verdict: terminal ? 'fail' : waiting ? 'conditional_pass' : 'pass' };
      break;
    }
    case 'route':
      result = await run('route-pr-phase.mjs', ['--from', input.stateName, '--in', resolve(out, 'gate-check.json')]);
      break;
    case 'park': {
      const gate = await read('gate-check.json');
      result = { verdict: 'pass', phase: gate.phase, summary: gate.summary,
        waiting_for: gate.phase === 'review_pending_decision' ? 'user_decision' : 'webhook' };
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
      result = review.actionable_count > 0 || review.ai_reviewed === false
        ? { verdict: 'fail', next_state: '检视修复', ...review }
        : await run('route-pr-phase.mjs', ['--from', '分流检视', '--in', resolve(out, 'gate-check.json')]);
      break;
    }
  }
  if (!result || !['pass', 'fail', 'conditional_pass'].includes(result.verdict)) throw new Error('PR 脚本未返回有效裁决');
  return '```json\n' + JSON.stringify(result, null, 2) + '\n```';
}
