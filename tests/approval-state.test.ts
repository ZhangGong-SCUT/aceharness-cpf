import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyParkApproval,
  composeApprovalAsk,
  isReviewDecision,
  readHumanApproval,
} from '../aiweb/Server/prReview/approvalState.js';

const HEAD = 'b785a6c8f4f4caa0f3726be0a8104867f6aae8fd';
const DECISION_ASK = '检视建议已经生成，还没有推送。请在这张卡片里选择应用、驳回，或按你的想法改。';

describe('isReviewDecision / composeApprovalAsk', () => {
  it('门禁文件仍是 need_start_build，但挂起记录是 user_decision 时按人工决策', () => {
    expect(isReviewDecision({
      phase: 'need_start_build',
      waitingFor: 'user_decision',
      suggestion: { mode: 'suggestion', head_sha: HEAD },
      gateHeadSha: HEAD,
    })).toBe(true);

    const ask = composeApprovalAsk({
      suggestedNextState: '等待门禁',
      previousState: '挂起',
      message: 'Supervisor 建议进入 等待门禁，请确认下一步状态。',
      gate: {
        phase: 'need_start_build',
        summary: '已有欢迎评论且 DCO 通过，评论 start build；不要等 AI已检视',
        head_sha: HEAD,
      },
      suggestion: { mode: 'suggestion', head_sha: HEAD },
      waitingFor: 'user_decision',
    });
    expect(ask.kind).toBe('human');
    expect(ask.ask).toBe(DECISION_ASK);
    expect(ask.suggestedNextState).toBe('');
    expect(ask.ask).not.toContain('正在等 CI');
    expect(ask.ask).not.toContain('等待门禁');
  });

  it('建议头和门禁头一致、即使没有 waiting_for，也不当成等 CI', () => {
    const ask = composeApprovalAsk({
      suggestedNextState: '等待门禁',
      previousState: '挂起',
      gate: { phase: 'need_start_build', summary: '评论 start build', head_sha: HEAD },
      suggestion: { mode: 'suggestion', head_sha: HEAD },
    });
    expect(ask.kind).toBe('human');
    expect(ask.ask).toBe(DECISION_ASK);
  });

  it('建议头已经漂移且没有 user_decision 时，不按待决策处理', () => {
    expect(isReviewDecision({
      phase: 'running',
      suggestion: { mode: 'suggestion', head_sha: 'a'.repeat(40) },
      gateHeadSha: HEAD,
      waitingFor: 'webhook',
    })).toBe(false);
  });

  it('门禁仍在跑时显示正在等 CI，并保留进入等待门禁', () => {
    const ask = composeApprovalAsk({
      suggestedNextState: '等待门禁',
      previousState: '挂起',
      gate: { phase: 'running', summary: '门禁仍在进行' },
      waitingFor: 'webhook',
    });
    expect(ask.kind).toBe('suspended');
    expect(ask.ask).toBe('正在等 CI，不用点确认。门禁仍在进行');
    expect(ask.suggestedNextState).toBe('等待门禁');
  });

  it('没有关联 Issue 时说明要确认的是终止原因，而不是等门禁', () => {
    const ask = composeApprovalAsk({
      suggestedNextState: '终止',
      previousState: '挂起',
      gate: { phase: 'blocked_no_issue', summary: 'CI 拒绝 start build' },
    });
    expect(ask.kind).toBe('human');
    expect(ask.ask).toContain('没有关联 Issue');
    expect(ask.ask).toContain('终止');
    expect(ask.suggestedNextState).toBe('终止');
  });
});

