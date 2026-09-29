import type { PrReviewInput } from '@/lib/workflow/pr-review-input';
import { identityFromPrInput, identityFromGlobalContext, FIX_STATES } from '@/lib/workflow/gitcode-pr-wake';

export type RunningPrSnapshot = {
  runId?: string;
  status?: string;
  currentState?: string | null;
  globalContext?: string;
  pendingHumanQuestion?: { id?: string; previousState?: string | null; answerSchema?: { type?: string } } | null;
  waitingFor?: 'webhook' | 'user_decision' | 'push_reconcile';
  workingDirectory?: string;
  userId?: string;
};

export type WebhookRunDecision =
  | { action: 'start'; activeCount?: number }
  | { action: 'ignore'; reason: string }
  | { action: 'wake'; mode: 'resume-wait' | 'queue'; runId: string; currentState: string; reason: string }
  | { action: 'busy-parallel'; reason: string; activeCount: number; runIds: string[] };

export const DEFAULT_GITCODE_MAX_PARALLEL = 3;

export function resolveGitcodeMaxParallel(): number {
  const raw = Number(process.env.ACE_GITCODE_MAX_PARALLEL || 0);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_GITCODE_MAX_PARALLEL;
}

export function isPrGateWait(item: RunningPrSnapshot): boolean {
  if (item.waitingFor === 'push_reconcile' && item.pendingHumanQuestion?.previousState === '人工确认') return true;
  if (item.waitingFor === 'user_decision') return false;
  const state = item.currentState;
  if (state === '__human_approval__' || item.pendingHumanQuestion) {
    return item.pendingHumanQuestion?.previousState === '挂起';
  }
  // 等待门禁 is a running script. Do not interrupt it while it is fetching.
  return state === '挂起';
}

export function isPrHumanWait(item: RunningPrSnapshot): boolean {
  return item.waitingFor === 'user_decision'
    || ((item.currentState === '__human_approval__' || !!item.pendingHumanQuestion) && !isPrGateWait(item));
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
    if (isPrHumanWait(matched)) return { action: 'ignore', reason: '等待用户决策，Webhook 不代替用户回答审批' };
    const waiting = isPrGateWait(matched);
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
  const executing = active.filter(item => !isPrGateWait(item) && !isPrHumanWait(item));
  if (executing.length >= maxParallel) {
    const runIds = executing.map((item) => String(item.runId || ''));
    return {
      action: 'busy-parallel',
      reason: `并发已达上限 ${maxParallel}（执行中 ${executing.length} 个 PR run），事件保留排队`,
      activeCount: executing.length,
      runIds,
    };
  }

  return { action: 'start', activeCount: executing.length };
}
