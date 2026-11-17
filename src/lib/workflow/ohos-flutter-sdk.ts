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
  /** sdkRoot 指向 run 的 SDK 副本时，这里记共享 SDK 路径，用来重建被清理的副本。 */
  sourceSdkRoot?: string;
  /** 精确版本对齐元数据：Issue 声明的小版本 tag 与对齐结果。 */
  versionAlign?: {
    /** 显式 tag；只有时间/commit 对齐时为 null。 */
    targetTag: string | null;
    targetCommit: string | null;
    source?: 'precise_tag' | 'collector_commit' | 'issue_created_at';
    issueCreatedAt?: string | null;
    /** 派生 worktree 的共享仓库；run 清理后只能据此按固定 commit 恢复。 */
    repositoryRoot?: string | null;
    /** 未声明精确版本的 freeform 可保持 HEAD；Issue 存在时必须有完整历史证据。 */
    historyRequired?: boolean;
    aligned: boolean;
    precacheOk: boolean;
    artifactVerified?: boolean;
    expectedEngine?: string | null;
    expectedOhosEngine?: string | null;
    actualEngine?: string | null;
    actualOhosEngine?: string | null;
    /** 对齐副本（worktree）根目录；overlay 基于此副本建立。 */
    alignedSdkRoot: string | null;
    reason: string;
  };
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
  const candidate = (value: unknown): string | null => {
    const branch = String(value || '').trim();
    return branch && branch !== 'missing' && !/^[A-Z]\d*$/.test(branch) ? branch : null;
  };
  const json = String(text || '').match(/"branch"\s*:\s*"([^"]+)"/);
  const jsonBranch = candidate(json?.[1]);
  if (jsonBranch) return jsonBranch;
  // 只接受采集结论自己的行，不能从整段工具日志里的「分支 B」（ArkUI 覆盖变体）猜 Git 分支。
  const line = String(text || '').match(/(?:^|\n)\s*[-*]?\s*\**(?:(?:repo[/ ])?(?:仓库)?分支|branch)\**\s*[:：]\s*`?([^\s`，;；]+)`?/i);
  const lineBranch = candidate(line?.[1]);
  if (lineBranch) return lineBranch;
  // 中文散文格式（step-conclusion 常见）：「- 分支 dev(branch_source=…)」「分支：oh-3.41.9-dev」
  const zh = String(text || '').match(/(?:^|\n)\s*[-*]?\s*\**分支\**\s+`?([A-Za-z0-9][A-Za-z0-9_.\/-]*)`?(?=\s*(?:[（(]branch_source|[，;；]|$))/);
  return candidate(zh?.[1]);
}

/** 从步骤输出/全局上下文提取 PR 的 base 分支（如 oh-3.35.7-dev）。
 *  feature 分支名往往不含版本号（如 pixelmapPurgeableFinal），SDK 对号入座要靠 base 兜底。 */
export function extractBaseBranch(text: string): string | null {
  const json = String(text || '').match(/"base_ref"\s*:\s*"([^"]+)"/);
  if (json?.[1] && json[1] !== 'missing') return json[1].trim();
  const line = String(text || '').match(/(?:^|\n)\s*[-*]?\s*\**base_ref\**\s*[:：]\s*`?([^\s`,]+)`?/i);
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
  fallbackBranch?: string | null;
  inventory?: OhosFlutterSdkInventory;
  configPath?: string;
}): ResolvedOhosFlutterSdk {
  const inventory = input.inventory || loadOhosFlutterSdkInventory(input.configPath);
  const branch = input.branch?.trim() || null;
  const fallbackBranch = input.fallbackBranch?.trim() || null;
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
    // 克隆完成前没有分支是正常的。真正对不上时才告警，不要在信息采集一开始就报 matched=false。
    return empty('等待仓库分支后再对号入座');
  }
  if (usable.length === 0) {
    return empty('清单里没有装好的 OHOS Flutter SDK（需要 bin/flutter + bin/cache 引擎产物）');
  }

  // feature 分支名可能不含版本号（pixelmapPurgeableFinal）：主分支对不上时用 base 分支（oh-3.35.7-dev）兜底
  const candidates = branch === fallbackBranch ? [branch] : [branch, fallbackBranch].filter(Boolean) as string[];
  let winner: { entry: OhosFlutterSdkEntry; score: number; branch: string; viaFallback: boolean } | null = null;
  for (const [index, candidate] of candidates.entries()) {
    const candidateHint = extractVersionHint(candidate);
    const candidateNorm = normalize(candidate);
    const scored = usable.map((entry) => {
      const aliases = [entry.id, entry.version, ...(entry.aliases || [])].map(normalize);
      let score = 0;
      if (aliases.includes(candidateNorm)) score = 100;
      else if (candidateHint && aliases.includes(normalize(candidateHint))) score = 80;
      else if (candidateHint && aliases.some((alias) => alias.includes(normalize(candidateHint)))) score = 60;
      else if (candidateHint && normalize(entry.path).includes(normalize(candidateHint))) score = 40;
      return { entry, score };
    }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score);

    if (scored[0]) {
      winner = { ...scored[0], branch: candidate, viaFallback: index > 0 };
      break;
    }
  }

  if (!winner) {
    return empty(`没有与 ${branch} 对应的 SDK。已登记可用：${inventoryIds.join(', ') || '无'}。禁止改用日常 SDK。`);
  }

  const sdkRoot = resolve(winner.entry.path);
  return {
    matched: true,
    branch: winner.branch,
    versionHint,
    sdkId: winner.entry.id,
    sdkRoot,
    flutterBin: flutterExecutable(sdkRoot),
    dailySdk,
    inventory: inventoryIds,
    reason: winner.viaFallback
      ? `按 base 分支 ${winner.branch} 选中 ${winner.entry.id}（feature 分支 ${branch} 不含版本号）`
      : `按 ${winner.branch} 选中 ${winner.entry.id}`,
  };
}

