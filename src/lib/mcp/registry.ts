import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { parse, stringify } from 'yaml';
import { getRepoRoot, getWorkspaceDataFile } from '@/lib/core/app-paths';
import { mcpServerSchema, type ManagedMcpServer } from '@/lib/mcp/types';

export type { ManagedMcpServer } from '@/lib/mcp/types';

export const VISION_LOOK_MCP_NAME = 'vision-look';

export function getVisionLookScriptPath(repoRoot = getRepoRoot()): string {
  return join(repoRoot, 'skills', 'cpf-ohos-issue-analysis', 'scripts', 'look-at-image.mjs');
}

export function getBuiltinMcpServers(repoRoot = getRepoRoot(), nodePath = process.execPath): ManagedMcpServer[] {
  const scriptPath = getVisionLookScriptPath(repoRoot);
  if (!existsSync(scriptPath)) return [];
  // OpenCode 子进程的 PATH 里经常没有 node。用拉起 ACE 的那个 node，避免进程起不来、连接空等 30 秒。
  const nodeBin = String(nodePath || process.execPath || 'node').trim() || 'node';
  return [{
    name: VISION_LOOK_MCP_NAME,
    type: 'stdio',
    command: `${JSON.stringify(nodeBin)} ${JSON.stringify(scriptPath)} mcp`,
  }];
}

const MCP_REGISTRY_PATH = getWorkspaceDataFile('mcp-servers.yaml');
const CACHE_TTL_MS = 5_000;

let registryCache: { value: ManagedMcpServer[]; expiresAt: number } | null = null;

function normalizeManagedMcpServer(input: unknown): ManagedMcpServer | null {
  const parsed = mcpServerSchema.safeParse(input);
  if (!parsed.success) return null;

  const name = parsed.data.name.trim();
  const command = parsed.data.command.trim();
  const envEntries = Object.entries(parsed.data.env || {})
    .filter(([key, value]) => key.trim().length > 0 && typeof value === 'string');
  const env = envEntries.length > 0
    ? Object.fromEntries(envEntries.map(([key, value]) => [key.trim(), String(value)]))
    : undefined;

  if (!name || !command) return null;

  return {
    name,
    type: 'stdio',
    command,
    ...(env ? { env } : {}),
  };
}

function uniqueServersByName(servers: ManagedMcpServer[]): ManagedMcpServer[] {
  const map = new Map<string, ManagedMcpServer>();
  for (const server of servers) {
    map.set(server.name, server);
  }
  return Array.from(map.values()).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

function readRegistryArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { servers?: unknown[] }).servers)) {
    return (raw as { servers?: unknown[] }).servers || [];
  }
  return [];
}

export function invalidateMcpRegistryCache(): void {
  registryCache = null;
}

export async function loadMcpRegistry(_baseDirectory?: string): Promise<ManagedMcpServer[]> {
  const now = Date.now();
  if (registryCache && registryCache.expiresAt > now) {
    return registryCache.value.map((server) => ({ ...server }));
  }

  let value: ManagedMcpServer[] = [];
  try {
    const content = await readFile(MCP_REGISTRY_PATH, 'utf-8');
    const parsed = parse(content);
    value = uniqueServersByName([
      ...getBuiltinMcpServers(),
      ...readRegistryArray(parsed)
        .map((server) => normalizeManagedMcpServer(server))
        .filter((server): server is ManagedMcpServer => Boolean(server)),
    ]);
  } catch {
    value = getBuiltinMcpServers();
  }

  registryCache = { value, expiresAt: now + CACHE_TTL_MS };
  return value.map((server) => ({ ...server }));
}

export async function saveMcpRegistry(servers: unknown[]): Promise<ManagedMcpServer[]> {
  const normalized = uniqueServersByName(
    servers
      .map((server) => normalizeManagedMcpServer(server))
      .filter((server): server is ManagedMcpServer => Boolean(server)),
  );

  await mkdir(dirname(MCP_REGISTRY_PATH), { recursive: true });
  await writeFile(MCP_REGISTRY_PATH, stringify({ servers: normalized }), 'utf-8');
  invalidateMcpRegistryCache();
  return normalized;
}

