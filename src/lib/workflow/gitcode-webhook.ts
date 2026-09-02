import { randomUUID } from 'crypto';
import { loadSystemSettings } from '@/lib/config/system-settings';
import { loadUsers, storeToken, type User } from '@/lib/core/user-store';
import {
  DEFAULT_PR_REVIEW_CONFIG,
  describeIgnoredPr,
  parseGitcodeWebhookPayload,
  parseNameList,
} from '@/lib/workflow/pr-review-input';
import { decideGitcodeWebhookRun, formatWakeInstruction, type RunningPrSnapshot } from '@/lib/workflow/gitcode-pr-wake';
import { isStateMachineManagerLike, workflowRegistry } from '@/lib/workflow/registry';

export const GITCODE_PR_REVIEW_CONFIG = DEFAULT_PR_REVIEW_CONFIG;

export function extractGitcodeWebhookSecret(input: {
  query?: Record<string, string | string[] | undefined>;
  headers?: Headers | Record<string, string | null | undefined>;
  body?: any;
}): string {
  const query = input.query || {};
  const fromQuery = firstQueryValue(query.password)
    || firstQueryValue(query.secret)
    || firstQueryValue(query.token);
  const headerSecret = readHeader(input.headers, 'x-gitcode-token')
    || readHeader(input.headers, 'x-webhook-secret')
    || readHeader(input.headers, 'x-hub-signature');
  const body = input.body && typeof input.body === 'object' ? input.body : {};
  return String(
    fromQuery
    || headerSecret
    || body.password
    || body.secret
    || body.token
    || '',
  ).trim();
}

export function secretsMatch(provided: string, expected: string): boolean {
  return Boolean(provided) && Boolean(expected) && provided === expected;
}

export async function resolveGitcodeWebhookSecret(): Promise<string> {
  const fromEnv = String(process.env.ACE_GITCODE_WEBHOOK_SECRET || '').trim();
  if (fromEnv) return fromEnv;
  const settings = await loadSystemSettings();
  return String(settings.gitcodeWebhookSecret || '').trim();
}

export async function resolveGitcodePrAuthors(): Promise<string[]> {
  const fromEnv = parseNameList(process.env.ACE_GITCODE_PR_AUTHOR);
  if (fromEnv.length > 0) return fromEnv;
  const settings = await loadSystemSettings();
  return parseNameList(settings.gitcodePrAuthor);
}

export async function resolveGitcodeWatchRepos(): Promise<string[]> {
  const fromEnv = parseNameList(process.env.ACE_GITCODE_WATCH_REPOS);
  if (fromEnv.length > 0) return fromEnv;
  const settings = await loadSystemSettings();
  return parseNameList(settings.gitcodeWatchRepos);
}

export async function resolveWebhookRunUser(): Promise<User> {
  const preferredId = String(process.env.ACE_GITCODE_WEBHOOK_USER_ID || '').trim();
  const users = await loadUsers();
  const preferred = preferredId ? users.find((user) => user.id === preferredId && user.status === 'active') : undefined;
  const admin = users.find((user) => user.role === 'admin' && user.status === 'active');
  const fallback = users.find((user) => user.status === 'active');
  const user = preferred || admin || fallback;
  if (!user) {
    throw new Error('Webhook 缺少可用执行用户，请先完成 ACEHarness 账号初始化');
  }
  return user;
}

export function getInternalWorkflowBaseUrl(requestOrigin?: string): string {
  const raw = process.env.ACE_INTERNAL_BASE_URL?.trim()
    || process.env.ACE_PUBLIC_ORIGIN?.trim()
    || requestOrigin?.trim()
    || `http://127.0.0.1:${process.env.PORT || process.env.ACE_PORT || 3000}`;
  return raw.replace(/\/+$/, '');
}

