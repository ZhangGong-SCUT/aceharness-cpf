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
  | { action: 'start'; activeCount?: number }
  | { action: 'ignore'; reason: string }
  | { action: 'wake'; mode: 'resume-wait' | 'queue'; runId: string; currentState: string; reason: string }
  | { action: 'busy-parallel'; reason: string; activeCount: number; runIds: string[] };

export function identityFromPrInput(input: Pick<PrReviewInput, 'owner' | 'repo' | 'number'>): string {
  return prIdentityKey(input.owner, input.repo, input.number);
}

export function identityFromGlobalContext(globalContext?: string | null): string {
  const parsed = classifyPrReviewInput(globalContext);
  return prIdentityKey(parsed.owner, parsed.repo, parsed.number);
}

export const DEFAULT_GITCODE_MAX_PARALLEL = 3;

export function resolveGitcodeMaxParallel(): number {
  const raw = Number(process.env.ACE_GITCODE_MAX_PARALLEL || 0);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_GITCODE_MAX_PARALLEL;
}

/**
 * 多 PR 并行调度：同一配置可同时活跃多个 run（每 run 独立 manager 与工作区）。
 * 进来的事件按 PR 身份匹配——匹配到就唤醒那个 run，没匹配到且未达并发上限就新起 run。
 * running 兼容单快照（旧调用方/测试）与快照数组两种形态。
 */
export function decideGitcodeWebhookRun(input: {
  incoming: PrReviewInput;
  running?: RunningPrSnapshot | RunningPrSnapshot[] | null;
  maxParallel?: number;
}): WebhookRunDecision {
  const incomingKey = identityFromPrInput(input.incoming);
  if (!incomingKey) {
    return { action: 'ignore', reason: 'payload 缺少 owner/repo/number' };
  }

  const rawRunning = input.running;
  const snapshots = Array.isArray(rawRunning)
    ? rawRunning
    : rawRunning
      ? [rawRunning]
      : [];
  const active = snapshots.filter((item) => {
    const status = String(item?.status || '');
    return (status === 'running' || status === 'preparing') && String(item?.runId || '').trim();
  });

  const matched = active.find((item) => identityFromGlobalContext(item.globalContext) === incomingKey);
  if (matched) {
    const runId = String(matched.runId || '').trim();
    const currentState = String(matched.currentState || '');
    const waiting = WAIT_WAKE_STATES.has(currentState) || Boolean(matched.pendingHumanQuestion);
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

  const maxParallel = Number(input.maxParallel || DEFAULT_GITCODE_MAX_PARALLEL);
  if (active.length >= maxParallel) {
    const runIds = active.map((item) => String(item.runId || ''));
    return {
      action: 'busy-parallel',
      reason: `并发已达上限 ${maxParallel}（活跃 ${active.length} 个 PR run：${runIds.join(', ')}），本次事件丢弃，稍后请重新触发`,
      activeCount: active.length,
      runIds,
    };
  }

  return { action: 'start', activeCount: active.length };
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
