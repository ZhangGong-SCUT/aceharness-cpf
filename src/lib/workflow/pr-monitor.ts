import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getWorkspaceRoot } from '@/lib/core/app-paths';
import { classifyPrReviewInput, parseGitcodeWebhookPayload } from '@/lib/workflow/pr-review-input';
import { identityFromPrInput } from '@/lib/workflow/gitcode-pr-wake';
import { isPrGateWait } from '@/lib/workflow/pr-monitor-policy';
import { GITCODE_PR_REVIEW_CONFIG, snapshotRunningPrs, startPrReviewFromWebhook } from '@/lib/workflow/gitcode-webhook';
import { PrEventQueue } from '@/lib/workflow/pr-event-queue';

type Runtime = { queue: PrEventQueue; timer?: ReturnType<typeof setInterval>; poll?: ReturnType<typeof setInterval>; polling?: boolean };
const shared = globalThis as typeof globalThis & { __prMonitorRuntime?: Runtime };
function runtime(): Runtime {
  return shared.__prMonitorRuntime ||= { queue: new PrEventQueue(
    join(getWorkspaceRoot(), 'data', 'pr-monitor-events.json'),
    async (job: any) => {
      const start = Date.now();
      const result = await startPrReviewFromWebhook(job);
      console.log(`[pr-monitor] status=${result.status} started=${result.started} woken=${!!result.woken} ms=${Date.now() - start} pr=${result.prUrl || ''} reason=${result.reason}`);
      return result;
    },
  ) };
}

/** Persist only normalized PR fields. Never store webhook secrets, HTTP headers or tokens. */
export async function enqueuePrWebhook(payload: unknown) {
  const parsed = parseGitcodeWebhookPayload(payload, { includeClosed: true });
  const configFile = process.env.ACE_GITCODE_REVIEW_CONFIG?.trim() || GITCODE_PR_REVIEW_CONFIG;
  const base = { accepted: parsed.accepted, started: false, status: 202, configFile,
    action: parsed.action, event: parsed.event, author: parsed.input.author, prUrl: parsed.input.prUrl };
  if (!parsed.accepted) return { ...base, reason: parsed.reason };
  const pr = parsed.input;
  const body = payload as any;
  const note = body?.object_attributes || body?.comment || body?.note || {};
  const pull = body?.pull_request || body?.merge_request || body?.object_attributes || {};
  const revision = createHash('sha256').update(JSON.stringify({ id: note.id, body: note.body || note.note,
    updated: note.updated_at || note.created_at, labels: pull.labels, state: pull.state,
    poll: body?.monitor_poll })).digest('hex');
  const event = { hook_name: parsed.event, action: parsed.action, monitor_revision: revision,
    repository: { full_name: `${pr.owner}/${pr.repo}` },
    pull_request: { number: pr.number, html_url: pr.prUrl, title: pr.title,
      state: /^(close|closed|merge|merged)$/.test(parsed.action) ? 'closed' : pull.state || 'open',
      user: { login: pr.author }, head: { ref: pr.headRef, sha: pr.headSha, repo: { full_name: pr.headRepo } },
      base: { ref: pr.baseRef } } };
  const queued = await runtime().queue.enqueue(`${configFile}:${identityFromPrInput(pr)}`, { payload: event, configFile });
  return { ...base, ...queued, reason: queued.duplicate ? '重复事件已合并' : '事件已持久化，等待处理' };
}

/** Webhook is primary; poll only explicitly enabled, idle gate waits to recover missed deliveries. */
export async function reconcilePrGateWaits() {
  const state = runtime();
  if (state.polling) return;
  state.polling = true;
  try {
    const configFile = process.env.ACE_GITCODE_REVIEW_CONFIG?.trim() || GITCODE_PR_REVIEW_CONFIG;
    const runs = await snapshotRunningPrs(configFile);
    for (const run of runs) {
      if (!isPrGateWait(run) || !run.globalContext) continue;
      const pr = classifyPrReviewInput(run.globalContext);
      if (!identityFromPrInput(pr)) continue;
      await enqueuePrWebhook({ action: 'update', hook_name: 'monitor_poll', monitor_poll: Math.floor(Date.now() / 30000),
        repository: { full_name: `${pr.owner}/${pr.repo}` },
        pull_request: { number: pr.number, html_url: pr.prUrl, state: 'open',
          user: { login: pr.author }, head: { ref: pr.headRef, sha: pr.headSha, repo: { full_name: pr.headRepo } }, base: { ref: pr.baseRef } } });
    }
  } finally { state.polling = false; }
}

export function startPrMonitorWorker() {
  const state = runtime();
  if (state.timer) return;
  state.timer = setInterval(() => {
    void state.queue.drain().catch(() => console.error('[pr-monitor] 事件队列处理失败，将重试'));
  }, 1000);
  state.timer.unref();
  state.poll = setInterval(() => {
    void reconcilePrGateWaits().catch(() => console.error('[pr-monitor] 门禁补查失败，将重试'));
  }, 30000);
  state.poll.unref();
}

export const getPrMonitorQueueStatus = () => runtime().queue.status();