export function parseCommandString(command: string): string[] {
  const input = String(command || '').trim();
  if (!input) return [];

  const parts: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaping = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (quote) {
      if (char === '\\' && (input[index + 1] === quote || input[index + 1] === '\\')) {
        escaping = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '\\') {
      current += char;
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += '\\';
  if (current) parts.push(current);
  return parts;
}

export async function resolveMcpServersByNames(
  names: string[] | undefined,
  baseDirectory?: string,
): Promise<ManagedMcpServer[]> {
  const normalizedNames = Array.from(new Set(
    (names || [])
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim())
      .filter(Boolean),
  ));
  if (normalizedNames.length === 0) return [];

  const registry = await loadMcpRegistry(baseDirectory);
  const registryMap = new Map(registry.map((server) => [server.name, server]));
  return normalizedNames
    .map((name) => registryMap.get(name))
    .filter((server): server is ManagedMcpServer => Boolean(server));
}

export function mergeMcpServers(...groups: Array<ManagedMcpServer[] | undefined>): ManagedMcpServer[] {
  const merged: ManagedMcpServer[] = [];
  const seen = new Map<string, number>();

  for (const group of groups) {
    for (const server of group || []) {
      const normalized = normalizeManagedMcpServer(server);
      if (!normalized) continue;
      const existingIndex = seen.get(normalized.name);
      if (existingIndex === undefined) {
        seen.set(normalized.name, merged.length);
        merged.push(normalized);
      } else {
        merged[existingIndex] = normalized;
      }
    }
  }

  return merged;
}

export function toClaudeSdkMcpServers(servers: ManagedMcpServer[]): Record<string, {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}> {
  return Object.fromEntries(servers.flatMap((server) => {
    const [command, ...args] = parseCommandString(server.command);
    if (!command) return [];
    return [[server.name, {
      type: 'stdio' as const,
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(server.env ? { env: server.env } : {}),
    }]];
  }));
}

export function toAcpMcpServers(servers: ManagedMcpServer[]): Array<{
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}> {
  return servers.flatMap((server) => {
    const [command, ...args] = parseCommandString(server.command);
    if (!command) return [];
    return [{
      name: server.name,
      command,
      args,
      env: Object.entries(server.env || {}).map(([name, value]) => ({ name, value })),
    }];
  });
}

export function toOpenCodeMcpConfig(server: ManagedMcpServer): {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
} | null {
  const command = parseCommandString(server.command);
  if (command.length === 0) return null;
  return {
    type: 'local',
    command,
    ...(server.env ? { environment: server.env } : {}),
    enabled: true,
  };
}

export function toCodexMcpServers(servers: ManagedMcpServer[]): Record<string, {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: true;
}> {
  return Object.fromEntries(servers.flatMap((server) => {
    const [command, ...args] = parseCommandString(server.command);
    if (!command) return [];
    return [[server.name, {
      type: 'stdio' as const,
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(server.env ? { env: server.env } : {}),
      enabled: true as const,
    }]];
  }));
}

/**
 * 每个 serve client 实例只对同名 MCP 服务器做一次 add/connect。
 * 背景：opencode serve 的 mcp.connect 固定耗时 ~30s（失败时也是 30s 超时），
 * 旧逻辑每次引擎 execute 都重连 → 每步白烧 30~60s（mcp-ensured 打点实证）。
 * serve 重启后 client 是新对象，会自然重试一次。
 */
const mcpConnectAttemptsByClient = new WeakMap<object, Map<string, number>>();

/** 同一 serve 客户端最多连两次。第一次失败后，实例重建或状态仍是 failed 时再试一次，避免每步空等 30 秒。 */
export function allowMcpConnectAttempt(client: object, serverName: string, status?: string): boolean {
  if (status === 'connected') return false;
  let attempts = mcpConnectAttemptsByClient.get(client);
  if (!attempts) {
    attempts = new Map<string, number>();
    mcpConnectAttemptsByClient.set(client, attempts);
  }
  const used = attempts.get(serverName) || 0;
  if (used >= 2) return false;
  attempts.set(serverName, used + 1);
  return true;
}

/**
 * 将 SDK 错误转成可持久化/展示的文本。
 * SDK 的 error 常是自定义对象，JSON.stringify 后只剩 {}；必须显式取 message/code。
 */
export function describeMcpError(value: unknown): string {
  if (typeof value === 'string') return value.trim() || '未知错误';
  if (value instanceof Error) return value.message || value.name;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const data = record.data && typeof record.data === 'object'
      ? record.data as Record<string, unknown>
      : record;
    const message = [data.message, record.message].find((item) => typeof item === 'string' && item.trim());
    if (typeof message === 'string') return message.trim();
    const code = data.code ?? record.code;
    const serialized = (() => {
      try { return JSON.stringify(value); } catch { return ''; }
    })();
    if (serialized && serialized !== '{}') return serialized;
    return typeof code === 'string' || typeof code === 'number' ? `MCP 错误（code=${code}）` : '未知 MCP 错误（空错误对象）';
  }
  return String(value ?? '未知 MCP 错误');
}

async function readMcpStatusWithRetry(client: any, query: Record<string, string>): Promise<any> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await client.mcp.status({ query });
      if (response?.error) {
        lastError = response.error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        continue;
      }
      return (response?.data ?? {}) as Record<string, any>;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw new Error(`读取 MCP 状态失败: ${describeMcpError(lastError)}`);
}

export async function ensureOpenCodeCompatibleMcpServers(
  client: any,
  workingDirectory: string | undefined,
  servers: ManagedMcpServer[] | undefined,
): Promise<void> {
  if (!client?.mcp || !workingDirectory || !servers || servers.length === 0) return;

  const query = { directory: workingDirectory };
  // 状态接口瞬时失败不能直接终止整个 Issue：同一 server 重试两次，并保留结构化错误。
  const statusMap = await readMcpStatusWithRetry(client, query);

  for (const server of servers) {
    const status = statusMap[server.name]?.status;
    if (!allowMcpConnectAttempt(client, server.name, status)) continue;

    if (!statusMap[server.name]) {
      const config = toOpenCodeMcpConfig(server);
      if (!config) continue;
      const addResponse = await client.mcp.add({
        query,
        body: {
          name: server.name,
          config,
        },
      });
      if (addResponse?.error) {
        throw new Error(`添加 MCP "${server.name}" 失败: ${describeMcpError(addResponse.error)}`);
      }
    }

    const connectResponse = await client.mcp.connect({
      query,
      path: { name: server.name },
    });
    if (connectResponse?.error) {
      throw new Error(`连接 MCP "${server.name}" 失败: ${describeMcpError(connectResponse.error)}`);
    }
  }
}
