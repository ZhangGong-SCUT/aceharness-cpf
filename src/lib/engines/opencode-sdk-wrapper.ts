/**
 * OpenCode SDK Engine Wrapper
 *
 * Uses @opencode-ai/sdk to communicate with OpenCode via HTTP API
 * instead of stdio ACP. One server instance serves all sessions.
 *
 * Note: the upstream SDK's createOpencode({ env }) helper currently does not
 * forward custom env vars into the spawned `opencode serve` process. We work
 * around that here by temporarily patching process.env during server startup,
 * then restoring it immediately after the child process is launched.
 */

import { findCommand, getCommonCliSearchPaths } from '@/lib/core/command-exists';
import { EventEmitter } from 'events';
import { ensureOpenCodeCompatibleMcpServers } from '@/lib/mcp/registry';
import type { Engine, EngineOptions, EngineResult, EngineStreamEvent } from './engine-interface';
import { normalizeEngineOutput } from './engine-output';
import { buildConfiguredProcessEnvSync, getConfiguredCliSearchPaths } from '@/lib/core/configured-env';
import { buildOpenCodeRawCommandPrompt, isOpenCodeSlashCommandPrompt, parseOpenCodeSlashCommand } from './opencode-command';
import { mergeOpenCodeCommandsWithFileFallback } from './opencode-command-files';
import {
  buildOpenCodeExecutePrompt,
  discoverOpenCodeCommandsFromHttpClient,
  discoverOpenCodeModelsFromHttpClient,
  executeCommandWithOpenCodeHttp,
  getSessionId,
  resolveOpenCodeModelId,
  type OpenCodeHttpClient,
  type OpenCodeDiscoveredCommand,
  type OpenCodeDiscoveredModel,
  sendPromptWithOpenCodeHttp,
  ZERO_USAGE_METADATA,
} from './opencode-http-adapter';
import { registerOpenCodeNativeAgent, registerOpenCodeVisionInspector } from './opencode-native-agent';

/**
 * Per-user 常驻 server 池。
 * 旧实现是全局单例 + env 指纹比对：不同 userId 的引擎交替执行时触发
 * "configured env changed, restarting HTTP server"，杀掉共享 serve 冷启动重启——
 * 多 run 并发时所有 HTTP 路径步骤全部阻塞（派发空转根因之一）。
 * 现改为 userId → 常驻 serve 池：各用户独立 serve 互不干扰，2 小时闲置自动回收
 * （opencode 会话存于共享存储，跨 serve 实例可 resume）。
 */
interface SdkServerEntry {
  server: { url: string; close: () => void } | null;
  client: OpenCodeHttpClient | null;
  fingerprint: string;
  starting: Promise<void> | null;
  lastActiveAt: number;
}
const serverPool = new Map<string, SdkServerEntry>();
const SDK_SERVER_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
let activeExecutions = 0;
const OPENCODE_SERVER_STARTUP_TIMEOUT_MS = 20_000;

function closeSdkServerEntry(entry: SdkServerEntry): void {
  try { entry.server?.close(); } catch { /* best-effort */ }
}

/**
 * 存活探测：池命中时先确认 serve 进程还在。
 * 背景：serve 进程被杀/崩溃后池条目仍持有死连接（连接拒绝瞬时失败），
 * 引擎快速重试会连续打中死 serve → "引擎连续失败"整个 run 挂掉（实测复现）。
 * 探测用短超时 fetch，任何 HTTP 响应（含 404）都算活。
 */
async function isSdkServerAlive(entry: SdkServerEntry): Promise<boolean> {
  if (!entry.server) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`${entry.server.url.replace(/\/$/, '')}/__pool_probe__`, { signal: controller.signal });
    return res.status < 500; // 404 也算活
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function evictIdleSdkServers(): void {
  const now = Date.now();
  for (const [key, entry] of serverPool) {
    if (!entry.starting && now - entry.lastActiveAt > SDK_SERVER_IDLE_TTL_MS) {
      console.log(`[opencode-sdk] evicting idle server (pool key=${key || '(default)'}, idle=${Math.round((now - entry.lastActiveAt) / 60000)}min)`);
      closeSdkServerEntry(entry);
      serverPool.delete(key);
    }
  }
}
const IGNORABLE_OPENCODE_SDK_ERROR_PATTERNS = [
  /ECONNRESET/i,
  /child exited early code=1 signal=null; stderr tail:\s*<empty>/i,
];

