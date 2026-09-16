import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse } from 'yaml';
import { getWorkspaceConfigsDir } from '@/lib/core/app-paths';

export type OhosFlutterSdkEntry = {
  id: string;
  version: string;
  aliases?: string[];
  path: string;
};

export type OhosFlutterSdkInventory = {
  dailySdk?: string;
  sdkRoot?: string;
  sdks: OhosFlutterSdkEntry[];
};

export type ResolvedOhosFlutterSdk = {
  matched: boolean;
  branch: string | null;
  versionHint: string | null;
  sdkId: string | null;
  sdkRoot: string | null;
  flutterBin: string | null;
  dailySdk: string | null;
  inventory: string[];
  reason: string;
};

const CONFIG_NAME = 'ohos-flutter-sdks.yaml';

export function flutterExecutable(sdkRoot: string): string {
  const posix = join(sdkRoot, 'bin', 'flutter');
  if (process.platform !== 'win32' && existsSync(posix)) return posix;
  const bat = join(sdkRoot, 'bin', 'flutter.bat');
  if (existsSync(bat)) return bat;
  return posix;
}

export function isUsableOhosFlutterSdk(sdkRoot: string): boolean {
  if (!sdkRoot || !existsSync(flutterExecutable(sdkRoot))) return false;
  const engineDir = join(sdkRoot, 'bin', 'cache', 'artifacts', 'engine');
  const so = join(engineDir, 'ohos-arm64', 'libflutter.so');
  return existsSync(so) || existsSync(engineDir);
}

export const OHOS_FLUTTER_SDK_PIN_FILE = 'ohos-flutter-sdk.json';

