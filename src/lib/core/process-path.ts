import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PLACEHOLDER = /^(not_defined|undefined|null|none)$/i;

export function isPathEnvKey(key: string): boolean {
  return key === 'PATH' || key === 'Path';
}

export function isPlaceholderSecret(key: string, value: string): boolean {
  return /^GITCODE_TOKEN/i.test(key) && PLACEHOLDER.test(value.trim());
}

function splitPath(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (!value) return [];
  const sep = platform === 'win32' ? ';' : ':';
  return value.split(sep).map((entry) => entry.trim()).filter(Boolean);
}

function expandWindowsEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (_, name: string) => env[name] || env[name.toUpperCase()] || `%${name}%`);
}

/** Machine + user PATH from the registry. Cached. Empty off Windows or when reg.exe cannot be read. */
let registryCache: string | null = null;
export function readWindowsRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32') return '';
  if (registryCache !== null) return registryCache;
  registryCache = '';
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  const reg = path.win32.join(root, 'System32', 'reg.exe');
  const queries: Array<[string, string]> = [
    ['HKCU\\Environment', 'Path'],
    ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path'],
  ];
  const chunks: string[] = [];
  for (const [key, valueName] of queries) {
    try {
      const output = execFileSync(reg, ['query', key, '/v', valueName], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      const match = new RegExp(`${valueName}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`, 'i').exec(output);
      if (match?.[1]) chunks.push(expandWindowsEnv(match[1].trim(), env));
    } catch {
      // Missing key or reg.exe is not available in this process.
    }
  }
  registryCache = chunks.join(';');
  return registryCache;
}

export function resetWindowsRegistryPathCache(): void {
  registryCache = null;
}

function windowsRequiredDirs(env: NodeJS.ProcessEnv): string[] {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const win = path.win32;
  return [
    win.join(root, 'System32'),
    win.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
    root,
    win.join(programFiles, 'nodejs'),
  ];
}

/**
 * Build a PATH that can run node and, on Windows, powershell.
 * A configured PATH is prepended as extra entries. It does not replace the
 * process PATH, the node that is running ACE, or the Windows system directories.
 */
export function mergeProcessPath(input: {
  base?: string;
  configured?: string;
  registry?: string;
  platform: NodeJS.Platform;
  execPath: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const platform = input.platform;
  const env = input.env || process.env;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const sep = paths.delimiter;
  const ordered = [
    paths.dirname(input.execPath),
    ...(platform === 'win32' ? windowsRequiredDirs(env) : []),
    ...splitPath(input.configured, platform),
    ...splitPath(input.registry, platform),
    ...splitPath(input.base, platform),
  ];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of ordered) {
    const key = platform === 'win32' ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries.join(sep);
}