function isIgnorableOpenCodeSdkTailError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  if (!message.trim()) return false;
  return IGNORABLE_OPENCODE_SDK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

async function runtimeImport<T = any>(moduleName: string): Promise<T> {
  try {
    return await Function('moduleName', 'return import(moduleName)')(moduleName) as T;
  } catch (error: any) {
    if (String(error?.message || error).includes('dynamic import callback')) {
      return await import(/* @vite-ignore */ moduleName) as T;
    }
    throw error;
  }
}

function configuredEnvOptions(userId?: string): { userId: string } | undefined {
  return userId ? { userId } : undefined;
}

function getOpencodeCommand(userId?: string): string {
  return findCommand('opencode', getConfiguredCliSearchPaths(getCommonCliSearchPaths(), configuredEnvOptions(userId))) || 'opencode';
}

function fingerprintEnv(env: NodeJS.ProcessEnv): string {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\0${String(value ?? '')}`)
    .join('\n');
}

/**
 * F07：把 SDK/子进程错误展开成可读、可分类、已脱敏的诊断文本。
 * 历史问题：`Failed to create session: {}`——SDK 错误对象常无可枚举字段，
 * JSON.stringify 得空对象，导致下游无法区分瞬态（ECONN/5xx）与永久（401/协议）故障。
 */
export function describeSdkError(error: unknown): string {
  if (error == null) return '未知错误（空错误对象）';
  if (typeof error === 'string') return sanitizeDiagnostic(error).slice(0, 500) || '未知错误';
  const parts: string[] = [];
  const push = (value: unknown) => {
    const text = String(value ?? '').trim();
    if (text && !parts.includes(text)) parts.push(text);
  };
  const anyErr = error as any;
  if (anyErr instanceof Error) {
    push(anyErr.message);
    const extra = anyErr as any;
    if (extra.code !== undefined) push(`code=${typeof extra.code === 'object' ? JSON.stringify(extra.code) : extra.code}`);
    if (typeof extra.status === 'number') push(`HTTP ${extra.status}`);
    if (typeof extra.exitCode === 'number') push(`exit=${extra.exitCode}`);
    if (typeof extra.signal === 'string') push(`signal=${extra.signal}`);
    if (typeof extra.stderr === 'string' && extra.stderr.trim()) push(`stderr=${extra.stderr.trim().slice(-300)}`);
  } else {
    if (typeof anyErr.status === 'number') push(`HTTP ${anyErr.status}`);
    push(anyErr.statusText);
    if (anyErr.code !== undefined) push(`code=${typeof anyErr.code === 'object' ? JSON.stringify(anyErr.code) : anyErr.code}`);
    push(anyErr.message);
    push(anyErr.error?.message);
    if (anyErr.error?.code !== undefined) push(`code=${anyErr.error.code}`);
    if (anyErr.data) { try { push(JSON.stringify(anyErr.data).slice(0, 300)); } catch { /* 忽略不可序列化 */ } }
    if (typeof anyErr.stderr === 'string' && anyErr.stderr.trim()) push(`stderr=${anyErr.stderr.trim().slice(-300)}`);
    if (typeof anyErr.exitCode === 'number') push(`exit=${anyErr.exitCode}`);
  }
  if (!parts.length) {
    let json = '';
    try { json = JSON.stringify(error); } catch { json = ''; }
    push(json && json !== '{}' && json !== '[]'
      ? json.slice(0, 300)
      : `未知错误（${Object.prototype.toString.call(error)}，无可读字段）`);
  }
  const text = parts.join('；') || '未知错误（无可读字段）';
  return sanitizeDiagnostic(text).slice(0, 500);
}

/** 诊断文本脱敏：令牌/密钥不出现在日志与错误消息 */
function sanitizeDiagnostic(text: string): string {
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1…')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1…')
    .replace(/(access_token=)[A-Za-z0-9._~+/=-]+/gi, '$1…');
}

async function withTemporaryProcessEnv<T>(env: NodeJS.ProcessEnv, action: () => Promise<T>): Promise<T> {
  const snapshot = new Map<string, string | undefined>();
  const keys = new Set<string>([
    ...Object.keys(process.env),
    ...Object.keys(env),
  ]);

  for (const key of keys) {
    snapshot.set(key, process.env[key]);
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await action();
  } finally {
    for (const key of keys) {
      const original = snapshot.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}

async function ensureServer(userId?: string): Promise<{ client: OpenCodeHttpClient; url: string }> {
  const key = userId || '';
  const serverEnv = buildConfiguredProcessEnvSync(
    undefined,
    process.env,
    configuredEnvOptions(userId),
  );
  const nextFingerprint = JSON.stringify({
    userId: key,
    env: fingerprintEnv(serverEnv),
  });

  evictIdleSdkServers();

  const existing = serverPool.get(key);
  if (existing && !existing.starting && existing.fingerprint === nextFingerprint) {
    if (await isSdkServerAlive(existing)) {
      existing.lastActiveAt = Date.now();
      return { client: existing.client!, url: existing.server!.url };
    }
    console.log(`[opencode-sdk] pooled server unreachable (pool key=${key || '(default)'}), evicting and respawning...`);
    closeSdkServerEntry(existing);
    serverPool.delete(key);
  }

  // 同用户 env 变化（罕见）→ 只重启该用户自己的池条目，不影响其他用户
  if (existing && !existing.starting && existing.fingerprint !== nextFingerprint) {
    console.log(`[opencode-sdk] user=${key || '(default)'} env changed, restarting its HTTP server...`);
    closeSdkServerEntry(existing);
    serverPool.delete(key);
  }

  // 并发去重：同 key 启动中 → 等它完成后复用
  if (existing?.starting) {
    await existing.starting.catch(() => { /* 启动失败则走下方新建 */ });
    const ready = serverPool.get(key);
    if (ready && ready.client && ready.fingerprint === nextFingerprint) {
      ready.lastActiveAt = Date.now();
      return { client: ready.client, url: ready.server!.url };
    }
  }

  const entry: SdkServerEntry = {
    server: null,
    client: null,
    fingerprint: nextFingerprint,
    starting: null,
    lastActiveAt: Date.now(),
  };
  const starting = (async () => {
    const { createOpencodeClient, createOpencodeServer } = await runtimeImport<typeof import('@opencode-ai/sdk')>('@opencode-ai/sdk');
    console.log(`[opencode-sdk] starting HTTP server (pool key=${key || '(default)'}) with command ${getOpencodeCommand(userId)}...`);

    const server = await withTemporaryProcessEnv(serverEnv, async () => {
      try {
        return await createOpencodeServer({
          port: 0,
          hostname: '127.0.0.1',
          timeout: OPENCODE_SERVER_STARTUP_TIMEOUT_MS,
        } as any);
      } catch (startupError) {
        // F07：启动失败必须带命令、超时与底层错误（退出码/stderr 尾），不再只有模糊消息
        throw new Error(
          `OpenCode 服务启动失败（command=${getOpencodeCommand(userId)}, `
          + `timeout=${OPENCODE_SERVER_STARTUP_TIMEOUT_MS}ms）：${describeSdkError(startupError)}`,
        );
      }
    });

    entry.server = server;
    entry.client = createOpencodeClient({
      baseUrl: server.url,
    }) as unknown as OpenCodeHttpClient;
    console.log(`[opencode-sdk] server started at ${server.url} (pool key=${key || '(default)'})`);
  })();
  entry.starting = starting;
  serverPool.set(key, entry);
  try {
    await starting;
  } catch (error) {
    if (serverPool.get(key) === entry) {
      closeSdkServerEntry(entry);
      serverPool.delete(key);
    }
    throw error;
  } finally {
    entry.starting = null;
  }
  return { client: entry.client!, url: entry.server!.url };
}

function parseProviderModel(modelId: string | undefined): { model: { providerID: string; modelID: string }; variant?: string } | null {
  const raw = String(modelId || '').trim();
  if (!raw || !raw.includes('/')) return null;
  const segments = raw.split('/').filter(Boolean);
  const [providerID, ...rest] = segments;
  const knownVariants = new Set(['minimal', 'low', 'medium', 'high', 'max']);
  const maybeVariant = rest.length > 1 ? rest[rest.length - 1] : undefined;
  const variant = maybeVariant && knownVariants.has(maybeVariant) ? maybeVariant : undefined;
  const modelSegments = variant ? rest.slice(0, -1) : rest;
  const modelID = modelSegments.join('/');
  if (!providerID || !modelID) return null;
  return { model: { providerID, modelID }, ...(variant ? { variant } : {}) };
}

export async function discoverOpenCodeSdkModels(): Promise<OpenCodeDiscoveredModel[]> {
  const { client } = await ensureServer();
  return discoverOpenCodeModelsFromHttpClient(client);
}

export async function discoverOpenCodeSdkCommands(userId?: string, workingDirectory?: string): Promise<OpenCodeDiscoveredCommand[]> {
  const { client } = await ensureServer(userId);
  return mergeOpenCodeCommandsWithFileFallback(
    await discoverOpenCodeCommandsFromHttpClient(client),
    { workingDirectory, userId },
  );
}

export class OpenCodeSdkEngineWrapper extends EventEmitter implements Engine {
  private currentSessionId: string | null = null;
  private collectedOutput = '';
  private streamedTranscript = '';
  private abortController: AbortController | null = null;
  private diagnosticLoggingEnabled = false;

  private emitDiagnosticLog(input: {
    message: string;
    detail?: string;
    level?: 'info' | 'warning' | 'error';
    metadata?: unknown;
    verbose?: boolean;
  }): void {
    if (!this.diagnosticLoggingEnabled) return;
    const { message, detail, level, metadata, verbose } = input;
    this.emit('stream', {
      type: 'log',
      content: message,
      metadata: {
        ...(detail ? { detail } : {}),
        ...(level ? { level } : {}),
        ...(metadata !== undefined ? { payload: metadata } : {}),
        ...(verbose !== undefined ? { verbose } : {}),
      },
    } as EngineStreamEvent);
  }

  getName(): string {
    return 'opencode-sdk';
  }

  async isAvailable(): Promise<boolean> {
    return serverPool.size > 0 || !!findCommand('opencode', getConfiguredCliSearchPaths(getCommonCliSearchPaths()));
  }

  async execute(options: EngineOptions): Promise<EngineResult> {
    const startTime = Date.now();
    activeExecutions += 1;
    this.collectedOutput = '';
    this.streamedTranscript = '';
    this.abortController = new AbortController();
    this.diagnosticLoggingEnabled = Boolean(options.diagnosticLogging);
    this.emitDiagnosticLog({
      message: 'OpenCode SDK execute start',
      detail: `sessionId=${options.sessionId || '<new>'}, model=${options.model || '<default>'}`,
      metadata: {
        workingDirectory: options.workingDirectory,
        timeoutMs: options.timeoutMs,
      },
      verbose: true,
    });

    try {
      const stepTimingExecStart = Date.now();
      const stepTimingTag = options.step || '-';
      const stepTimingMark = (point: string) =>
        console.log(`[StepTiming] exec ${point} ts=${Date.now()} step=${stepTimingTag} +${Date.now() - stepTimingExecStart}ms`);
      this.emitDiagnosticLog({
        message: 'Ensuring OpenCode SDK server/client',
        detail: options.workingDirectory,
        verbose: true,
      });
      const { client, url } = await ensureServer(options.userId);
      stepTimingMark('server-ready');
      this.emitDiagnosticLog({
        message: 'OpenCode SDK server ready',
        detail: url,
        verbose: true,
      });
      await ensureOpenCodeCompatibleMcpServers(client as any, options.workingDirectory, options.mcpServers as any);
      stepTimingMark('mcp-ensured');

      let resolvedModelId = String(options.model || '').trim();
      if (resolvedModelId && !resolvedModelId.includes('/')) {
        const availableModels = await discoverOpenCodeModelsFromHttpClient(client);
        resolvedModelId = resolveOpenCodeModelId(resolvedModelId, availableModels) || resolvedModelId;
        this.emitDiagnosticLog({
          message: 'OpenCode SDK resolved model',
          detail: `${options.model} -> ${resolvedModelId}`,
          metadata: { availableModelCount: availableModels.length },
          verbose: true,
        });
      }
      const model = parseProviderModel(resolvedModelId);
      const nativeAgentName = String(options.agent || '').trim()
        ? await registerOpenCodeNativeAgent({
          client,
          agent: options.agent,
          systemPrompt: options.systemPrompt,
          model: resolvedModelId || options.model,
          workingDirectory: options.workingDirectory,
          userId: options.userId,
        })
        : '';
      stepTimingMark('agent-registered');
      await registerOpenCodeVisionInspector({
        client,
        workingDirectory: options.workingDirectory,
        userId: options.userId,
      }).catch((error) => {
        this.emitDiagnosticLog({
          message: 'OpenCode vision inspector registration skipped',
          detail: error instanceof Error ? error.message : String(error),
          verbose: true,
        });
      });
      stepTimingMark('vision-registered');
      const sessionQuery = options.workingDirectory ? { directory: options.workingDirectory } : undefined;

      // Create or resume a session bound to the OpenCode native agent.
      if (options.sessionId) {
        this.currentSessionId = options.sessionId;
        console.log(`[opencode-sdk] resuming session: ${this.currentSessionId}`);
        console.log(`[StepTiming] session-created ts=${Date.now()} step=${options.step || '-'} agent=${options.agent || '-'} sessionId=${this.currentSessionId} resumed=yes`);
        this.emitDiagnosticLog({
          message: 'Resuming OpenCode session',
          detail: this.currentSessionId,
          verbose: true,
        });
      } else {
        this.currentSessionId = null;
        console.log('[opencode-sdk] creating new session...');
        this.emitDiagnosticLog({
          message: 'Creating OpenCode native agent session',
          detail: nativeAgentName || options.workingDirectory,
          verbose: true,
        });
        const sessionResult = await client.session.create({
          body: {
            ...(nativeAgentName ? { agent: nativeAgentName, title: `${nativeAgentName} / ${options.step}` } : {}),
            ...(model ? { model: { id: model.model.modelID, providerID: model.model.providerID, ...(model.variant ? { variant: model.variant } : {}) } } : {}),
          },
          query: sessionQuery,
        });
        if (sessionResult.error) {
          // F07：展开错误字段（状态码/错误码/响应体），不再出现空 {} 消息
          throw new Error(`Failed to create session: ${describeSdkError(sessionResult.error)}`);
        }
        this.currentSessionId = getSessionId(sessionResult.data);
        console.log(`[opencode-sdk] session created: ${this.currentSessionId}${nativeAgentName ? `, agent=${nativeAgentName}` : ''}`);
        console.log(`[StepTiming] session-created ts=${Date.now()} step=${options.step || '-'} agent=${options.agent || '-'} sessionId=${this.currentSessionId} resumed=no`);
        this.emitDiagnosticLog({
          message: 'OpenCode session created',
          detail: this.currentSessionId || '',
          metadata: nativeAgentName ? { agent: nativeAgentName } : undefined,
          verbose: true,
        });
      }

      if (!this.currentSessionId) {
        throw new Error('[opencode-sdk] no session ID');
      }
      this.emit('stream', {
        type: 'session',
        content: this.currentSessionId,
      } as EngineStreamEvent);

      const isSlashCommand = Boolean(options.rawPrompt) && isOpenCodeSlashCommandPrompt(options.prompt);

      if (isSlashCommand) {
        const parsedCommand = parseOpenCodeSlashCommand(options.prompt);
        if (!parsedCommand) {
          throw new Error('Invalid OpenCode slash command');
        }
        const commands = await mergeOpenCodeCommandsWithFileFallback(
          await discoverOpenCodeCommandsFromHttpClient(client),
          { workingDirectory: options.workingDirectory, userId: options.userId },
        );
        const commandExists = commands.some((command) => command.name.toLowerCase() === parsedCommand.command.toLowerCase());
        if (!commandExists) {
          throw new Error(`OpenCode command not found: ${parsedCommand.command}`);
        }
        this.emitDiagnosticLog({
          message: 'OpenCode SDK command start',
          detail: `/${parsedCommand.command}`,
          verbose: true,
        });
        const output = await executeCommandWithOpenCodeHttp({
          client,
          sessionId: this.currentSessionId,
          command: {
            command: parsedCommand.command,
            arguments: parsedCommand.arguments,
            model: resolvedModelId || options.model,
            ...(nativeAgentName ? { agent: nativeAgentName } : {}),
          },
          workingDirectory: options.workingDirectory,
          emit: (event) => {
            if (event.type === 'text' && typeof event.content === 'string') {
              this.streamedTranscript += event.content;
            }
            this.emit('stream', event);
          },
          ...(this.diagnosticLoggingEnabled ? { log: (entry) => this.emitDiagnosticLog(entry) } : {}),
        });
        this.collectedOutput = this.streamedTranscript || output;
        const durationMs = Date.now() - startTime;
        return {
          success: true,
          output: normalizeEngineOutput(this.collectedOutput || output),
          sessionId: this.currentSessionId,
          metadata: {
            ...ZERO_USAGE_METADATA,
            duration_ms: durationMs,
          },
        };
      }

      const fullPrompt = isSlashCommand
        ? buildOpenCodeRawCommandPrompt(options.prompt)
        : buildOpenCodeExecutePrompt(options);
      if (isSlashCommand) {
        this.emitDiagnosticLog({
          message: 'OpenCode SDK raw slash command prompt fallback',
          detail: fullPrompt.split(/\r?\n/, 1)[0] || '',
          verbose: true,
        });
      }

      console.log(`[StepTiming] prompt-sent ts=${Date.now()} step=${options.step || '-'} agent=${options.agent || '-'} sessionId=${this.currentSessionId} promptLen=${fullPrompt.length}`);
      console.log(`[opencode-sdk] sendPrompt: sessionId=${this.currentSessionId}, promptLength=${fullPrompt.length}`);
      this.emitDiagnosticLog({
        message: 'OpenCode SDK prompt start',
        detail: `sessionId=${this.currentSessionId}, promptLength=${fullPrompt.length}`,
        verbose: true,
      });
      const output = await sendPromptWithOpenCodeHttp({
        engineName: 'opencode-sdk',
        client,
        sessionId: this.currentSessionId,
        fullPrompt,
        eventBaseUrl: url,
        promptBodyExtras: {
          ...(model ? { model: model.model } : {}),
          ...(model?.variant ? { variant: model.variant } : {}),
          ...(nativeAgentName ? { agent: nativeAgentName } : {}),
        },
        workingDirectory: options.workingDirectory,
        timeoutMs: options.timeoutMs,
        signal: this.abortController.signal,
        permissionResponse: 'always',
        emit: (event) => {
          if (event.type === 'text' && typeof event.content === 'string') {
            this.streamedTranscript += event.content;
          }
          this.emit('stream', event);
        },
        ...(this.diagnosticLoggingEnabled ? { log: (entry) => this.emitDiagnosticLog(entry) } : {}),
      });
      this.collectedOutput = this.streamedTranscript || output;

      const durationMs = Date.now() - startTime;
      console.log(`[opencode-sdk] prompt completed: sessionId=${this.currentSessionId}, outputLength=${output.length}, duration=${durationMs}ms`);
      this.emitDiagnosticLog({
        message: 'OpenCode SDK execute done',
        detail: `outputLength=${output.length}, duration=${durationMs}ms`,
        metadata: {
          sessionId: this.currentSessionId,
        },
        verbose: true,
      });
      return {
        success: true,
        output: normalizeEngineOutput(this.collectedOutput || output),
        sessionId: this.currentSessionId,
        metadata: {
          ...ZERO_USAGE_METADATA,
          duration_ms: durationMs,
        },
      };
    } catch (error: any) {
      const errorMessage = error?.message || 'OpenCode SDK error';
      const normalizedOutput = normalizeEngineOutput(this.collectedOutput || this.streamedTranscript || '');
      if (normalizedOutput && isIgnorableOpenCodeSdkTailError(errorMessage)) {
        this.emitDiagnosticLog({
          level: 'warning',
          message: 'OpenCode SDK ignored tail transport error after final output',
          detail: errorMessage,
          metadata: {
            outputLength: normalizedOutput.length,
            sessionId: this.currentSessionId,
          },
        });
        return {
          success: true,
          output: normalizedOutput,
          sessionId: this.currentSessionId || undefined,
          metadata: ZERO_USAGE_METADATA,
        };
      }
      this.emitDiagnosticLog({
        level: 'error',
        message: 'OpenCode SDK execute failed',
        detail: errorMessage,
      });
      this.emit('stream', { type: 'error', content: errorMessage } as EngineStreamEvent);
      return {
        success: false,
        output: normalizedOutput,
        error: errorMessage,
        sessionId: this.currentSessionId || undefined,
        metadata: ZERO_USAGE_METADATA,
      };
    } finally {
      activeExecutions = Math.max(0, activeExecutions - 1);
      this.abortController = null;
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  cleanup(): void {
    this.cancel();
    // 不再回收共享 serve：per-user 池 + 2h 闲置清理自行管理生命周期。
    // 旧实现在 activeExecutions===0 时杀 serve → 下一次 execute 冷启动（派发空转根因之一）。
  }

  /** Clean up all pooled servers (call on app shutdown) */
  static shutdown(): void {
    for (const [key, entry] of serverPool) {
      closeSdkServerEntry(entry);
    }
    serverPool.clear();
  }
}
