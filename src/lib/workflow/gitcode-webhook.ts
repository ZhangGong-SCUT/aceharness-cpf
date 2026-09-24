import { randomUUID } from 'crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadRunState } from '@/lib/run/state-persistence';
import { mergePrEventContext } from '@/lib/workflow/pr-monitor-state';
import { executePrScript } from '@/lib/workflow/pr-script-step';
import { join, resolve } from 'path';
import { loadSystemSettings } from '@/lib/config/system-settings';
import { loadUsers, storeToken, type User } from '@/lib/core/user-store';
import {
  DEFAULT_PR_REVIEW_CONFIG,
  describeIgnoredPr,
  parseGitcodeWebhookPayload,
  parseNameList,
} from '@/lib/workflow/pr-review-input';
import { formatWakeInstruction, identityFromPrInput, identityFromGlobalContext } from '@/lib/workflow/gitcode-pr-wake';
import { decideGitcodeWebhookRun, resolveGitcodeMaxParallel, isPrGateWait, type RunningPrSnapshot } from '@/lib/workflow/pr-monitor-policy';
import { isStateMachineManagerLike, workflowRegistry } from '@/lib/workflow/registry';
import { getWorkspaceRoot } from '@/lib/core/app-paths';

export const GITCODE_PR_REVIEW_CONFIG = DEFAULT_PR_REVIEW_CONFIG;
const startingRuns = new Map<string, { until: number; snapshot: RunningPrSnapshot }>();

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

/**
 * webhook 是否自动启动 PR 监控。
 * 显式配置 ACE_GITCODE_AUTO_MONITOR=true/on/1 或 settings.gitcodeAutoMonitor=true 时开启；
 * 其余情况（未配置）默认人工模式：webhook 只接收记录，不启动工作流。
 */