export async function startPrReviewFromWebhook(input: {
  payload: unknown;
  requestOrigin?: string;
  configFile?: string;
}): Promise<{
  accepted: boolean;
  started: boolean;
  woken?: boolean;
  status: number;
  reason: string;
  runId?: string;
  configFile: string;
  action: string;
  event: string;
  author?: string | null;
  prUrl?: string | null;
}> {
  const parsed = parseGitcodeWebhookPayload(input.payload);
  const configFile = input.configFile || process.env.ACE_GITCODE_REVIEW_CONFIG?.trim() || GITCODE_PR_REVIEW_CONFIG;
  if (!parsed.accepted) {
    return {
      accepted: false,
      started: false,
      status: 202,
      reason: parsed.reason,
      configFile,
      action: parsed.action,
      event: parsed.event,
      author: parsed.input.author,
      prUrl: parsed.input.prUrl,
    };
  }

  const ignored = describeIgnoredPr({
    author: parsed.input.author,
    owner: parsed.input.owner,
    repo: parsed.input.repo,
    allowedAuthors: await resolveGitcodePrAuthors(),
    watchedRepos: await resolveGitcodeWatchRepos(),
  });
  if (ignored) {
    return {
      accepted: false,
      started: false,
      status: 202,
      reason: ignored,
      configFile,
      action: parsed.action,
      event: parsed.event,
      author: parsed.input.author,
      prUrl: parsed.input.prUrl,
    };
  }

  const running = snapshotRunningPr(configFile);
  const decision = decideGitcodeWebhookRun({
    incoming: parsed.input,
    running,
  });
  if (decision.action === 'ignore') {
    return {
      accepted: false,
      started: false,
      status: 202,
      reason: decision.reason,
      configFile,
      action: parsed.action,
      event: parsed.event,
      author: parsed.input.author,
      prUrl: parsed.input.prUrl,
    };
  }
  if (decision.action === 'busy-other-pr') {
    return {
      accepted: true,
      started: false,
      status: 409,
      reason: decision.reason,
      runId: decision.runId,
      configFile,
      action: parsed.action,
      event: parsed.event,
      author: parsed.input.author,
      prUrl: parsed.input.prUrl,
    };
  }
  if (decision.action === 'wake') {
    const woke = await wakeExistingPrRun({
      runId: decision.runId,
      configFile,
      mode: decision.mode,
      instruction: formatWakeInstruction({
        action: parsed.action,
        event: parsed.event,
        context: parsed.context,
        mode: decision.mode,
      }),
      context: parsed.context,
    });
    return {
      accepted: true,
      started: false,
      woken: true,
      status: 202,
      reason: woke.ok ? decision.reason : woke.reason,
      runId: decision.runId,
      configFile,
      action: parsed.action,
      event: parsed.event,
      author: parsed.input.author,
      prUrl: parsed.input.prUrl,
    };
  }

  const user = await resolveWebhookRunUser();
  const token = randomUUID();
  storeToken(token, user.id);
  const response = await fetch(`${getInternalWorkflowBaseUrl(input.requestOrigin)}/api/workflow/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      configFile,
      skipPreflight: true,
      initialContexts: {
        globalContext: parsed.context,
        phaseContexts: {},
      },
    }),
  });

  const data = await readJsonResponse(response);
  if (!response.ok) {
    return {
      accepted: true,
      started: false,
      status: response.status,
      reason: data.error || data.message || `工作流启动失败 ${response.status}`,
      configFile,
      action: parsed.action,
      event: parsed.event,
      author: parsed.input.author,
      prUrl: parsed.input.prUrl,
    };
  }

  return {
    accepted: true,
    started: true,
    status: 202,
    reason: 'started',
    runId: data.runId,
    configFile,
    action: parsed.action,
    event: parsed.event,
    author: parsed.input.author,
    prUrl: parsed.input.prUrl,
  };
}

function snapshotRunningPr(configFile: string): RunningPrSnapshot | null {
  const manager = workflowRegistry.getRunningManager(configFile);
  if (!manager) return null;
  const status = manager.getStatus() as {
    runId?: string;
    status?: string;
    currentState?: string | null;
    globalContext?: string;
    pendingHumanQuestion?: RunningPrSnapshot['pendingHumanQuestion'];
  };
  return {
    runId: status.runId,
    status: status.status,
    currentState: status.currentState,
    globalContext: status.globalContext,
    pendingHumanQuestion: status.pendingHumanQuestion
      || (typeof (manager as { getPendingHumanQuestion?: () => RunningPrSnapshot['pendingHumanQuestion'] }).getPendingHumanQuestion === 'function'
        ? (manager as { getPendingHumanQuestion: () => RunningPrSnapshot['pendingHumanQuestion'] }).getPendingHumanQuestion()
        : null),
  };
}

async function wakeExistingPrRun(input: {
  runId: string;
  configFile: string;
  mode: 'resume-wait' | 'queue';
  instruction: string;
  context: string;
}): Promise<{ ok: boolean; reason: string }> {
  const manager = await workflowRegistry.getManagerByRunId(input.runId)
    || workflowRegistry.getRunningManager(input.configFile);
  if (!manager) {
    return { ok: false, reason: `找不到运行中的工作流 ${input.runId}` };
  }

  const status = manager.getStatus() as {
    globalContext?: string;
    currentState?: string | null;
    pendingHumanQuestion?: { id?: string; answerSchema?: { type?: string } } | null;
  };
  const mergedContext = [status.globalContext, input.context].filter(Boolean).join('\n\n--- webhook ---\n\n');
  if (typeof manager.setContext === 'function') {
    manager.setContext('global', mergedContext);
  }

  if (input.mode === 'queue') {
    const sm = manager as { enqueueLiveFeedback?: (message: string) => void };
    if (typeof sm.enqueueLiveFeedback === 'function') {
      sm.enqueueLiveFeedback(input.instruction);
      return { ok: true, reason: 'queued' };
    }
    manager.injectLiveFeedback(input.instruction);
    return { ok: true, reason: 'queued-interrupt' };
  }

  if (!isStateMachineManagerLike(manager)) {
    manager.injectLiveFeedback(input.instruction);
    return { ok: true, reason: 'feedback' };
  }

  const pending = status.pendingHumanQuestion
    || manager.getPendingHumanQuestion?.();
  if (pending?.id && pending.answerSchema?.type === 'approval-transition') {
    await manager.answerHumanQuestion(pending.id, {
      selectedState: '等待门禁',
      instruction: input.instruction,
    }, { id: 'gitcode-webhook', name: 'gitcode-webhook' });
    return { ok: true, reason: 'approval-answered' };
  }

  manager.setQueuedApprovalAction?.('approve');
  manager.forceTransition('等待门禁', input.instruction, { id: 'gitcode-webhook', name: 'gitcode-webhook' });
  return { ok: true, reason: 'force-wait' };
}

function firstQueryValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').trim();
}

function readHeader(headers: Headers | Record<string, string | null | undefined> | undefined, name: string): string {
  if (!headers) return '';
  if (typeof (headers as Headers).get === 'function') {
    return String((headers as Headers).get(name) || '').trim();
  }
  const record = headers as Record<string, string | null | undefined>;
  const match = Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return String(match?.[1] || '').trim();
}

async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