/** 仓库还没克隆出分支时的空结果，不是最终对不上。 */
export function isPendingOhosFlutterSdkMatch(resolved: ResolvedOhosFlutterSdk | null | undefined): boolean {
  if (!resolved || resolved.matched) return false;
  return !resolved.branch;
}

/** 还没有分支或 base 时，不要写入 matched=false 的 pin，也不要告警。 */
export function shouldDeferOhosFlutterSdkPin(input: {
  branch?: string | null;
  fallbackBranch?: string | null;
}): boolean {
  return !String(input.branch || '').trim() && !String(input.fallbackBranch || '').trim();
}

export function buildOhosFlutterSdkPrompt(resolved: ResolvedOhosFlutterSdk): string {
  const pending = isPendingOhosFlutterSdkMatch(resolved);
  const lines = [
    '# OHOS Flutter SDK（按 repo 分支对号入座）',
    `分支: ${resolved.branch || '未提供'}`,
    `对上: ${resolved.matched ? 'yes' : pending ? 'pending' : 'no'}`,
    `选用: ${resolved.flutterBin || '无'}`,
    `日常 SDK: ${resolved.dailySdk || '未配置'}（禁止在对不上时使用或改写其 cache HAR）`,
    `已登记可用: ${resolved.inventory.join(', ') || '无'}`,
    `Framework 基线: ${resolved.versionAlign?.targetCommit || '未按 Issue 历史对齐'}`,
    `说明: ${resolved.reason}`,
    '编 hap / 换 HAR / 装真机必须用「选用」里的 flutter，不要用 PATH 里的社区 flutter，也不要把 repo/ 当 SDK。',
    'HAR 优先盖进本 run 的 sdk_overlay/har-cache（见 outputs/diagnosis-preflight.json 的 sdk_overlay）；禁止盖日常 SDK 的 flutter_embedding_*.har；必须临时盖入选用 SDK cache 时用完立即还原备份（收尾会比对共享指纹）。',
  ];
  // 历史 tag/commit 对齐结果透出，不能用当前 HEAD 的复现结果代替 Issue 版本。
  const align = resolved.versionAlign;
  if (align) {
    const target = align.targetTag || align.targetCommit;
    if (align.aligned && align.artifactVerified) {
      lines.push(`${align.targetTag ? '精确版本对齐' : '历史版本对齐'}: 已派生 ${target} 独立 SDK 副本，并完成引擎版本戳与 OHOS 产物校验（${align.expectedOhosEngine || '无版本记录'}）。允许在该副本实际复现，不要因小版本不同而标 theoretical。`);
    } else if (align.aligned) {
      lines.push(`历史版本对齐: 源码已到 ${target}，但引擎未对齐（${align.reason}）。precache 未成功或版本戳校验失败，需如实标注；禁止运行复现宣称通过，engine_aligned=false，最高 conditional_pass。`);
    } else {
      lines.push(`历史版本对齐失败: ${target || '未解析到目标'}（${align.reason}）。不得使用共享 SDK 当前 HEAD 冒充 Issue 版本，最高 conditional_pass。`);
    }
  } else if (resolved.matched && !/freeform|自由文本|没有 Issue/.test(resolved.reason)) {
    lines.push('尚未执行 Issue 历史版本对齐。必须先读取 pin 的 versionAlign；禁止把共享 SDK 当前 HEAD 当成 Issue 创建时版本。');
  }
  if (pending) {
    lines.push('仓库分支尚未确定。先完成信息采集与克隆；拿到分支后再对号入座。现在不要下引擎未对齐结论。');
  } else if (!resolved.matched) {
    lines.push('engine_aligned=false。可以出 patch，禁止 issue_resolved=yes / bug_fixed=true / verdict=pass。');
  }
  return lines.join('\n');
}
