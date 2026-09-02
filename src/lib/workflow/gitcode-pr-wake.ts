import {
  classifyPrReviewInput,
  prIdentityKey,
  type PrReviewInput,
} from '@/lib/workflow/pr-review-input';

export const WAIT_WAKE_STATES = new Set(['挂起', '等待门禁', '__human_approval__']);
export const FIX_STATES = new Set(['静态修复', '编译修复', 'DCO修复', '检视修复', '推送并触发']);

export type RunningPrSnapshot = {
  runId?: string;
  status?: string;
  currentState?: string | null;
  globalContext?: string;
  pendingHumanQuestion?: { id?: string; answerSchema?: { type?: string } } | null;
};

export type WebhookRunDecision =
  | { action: 'start' }
  | { action: 'ignore'; reason: string }
  | { action: 'wake'; mode: 'resume-wait' | 'queue'; runId: string; currentState: string; reason: string }
  | { action: 'busy-other-pr'; reason: string; runId: string; currentState: string };

export function identityFromPrInput(input: Pick<PrReviewInput, 'owner' | 'repo' | 'number'>): string {
  return prIdentityKey(input.owner, input.repo, input.number);
}

export function identityFromGlobalContext(globalContext?: string | null): string {
  const parsed = classifyPrReviewInput(globalContext);
  return prIdentityKey(parsed.owner, parsed.repo, parsed.number);
}

export function decideGitcodeWebhookRun(input: {
  incoming: PrReviewInput;
  running?: RunningPrSnapshot | null;
}): WebhookRunDecision {
  const incomingKey = identityFromPrInput(input.incoming);
  if (!incomingKey) {
    return { action: 'ignore', reason: 'payload 缺少 owner/repo/number' };
  }

  const running = input.running;
  const runningStatus = String(running?.status || '');
  const isActive = runningStatus === 'running' || runningStatus === 'preparing';
  if (!running || !isActive) {
    return { action: 'start' };
  }

  const runningKey = identityFromGlobalContext(running.globalContext);
  const runId = String(running.runId || '').trim();
  const currentState = String(running.currentState || '');
  if (!runId) {
    return { action: 'start' };
  }

  if (runningKey && runningKey !== incomingKey) {
    return {
      action: 'busy-other-pr',
      reason: `gitcode-pr-review 正在处理 ${runningKey}，引擎仍按 yaml 一把锁`,
      runId,
      currentState,
    };
  }

  const waiting = WAIT_WAKE_STATES.has(currentState) || Boolean(running.pendingHumanQuestion);
  const midFix = FIX_STATES.has(currentState);
  return {
    action: 'wake',
    mode: waiting ? 'resume-wait' : 'queue',
    runId,
    currentState: currentState || 'unknown',
    reason: waiting
      ? `同一 PR ${incomingKey} 正在等待门禁，唤醒现有 run`
      : `同一 PR ${incomingKey} 正在 ${midFix ? currentState : (currentState || '修复')}，门禁快照排队不打断`,
  };
}

export function formatWakeInstruction(input: {
  action: string;
  event: string;
  context: string;
  mode: 'resume-wait' | 'queue';
}): string {
  const header = input.mode === 'resume-wait'
    ? 'GitCode Webhook 唤醒等待中的门禁。回到「等待门禁」，重新拉标签和 openharmony_ci 评论，不要新开工作流。'
    : 'GitCode Webhook 更新了门禁快照。当前正在改代码，先完成本轮修复再看最新门禁，不要中断。禁止自动评论 submit。';
  return [
    header,
    `event: ${input.event}`,
    `action: ${input.action}`,
    input.context,
  ].filter(Boolean).join('\n');
}
