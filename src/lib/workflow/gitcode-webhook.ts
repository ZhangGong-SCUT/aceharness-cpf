import { randomUUID } from 'crypto';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { loadSystemSettings } from '@/lib/config/system-settings';
import { loadUsers, storeToken, type User } from '@/lib/core/user-store';
import {
  DEFAULT_PR_REVIEW_CONFIG,
  describeIgnoredPr,
  parseGitcodeWebhookPayload,
  parseNameList,
} from '@/lib/workflow/pr-review-input';
import { decideGitcodeWebhookRun, formatWakeInstruction, resolveGitcodeMaxParallel, WAIT_WAKE_STATES, FIX_STATES, identityFromPrInput, identityFromGlobalContext, type RunningPrSnapshot } from '@/lib/workflow/gitcode-pr-wake';
import { isStateMachineManagerLike, workflowRegistry } from '@/lib/workflow/registry';
import { getWorkspaceRoot } from '@/lib/core/app-paths';

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

  // 既有活跃监控（挂起/等待门禁等）的唤醒不受启动白名单约束：
  // manual-start-by 豁免启动的监控（作者不在 ACE_GITCODE_PR_AUTHOR 白名单）同样依赖
  // webhook 唤醒推进流程，若此处被白名单拦截，挂起的 run 将永久休眠（pr1958 教训）。
  const running = snapshotRunningPrs(configFile);
  const incomingIdentity = identityFromPrInput(parsed.input);
  const hasActiveRunForPr = !!incomingIdentity && running.some((item) => {
    const status = String(item?.status || '');
    return (status === 'running' || status === 'preparing')
      && String(item?.runId || '').trim()
      && identityFromGlobalContext(item.globalContext) === incomingIdentity;
  });

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
  // runId 带 PR 编号（run-<ts>-pr<number>-<rand>），运行列表/目录里能直观定位是哪条 PR
  const prNumber = String(parsed.input.number || '').replace(/[^0-9A-Za-z_-]/g, '');
  const runId = `run-${Date.now()}${prNumber ? `-pr${prNumber}` : ''}-${randomUUID().slice(0, 8)}`;
  const response = await fetch(`${getInternalWorkflowBaseUrl(input.requestOrigin)}/api/workflow/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
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
function snapshotRunningPrs(configFile: string): RunningPrSnapshot[] {
  const memSnapshot = workflowRegistry.getRunningManagers()
    .filter((item) => item.configFile === configFile)
    .map((item) => {
      const status = item.manager.getStatus() as {
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
          || (typeof (item.manager as { getPendingHumanQuestion?: () => RunningPrSnapshot['pendingHumanQuestion'] }).getPendingHumanQuestion === 'function'
            ? (item.manager as { getPendingHumanQuestion: () => RunningPrSnapshot['pendingHumanQuestion'] }).getPendingHumanQuestion()
            : null),
      };
    });

  // 服务重启后，挂起/等待门禁的 run 没有内存 manager，仅靠内存快照会让 webhook 决策把它们当成"新 PR"
  // 而不是 wake 目标（pr1978 教训）。补扫磁盘 runs 目录：非终态 + 等待类状态的 run 一并纳入快照（内存优先去重）。
  // ACE_WEBHOOK_DISK_SNAPSHOT=0 可关闭（单测隔离用，避免读到真实 runs 目录破坏测试确定性）。
  if (String(process.env.ACE_WEBHOOK_DISK_SNAPSHOT ?? '1') !== '1') return memSnapshot;
  try {
    const runsDir = resolve(getWorkspaceRoot(), 'runs');
    const seen = new Set(memSnapshot.map((s) => String(s.runId || '')));
    for (const name of readdirSync(runsDir)) {
      if (!name.startsWith('run-') || !/-pr\d+(-|$)/.test(name)) continue;
      const summaryPath = join(runsDir, name, 'summary.json');
      const statePath = join(runsDir, name, 'state.yaml');
      if (!existsSync(summaryPath) || !existsSync(statePath)) continue;
      let summary: { runId?: string; configFile?: string; status?: string; currentPhase?: string } | null = null;
      try { summary = JSON.parse(readFileSync(summaryPath, 'utf8')); } catch { continue; }
      if (!summary || summary.configFile !== configFile) continue;
      if (['completed', 'failed', 'crashed', 'stopped'].includes(String(summary.status))) continue;
      const runId = String(summary.runId || name);
      if (seen.has(runId)) continue;
      // 从 state.yaml 文本提取 pr_url 构造 globalContext 身份（classifyPrReviewInput 能从中解析 owner/repo/number）
      let globalContext = '';
      try {
        const raw = readFileSync(statePath, 'utf8');
        const m = raw.match(/pr_url:\s*(\S+)/);
        globalContext = m ? `GitCode 自己的 PR 自修任务\npr_url: ${m[1]}` : '';
      } catch { continue; }
      if (!globalContext) continue;
      const currentState = String(summary.currentPhase || '');
      if (!WAIT_WAKE_STATES.has(currentState) && !FIX_STATES.has(currentState)) continue;
      seen.add(runId);
      memSnapshot.push({
        runId,
        status: summary.status,
        currentState: currentState || null,
        globalContext,
        pendingHumanQuestion: currentState === '__human_approval__' ? {} : null,
      });
    }
  } catch { /* 磁盘扫描失败时退回纯内存快照 */ }
  return memSnapshot;
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