export async function resolveGitcodeAutoMonitor(): Promise<boolean> {
  const fromEnv = String(process.env.ACE_GITCODE_AUTO_MONITOR || '').trim().toLowerCase();
  if (fromEnv) return fromEnv === 'true' || fromEnv === 'on' || fromEnv === '1';
  const settings = await loadSystemSettings();
  return settings.gitcodeAutoMonitor === true;
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
  const parsed = parseGitcodeWebhookPayload(input.payload, { includeClosed: true });
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

  // 既有活跃监控（挂起/等待门禁等）的唤醒不受启动白名单约束：
  // manual-start-by 豁免启动的监控（作者不在 ACE_GITCODE_PR_AUTHOR 白名单）同样依赖
  // webhook 唤醒推进流程，若此处被白名单拦截，挂起的 run 将永久休眠（pr1958 教训）。
  const running = await snapshotRunningPrs(configFile);
  for (const [id, reservation] of startingRuns) {
    if (reservation.until < Date.now() || running.some(item => item.runId === id)) startingRuns.delete(id);
    else running.push(reservation.snapshot);
  }
  const incomingIdentity = identityFromPrInput(parsed.input);
  const hasActiveRunForPr = !!incomingIdentity && running.some((item) => {
    const status = String(item?.status || '');
    return (status === 'running' || status === 'preparing')
      && String(item?.runId || '').trim()
      && identityFromGlobalContext(item.globalContext) === incomingIdentity;
  });

  if (!hasActiveRunForPr && (/^(close|closed|merge|merged)$/.test(parsed.action)
    || /^state:\s*(closed|merged)\s*$/m.test(parsed.context))) {
    return { accepted: false, started: false, status: 202, reason: '已结束的 PR 不新建监控',
      configFile, action: parsed.action, event: parsed.event };
  }

  const ignored = hasActiveRunForPr ? null : describeIgnoredPr({
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

  const decision = decideGitcodeWebhookRun({
    incoming: parsed.input,
    running,
    maxParallel: resolveGitcodeMaxParallel(),
  });
  // 人工监控模式只拦「启动新监控」；wake（唤醒挂起中/等待门禁的既有 run）是已开启监控的正常运转，必须放行，
  // 否则挂起等 CI 的 run 永远收不到唤醒（pr1978 教训）。
  const autoMonitor = await resolveGitcodeAutoMonitor();
  if (!autoMonitor && decision.action !== 'ignore' && decision.action !== 'wake') {
    return {
      accepted: true,
      started: false,
      status: 202,
      reason: '人工监控模式：Webhook 事件已记录，未自动启动新监控（已开启监控的唤醒不受影响）。',
      configFile,
      action: parsed.action,
      event: parsed.event,
      author: parsed.input.author,
      prUrl: parsed.input.prUrl,
    };
  }
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
  if (decision.action === 'busy-parallel') {
    return {
      accepted: true,
      started: false,
      status: 409,
      reason: decision.reason,
      runId: decision.runIds[0],
      configFile,
      action: parsed.action,
      event: parsed.event,
      author: parsed.input.author,
      prUrl: parsed.input.prUrl,
    };
  }
  if (decision.action === 'wake') {
    const snapshot = running.find(item => item.runId === decision.runId);
    if (decision.mode === 'resume-wait' && snapshot?.workingDirectory) {
      const probe = await probePrGateWait(snapshot);
      if (!probe.wake) return { accepted: true, started: false, woken: false, status: probe.status,
        reason: probe.reason, runId: decision.runId, configFile, action: parsed.action, event: parsed.event };
    }
    const woke = await wakeExistingPrRun({
      runId: decision.runId,
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
      woken: woke.ok,
      status: woke.ok ? 202 : 503,
      reason: woke.ok ? decision.reason : woke.reason,
      runId: decision.runId,
      configFile,
      action: parsed.action,
      event: parsed.event,
      author: parsed.input.author,
      prUrl: parsed.input.prUrl,
    };
  }

  // Reserve before awaiting user/token resolution; concurrent deliveries share the cap.
  const executingReservations = [...startingRuns.values()].filter(r => r.until > Date.now()
    && !running.some(item => item.runId === r.snapshot.runId));
  if ((decision.activeCount || 0) + executingReservations.length >= resolveGitcodeMaxParallel()) {
    return { accepted: true, started: false, status: 409, reason: '启动名额已满，保留排队',
      configFile, action: parsed.action, event: parsed.event };
  }
  const prNumber = String(parsed.input.number || '').replace(/[^0-9A-Za-z_-]/g, '');
  const runId = `run-${Date.now()}${prNumber ? `-pr${prNumber}` : ''}-${randomUUID().slice(0, 8)}`;
  startingRuns.set(runId, { until: Date.now() + 30000, snapshot: {
    runId, status: 'preparing', currentState: '识别', globalContext: parsed.context,
  } });
  const user = await resolveWebhookRunUser();
  const token = randomUUID();
  storeToken(token, user.id);
  const response = await fetch(`${getInternalWorkflowBaseUrl(input.requestOrigin)}/api/workflow/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      configFile,
      runId,
      skipPreflight: true,
      initialContexts: {
        globalContext: parsed.context,
        phaseContexts: {},
      },
    }),
  });

  const data = await readJsonResponse(response);
  if (!response.ok) {
    startingRuns.delete(runId);
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

/**
 * 同一配置可并行多个 PR run（每 run 独立 manager / 工作区）。
 * 快照全部活跃 run，事件按 PR 身份精确匹配唤醒；没匹配到且未达并发上限就新起 run。
 */
let diskSnapshots: { at: number; items: RunningPrSnapshot[]; config: string } | null = null;

function waitingFor(question: any): 'webhook' | 'user_decision' {
  return /"waiting_for"\s*:\s*"user_decision"/.test((question?.result?.stepOutputs || []).join('\n'))
    ? 'user_decision' : 'webhook';
}

async function annotatePrWait(snapshot: RunningPrSnapshot): Promise<RunningPrSnapshot> {
  if (snapshot.pendingHumanQuestion?.previousState !== '挂起' || !snapshot.runId) return snapshot;
  // Step output bodies are compacted on persistence; never rely on them alone
  // to distinguish CI waits from approval of an unpushed suggestion.
  const paths = [join(getWorkspaceRoot(), 'runs', snapshot.runId, 'outputs', 'review-suggestion.json')];
  if (snapshot.workingDirectory && basename(snapshot.workingDirectory) === snapshot.runId) {
    paths.unshift(join(snapshot.workingDirectory, 'outputs', 'review-suggestion.json'));
  }
  for (const file of paths) {
    try {
      const suggestion = JSON.parse(await readFile(file, 'utf8'));
      if (suggestion.mode === 'suggestion') return { ...snapshot, waitingFor: 'user_decision' };
    } catch { /* optional artifact */ }
  }
  return snapshot;
}

export async function snapshotRunningPrs(configFile: string): Promise<RunningPrSnapshot[]> {
  const snapshots: RunningPrSnapshot[] = workflowRegistry.getRunningManagers()
    .filter(item => item.configFile === configFile)
    .map(({ manager }) => {
      const status = manager.getStatus() as any;
      // getStatus may have a compact question. The full question carries previousState.
      const question = { ...status.pendingHumanQuestion, ...(manager as any).getPendingHumanQuestion?.() };
      return { runId: status.runId, status: status.status, currentState: status.currentState,
        globalContext: status.globalContext, pendingHumanQuestion: question.id ? question : null,
        waitingFor: waitingFor(question), workingDirectory: status.workingDirectory,
        userId: (manager as any)._createdBy };
    });
  if (String(process.env.ACE_WEBHOOK_DISK_SNAPSHOT ?? '1') !== '1') return snapshots;
  const seen = new Set(snapshots.map(item => item.runId));
  if (!diskSnapshots || diskSnapshots.config !== configFile || Date.now() - diskSnapshots.at > 5000) {
    const items: RunningPrSnapshot[] = [];
    const runsDir = resolve(getWorkspaceRoot(), 'runs');
    const entries = await readdir(runsDir).catch(() => []);
    // Async I/O: large historical directories must not block webhook and detail HTTP requests.
    for (const name of entries) {
      if (!name.startsWith('run-') || seen.has(name)) continue;
      try {
        const summary = JSON.parse(await readFile(join(runsDir, name, 'summary.json'), 'utf8'));
        if (summary.configFile !== configFile || !['running', 'preparing'].includes(summary.status)) continue;
        const state = await loadRunState(name);
        if (!state || !['running', 'preparing'].includes(state.status)) continue;
        const question = state.humanQuestions?.find(q => q.id === state.pendingHumanQuestionId && q.status === 'unanswered');
        items.push({ runId: name, status: state.status, currentState: state.currentState || state.currentPhase,
          globalContext: state.globalContext, pendingHumanQuestion: question || null,
          waitingFor: waitingFor(question), workingDirectory: (state as any).workingDirectory,
          userId: state.createdBy || state.runOwnerId });
      } catch { /* one unreadable run must not block other PRs */ }
    }
    diskSnapshots = { at: Date.now(), items, config: configFile };
  }
  snapshots.push(...diskSnapshots.items.filter(item => !seen.has(item.runId)));
  return Promise.all(snapshots.map(annotatePrWait));
}

async function probePrGateWait(snapshot: RunningPrSnapshot): Promise<{ wake: boolean; status: number; reason: string }> {
  // Old shared template workspaces cannot be probed safely alongside another PR.
  if (!snapshot.runId || !snapshot.workingDirectory || basename(snapshot.workingDirectory) !== snapshot.runId) {
    return { wake: false, status: 202, reason: '历史任务工作区未隔离，需要重新开启监控' };
  }
  const text = await executePrScript({ operation: 'gates', stateName: '等待门禁',
    workingDirectory: snapshot.workingDirectory, runDirectory: join(getWorkspaceRoot(), 'runs', snapshot.runId),
    globalContext: snapshot.globalContext || '', userId: snapshot.userId });
  const gate = JSON.parse(text.replace(/^```json\n|\n```$/g, ''));
  if (gate.read_failed && gate.phase === 'read_error') return { wake: false, status: 503, reason: gate.summary };
  if (['running', 'review_pending_decision'].includes(gate.phase)) return { wake: false, status: 202, reason: gate.summary };
  return { wake: true, status: 202, reason: '门禁已发生可处理的变化' };
}

async function wakeExistingPrRun(input: {
  runId: string;
  mode: 'resume-wait' | 'queue';
  instruction: string;
  context: string;
}): Promise<{ ok: boolean; reason: string }> {
  // 多 run 并行下 getRunningManager(configFile) 会返回任意活跃 run，必须只按 runId 精确唤醒
  const manager = await workflowRegistry.getManagerByRunId(input.runId);
  if (!manager) {
    return { ok: false, reason: `找不到运行中的工作流 ${input.runId}` };
  }

  const status = manager.getStatus() as any;
  if (!status.runId || status.status !== 'running') {
    const persisted = await loadRunState(input.runId);
    const question = persisted?.humanQuestions?.find(q => q.id === persisted.pendingHumanQuestionId && q.status === 'unanswered');
    if (!persisted || persisted.status !== 'running' || !isPrGateWait({
      currentState: persisted.currentState, pendingHumanQuestion: question, waitingFor: waitingFor(question),
    }) || !isStateMachineManagerLike(manager)) return { ok: false, reason: '任务状态已变化，不能自动恢复' };
    // A restored manager has no execution loop. forceTransition alone silently does nothing.
    await new Promise<void>((resolveReady, reject) => {
      const onStatus = (next: any) => {
        if (next.runId === input.runId && next.status === 'running') { cleanup(); resolveReady(); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('恢复等待任务超时')); }, 15000);
      const cleanup = () => { clearTimeout(timer); manager.off('status', onStatus); };
      manager.on('status', onStatus);
      void manager.forceJumpToState(input.runId, '等待门禁', input.instruction,
        { id: 'gitcode-webhook', name: 'gitcode-webhook' }).then(() => { cleanup(); resolveReady(); }, error => {
          cleanup(); reject(error);
        });
    });
    diskSnapshots = null;
    return { ok: true, reason: 'restored-wait' };
  }
  const pending = { ...status.pendingHumanQuestion, ...(manager as any).getPendingHumanQuestion?.() };
  if (input.mode === 'resume-wait' && !isPrGateWait({
    currentState: status.currentState, pendingHumanQuestion: pending.id ? pending : null, waitingFor: waitingFor(pending),
  })) return { ok: false, reason: '任务已不处于可自动唤醒的门禁等待' };
  const mergedContext = mergePrEventContext(status.globalContext || '', input.context);
  manager.setContext?.('global', mergedContext);

  if (input.mode === 'queue') {
    const sm = manager as { enqueueLiveFeedback?: (message: string, options?: { id: string; automatic: boolean }) => void };
    if (typeof sm.enqueueLiveFeedback === 'function') {
      sm.enqueueLiveFeedback(input.instruction, { id: 'pr-gate-refresh', automatic: true });
      return { ok: true, reason: 'queued' };
    }
    manager.injectLiveFeedback(input.instruction);
    return { ok: true, reason: 'queued-interrupt' };
  }

  if (!isStateMachineManagerLike(manager)) {
    manager.injectLiveFeedback(input.instruction);
    return { ok: true, reason: 'feedback' };
  }

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