const homes: string[] = [];
const previousHome = process.env.ACE_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.ACE_HOME;
  else process.env.ACE_HOME = previousHome;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function writeRun(options: {
  runId: string;
  waitingFor: 'user_decision' | 'webhook';
  gate: Record<string, unknown>;
  suggestion?: Record<string, unknown> | null;
  parkAs?: 'markdown' | 'step-result';
}) {
  const home = mkdtempSync(join(tmpdir(), 'approval-demo-'));
  homes.push(home);
  const runDir = join(home, 'runs', options.runId);
  const workDir = join(home, 'run-workspaces', options.runId);
  mkdirSync(join(runDir, 'outputs', 'step-logs'), { recursive: true });
  mkdirSync(join(workDir, 'outputs'), { recursive: true });
  writeFileSync(join(runDir, 'state.yaml'), [
    `currentPhase: __human_approval__`,
    `currentState: __human_approval__`,
    `workingDirectory: ${workDir}`,
    `pendingHumanQuestionId: hq-demo-1`,
    `humanQuestions:`,
    `  - id: hq-demo-1`,
    `    status: unanswered`,
    `    previousState: 挂起`,
    `    suggestedNextState: 等待门禁`,
    `    message: Supervisor 建议进入 等待门禁，请确认下一步状态。`,
    `status: running`,
    '',
  ].join('\n'));
  writeFileSync(join(runDir, 'outputs', 'gate-check.json'), JSON.stringify(options.gate));
  const park = { verdict: 'pass', phase: options.gate.phase, summary: options.gate.summary, waiting_for: options.waitingFor };
  if (options.parkAs === 'step-result') {
    writeFileSync(
      join(runDir, 'outputs', 'step-logs', '挂起-记录挂起-demo.result.json'),
      JSON.stringify({ fields: { waiting_for: options.waitingFor } }),
    );
  } else {
    writeFileSync(join(runDir, 'outputs', '挂起-记录挂起.md'), '```json\n' + JSON.stringify(park, null, 2) + '\n```\n');
  }
  if (options.suggestion) {
    writeFileSync(join(workDir, 'outputs', 'review-suggestion.json'), JSON.stringify(options.suggestion));
  }
  process.env.ACE_HOME = home;
  return { home, runDir, workDir };
}

describe('readHumanApproval / classifyParkApproval 临时运行目录', () => {
  it('复刻 PR 2111：旧门禁文件加工作区建议，读出来是待人工决策', () => {
    const runId = 'run-demo-pr2111-decision';
    writeRun({
      runId,
      waitingFor: 'user_decision',
      gate: {
        phase: 'need_start_build',
        summary: '已有欢迎评论且 DCO 通过，评论 start build；不要等 AI已检视',
        head_sha: HEAD,
      },
      suggestion: { mode: 'suggestion', head_sha: HEAD },
    });
    expect(classifyParkApproval(runId)).toBe('decision');
    const approval = readHumanApproval(runId);
    expect(approval?.kind).toBe('human');
    expect(approval?.ask).toBe(DECISION_ASK);
    expect(approval?.suggestedNextState).toBe('');
  });

  it('只有步骤结果里的 waiting_for 时也能识别人工决策', () => {
    const runId = 'run-demo-step-result';
    writeRun({
      runId,
      waitingFor: 'user_decision',
      parkAs: 'step-result',
      gate: { phase: 'need_start_build', summary: '评论 start build', head_sha: HEAD },
    });
    expect(classifyParkApproval(runId)).toBe('decision');
    expect(readHumanApproval(runId)?.kind).toBe('human');
  });

  it('复刻正在等门禁的 PR：waiting_for=webhook 且门禁 running', () => {
    const runId = 'run-demo-pr1561-ci';
    writeRun({
      runId,
      waitingFor: 'webhook',
      gate: { phase: 'running', summary: '门禁仍在进行', head_sha: HEAD },
    });
    expect(classifyParkApproval(runId)).toBe('webhook');
    const approval = readHumanApproval(runId);
    expect(approval?.kind).toBe('suspended');
    expect(approval?.ask).toBe('正在等 CI，不用点确认。门禁仍在进行');
    expect(approval?.suggestedNextState).toBe('等待门禁');
  });

  it('非法 runId 不读磁盘', () => {
    expect(classifyParkApproval('../etc')).toBe('');
    expect(readHumanApproval('not-a-run')).toBeNull();
  });
});
