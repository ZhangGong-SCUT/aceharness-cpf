import { delimiter } from 'path';
import { buildEnvObject, loadEnvVars, loadEnvVarsSync } from '@/lib/core/env-manager';
import {
  isPathEnvKey,
  isPlaceholderSecret,
  mergeProcessPath,
  readWindowsRegistryPath,
} from '@/lib/core/process-path';

type EnvInput = Record<string, string | undefined>;
type ConfiguredEnvOptions = {
  userId?: string;
};

function normalizeEnv(baseEnv: EnvInput): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env as NodeJS.ProcessEnv;
}

function applyOverrides(target: NodeJS.ProcessEnv, overrides?: EnvInput): NodeJS.ProcessEnv {
  if (!overrides) {
    return target;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || isPathEnvKey(key) || isPlaceholderSecret(key, value)) continue;
    target[key] = value;
  }
  return target;
}

export function applyConfiguredEnv(
  baseEnv: EnvInput,
  configured: Record<string, string>,
  overrides?: EnvInput,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  registryPath = '',
): NodeJS.ProcessEnv {
  const env = normalizeEnv(baseEnv);
  const sep = platform === 'win32' ? ';' : ':';
  const configuredPath = [overrides?.PATH, overrides?.Path, configured.PATH, configured.Path]
    .filter((entry): entry is string => Boolean(entry))
    .join(sep);
  for (const [key, value] of Object.entries(configured)) {
    if (isPathEnvKey(key) || isPlaceholderSecret(key, value)) continue;
    env[key] = value;
  }
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value && isPlaceholderSecret(key, value)) delete env[key];
  }
  const merged = mergeProcessPath({
    base: env.PATH || env.Path || '',
    configured: configuredPath,
    registry: registryPath,
    platform,
    execPath,
    env,
  });
  env.PATH = merged;
  if (platform === 'win32') env.Path = merged;
  env.ACE_NODE = execPath;
  return applyOverrides(env, overrides);
}

export async function loadConfiguredEnvObject(options?: ConfiguredEnvOptions): Promise<Record<string, string>> {
  try {
    return buildEnvObject(await loadEnvVars(
      options?.userId ? { scope: 'merged', userId: options.userId } : { scope: 'system' },
    ));
  } catch {
    return {};
  }
}

export function loadConfiguredEnvObjectSync(options?: ConfiguredEnvOptions): Record<string, string> {
  try {
    return buildEnvObject(loadEnvVarsSync(
      options?.userId ? { scope: 'merged', userId: options.userId } : { scope: 'system' },
    ));
  } catch {
    return {};
  }
}

export async function buildConfiguredProcessEnv(
  overrides?: EnvInput,
  baseEnv: EnvInput = process.env as EnvInput,
  options?: ConfiguredEnvOptions,
): Promise<NodeJS.ProcessEnv> {
  return applyConfiguredEnv(
    baseEnv,
    await loadConfiguredEnvObject(options),
    overrides,
    process.platform,
    process.execPath,
    readWindowsRegistryPath(),
  );
}

export function buildConfiguredProcessEnvSync(
  overrides?: EnvInput,
  baseEnv: EnvInput = process.env as EnvInput,
  options?: ConfiguredEnvOptions,
): NodeJS.ProcessEnv {
  return applyConfiguredEnv(
    baseEnv,
    loadConfiguredEnvObjectSync(options),
    overrides,
    process.platform,
    process.execPath,
    readWindowsRegistryPath(),
  );
}

export function getConfiguredEnvValueSync(key: string, options?: ConfiguredEnvOptions): string | undefined {
  const configured = loadConfiguredEnvObjectSync(options);
  const configuredValue = configured[key];
  if (typeof configuredValue === 'string' && configuredValue.length > 0) {
    return configuredValue;
  }
  const processValue = process.env[key];
  if (typeof processValue === 'string' && processValue.length > 0) {
    return processValue;
  }
  return undefined;
}

export function getConfiguredCliSearchPaths(extraPaths: string[] = [], options?: ConfiguredEnvOptions): string[] {
  const env = buildConfiguredProcessEnvSync(undefined, process.env, options);
  const pathValue = env.PATH || env.Path || '';
  const seen = new Set<string>();
  const paths = [...extraPaths, ...pathValue.split(delimiter).filter(Boolean)];
  return paths.filter((entry) => {
    if (!entry || seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });
}