export function extractRepoBranch(text: string): string | null {
  const json = String(text || '').match(/"branch"\s*:\s*"([^"]+)"/);
  if (json?.[1] && json[1] !== 'missing') return json[1].trim();
  const line = String(text || '').match(/(?:^|\n)\s*[-*]?\s*\**branch\**\s*[:：]\s*`?([^\s`,]+)`?/i);
  if (line?.[1] && line[1] !== 'missing') return line[1].trim();
  return null;
}

export function readRepoBranchFromDisk(repoPath: string): string | null {
  const headPath = join(repoPath, '.git', 'HEAD');
  if (!existsSync(headPath)) return null;
  try {
    const text = readFileSync(headPath, 'utf-8').trim();
    const ref = text.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref?.[1]) return ref[1].trim();
    // detached HEAD（裸 hash）：按可靠性依次兜底
    const hash = text.match(/^[0-9a-f]{40}$/i)?.[0];
    if (!hash) return null;
    // 1) origin/HEAD 的 symbolic ref（clone 时的默认分支）
    const originHeadPath = join(repoPath, '.git', 'refs', 'remotes', 'origin', 'HEAD');
    if (existsSync(originHeadPath)) {
      const originHead = readFileSync(originHeadPath, 'utf-8').trim();
      const originRef = originHead.match(/^ref:\s*refs\/remotes\/origin\/(.+)$/);
      if (originRef?.[1]) return originRef[1].trim();
    }
    // 2) packed-refs 中 hash 匹配的 refs/remotes/origin/<branch>（优先 dev/main 等主线）
    const packedRefsPath = join(repoPath, '.git', 'packed-refs');
    if (existsSync(packedRefsPath)) {
      const packed = readFileSync(packedRefsPath, 'utf-8');
      const matches = [...packed.matchAll(/^([0-9a-f]{40}) refs\/remotes\/origin\/(\S+)$/gm)]
        .filter((m) => m[1] === hash)
        .map((m) => m[2]);
      const preferred = matches.find((b) => /^(dev|master|main)$/.test(b));
      if (preferred || matches.length > 0) return preferred || matches[0];
    }
    // 3) refs/heads/ 下唯一本地分支
    const headsDir = join(repoPath, '.git', 'refs', 'heads');
    if (existsSync(headsDir)) {
      const heads = readdirSync(headsDir).filter((f) => f !== '.DS_Store');
      if (heads.length === 1) {
        const headRef = readFileSync(join(headsDir, heads[0]), 'utf-8').trim();
        if (headRef === hash) return heads[0];
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function parseOhosFlutterSdkPin(raw: string): ResolvedOhosFlutterSdk | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as ResolvedOhosFlutterSdk;
  } catch {
    return null;
  }
}

export function loadOhosFlutterSdkPinFile(filePath: string): ResolvedOhosFlutterSdk | null {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return parseOhosFlutterSdkPin(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function extractVersionHint(branch: string | null | undefined): string | null {
  const text = String(branch || '');
  const triple = text.match(/(\d+\.\d+\.\d+)/);
  if (triple?.[1]) return triple[1];
  const pair = text.match(/(\d+\.\d+)/);
  return pair?.[1] || null;
}

function normalize(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/[_/]/g, '-');
}

export function parseOhosFlutterSdkInventory(raw: string): OhosFlutterSdkInventory {
  const parsed = parse(raw) || {};
  const sdks = Array.isArray(parsed.sdks) ? parsed.sdks : [];
  return {
    dailySdk: typeof parsed.dailySdk === 'string' ? parsed.dailySdk : undefined,
    sdkRoot: typeof parsed.sdkRoot === 'string' ? parsed.sdkRoot : undefined,
    sdks: sdks
      .filter((item: any) => item && typeof item.path === 'string')
      .map((item: any) => ({
        id: String(item.id || item.version || item.path),
        version: String(item.version || ''),
        aliases: Array.isArray(item.aliases) ? item.aliases.map((alias: unknown) => String(alias)) : [],
        path: String(item.path),
      })),
  };
}

export function loadOhosFlutterSdkInventory(configPath?: string): OhosFlutterSdkInventory {
  const candidates = [
    configPath,
    process.env.ACE_OHOS_FLUTTER_SDKS,
    join(getWorkspaceConfigsDir(), CONFIG_NAME),
  ].filter(Boolean) as string[];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      return parseOhosFlutterSdkInventory(readFileSync(file, 'utf-8'));
    } catch {
      // try next
    }
  }
  return { sdks: [] };
}

function discoverSdksUnderRoot(sdkRoot: string | undefined): OhosFlutterSdkEntry[] {
  if (!sdkRoot || !existsSync(sdkRoot)) return [];
  try {
    return readdirSync(sdkRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = resolve(sdkRoot, entry.name);
        const version = extractVersionHint(entry.name) || entry.name;
        return {
          id: entry.name,
          version,
          aliases: [entry.name, version],
          path,
        };
      });
  } catch {
    return [];
  }
}

export function listInventoryEntries(inventory: OhosFlutterSdkInventory): OhosFlutterSdkEntry[] {
  const discovered = discoverSdksUnderRoot(inventory.sdkRoot);
  const byPath = new Map<string, OhosFlutterSdkEntry>();
  for (const entry of [...discovered, ...inventory.sdks]) {
    byPath.set(resolve(entry.path), entry);
  }
  return [...byPath.values()];
}

export function resolveOhosFlutterSdk(input: {
  branch?: string | null;
  inventory?: OhosFlutterSdkInventory;
  configPath?: string;
}): ResolvedOhosFlutterSdk {
  const inventory = input.inventory || loadOhosFlutterSdkInventory(input.configPath);
  const branch = input.branch?.trim() || null;
  const versionHint = extractVersionHint(branch);
  const entries = listInventoryEntries(inventory);
  const usable = entries.filter((entry) => isUsableOhosFlutterSdk(entry.path));
  const inventoryIds = usable.map((entry) => entry.id);
  const dailySdk = inventory.dailySdk ? resolve(inventory.dailySdk) : null;

  const empty = (reason: string): ResolvedOhosFlutterSdk => ({
    matched: false,
    branch,
    versionHint,
    sdkId: null,
    sdkRoot: null,
    flutterBin: null,
    dailySdk,
    inventory: inventoryIds,
    reason,
  });

  if (!branch) {
    return empty('没有 repo 分支，无法对号入座');
  }
  if (usable.length === 0) {
    return empty('清单里没有装好的 OHOS Flutter SDK（需要 bin/flutter + bin/cache 引擎产物）');
  }

  const branchNorm = normalize(branch);
  const scored = usable.map((entry) => {
    const aliases = [entry.id, entry.version, ...(entry.aliases || [])].map(normalize);
    let score = 0;
    if (aliases.includes(branchNorm)) score = 100;
    else if (versionHint && aliases.includes(normalize(versionHint))) score = 80;
    else if (versionHint && aliases.some((alias) => alias.includes(normalize(versionHint)))) score = 60;
    else if (versionHint && normalize(entry.path).includes(normalize(versionHint))) score = 40;
    return { entry, score };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score);

  const winner = scored[0];
  if (!winner) {
    return empty(`没有与 ${branch} 对应的 SDK。已登记可用：${inventoryIds.join(', ') || '无'}。禁止改用日常 SDK。`);
  }

  const sdkRoot = resolve(winner.entry.path);
  return {
    matched: true,
    branch,
    versionHint,
    sdkId: winner.entry.id,
    sdkRoot,
    flutterBin: flutterExecutable(sdkRoot),
    dailySdk,
    inventory: inventoryIds,
    reason: `按 ${branch} 选中 ${winner.entry.id}`,
  };
}

export function buildOhosFlutterSdkPrompt(resolved: ResolvedOhosFlutterSdk): string {
  const lines = [
    '# OHOS Flutter SDK（按 repo 分支对号入座）',
    `分支: ${resolved.branch || '未提供'}`,
    `对上: ${resolved.matched ? 'yes' : 'no'}`,
    `选用: ${resolved.flutterBin || '无'}`,
    `日常 SDK: ${resolved.dailySdk || '未配置'}（禁止在对不上时使用或改写其 cache HAR）`,
    `已登记可用: ${resolved.inventory.join(', ') || '无'}`,
    `说明: ${resolved.reason}`,
    '编 hap / 换 HAR / 装真机必须用「选用」里的 flutter，不要用 PATH 里的社区 flutter，也不要把 repo/ 当 SDK。',
    'HAR 只盖进选用 SDK 的 bin/cache，或本次 run 目录。禁止盖日常 SDK 的 flutter_embedding_*.har。',
  ];
  if (!resolved.matched) {
    lines.push('engine_aligned=false。可以出 patch，禁止 issue_resolved=yes / bug_fixed=true / verdict=pass。');
  }
  return lines.join('\n');
}
