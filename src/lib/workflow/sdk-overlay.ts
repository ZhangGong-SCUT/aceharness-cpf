/**
 * Per-run SDK snapshot. Everything Flutter or an agent may write is an independent copy;
 * only `.git` and `engine/` link back to the shared SDK, read-only by contract.
 */
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statfsSync, symlinkSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const execFileAsync = promisify(execFile);

export interface SdkOverlayResult {
  overlayDir: string;
  flutterBin: string | null;
  sdkLink: string;
  writableDirs: string[];
  entries: number;
}

export interface SdkOverlayOptions {
  /** 剩余空间下限（字节），默认 ACE_SDK_OVERLAY_MIN_FREE_GB 或 5 GiB。 */
  minFreeBytes?: number;
  freeBytes?: (path: string) => number | null;
  /** macOS 上用 `cp -c` 克隆（APFS 写时复制）。 */
  clone?: boolean;
  platform?: NodeJS.Platform;
  link?: typeof symlinkSync;
}

const OVERLAY_VERSION = 3;
const READABLE_VERSIONS = new Set([2, OVERLAY_VERSION]);
const WRITABLE_SUBDIRS = ['.'];
/** 体积大且 flutter build 只读的目录。3.35.8 的 engine/ 带源码和产物，单份 61G。 */
const SHARED_LINKED_ENTRIES = ['.git', 'engine'];

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}
const inside = (root: string, path: string) => {
  const rootPath = canonical(root);
  const candidate = canonical(path);
  return candidate === rootPath || candidate.startsWith(rootPath + sep);
};
/** 挂在 SDK 树上、给 Agent 看的 skill，不是 Flutter 自己的文件。链接经常指到 SDK 外面。 */
const AGENT_SKILL_DIRS = new Set(['.agent-skills', '.agents']);

function isAgentSkillAttachment(root: string, source: string): boolean {
  const rel = relative(root, source);
  if (!rel || rel.startsWith('..') || rel === '') return false;
  return rel.split(sep).some((part) => AGENT_SKILL_DIRS.has(part));
}

/** 本机 Xcode 里的 iOS/macOS SDK。鸿蒙诊断用不到，也不能复制进独立副本。 */
function isHostXcodeSdk(target: string): boolean {
  return target.split(sep).includes('Xcode.app');
}

/** 符号链接建不成时，把目标复制成实体文件，避免 Windows 无链接权限时整棵 SDK 副本失败。 */
export function preserveSnapshotLink(
  destination: string,
  linkText: string,
  fallbackSource?: string,
  link: typeof symlinkSync = symlinkSync,
): void {
  try {
    link(linkText, destination);
  } catch (error) {
    if (!fallbackSource || !existsSync(fallbackSource)) throw error;
    cpSync(fallbackSource, destination, { recursive: true, dereference: true });
  }
}

/** Windows 用 junction，不需要管理员或开发者模式。 */
export function linkSharedDir(
  target: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
  link: typeof symlinkSync = symlinkSync,
): 'link' | 'copy' {
  try {
    link(target, destination, platform === 'win32' ? 'junction' : 'dir');
    return 'link';
  } catch (error) {
    if (!existsSync(target)) throw error;
    cpSync(target, destination, { recursive: true, dereference: true });
    return 'copy';
  }
}

/** 包管理器缓存目录（ohpm/npm）。其中的符号链接指向缓存或临时工作区，是构建产物，不应进 SDK 副本。 */
const PACKAGE_CACHE_DIRS = new Set(['oh_modules', '.ohpm', 'node_modules']);
function isPackageCacheLink(rel: string): boolean {
  if (!rel || rel.startsWith('..')) return false;
  return rel.split(sep).some((part) => PACKAGE_CACHE_DIRS.has(part));
}

function copyLink(root: string, source: string, destination: string, finalRoot: string): number {
  const rel = relative(root, source);
  let target: string;
  try {
    target = realpathSync(source);
  } catch {
    if (basename(source) === 'AGENTS.md') return 0;
    // 目标缺失时 realpath 会失败。相对路径仍落在 SDK 内的断链是 SDK 自己的文件，按原链接保留。
    const link = readlinkSync(source);
    if (!isAbsolute(link) && inside(root, resolve(dirname(source), link))) {
      preserveSnapshotLink(destination, link);
      return 1;
    }
    // P9：越界且目标已失效的断链，仅当位于包缓存路径（oh_modules/.ohpm/node_modules）内才跳过——
    // 如 ohpm 写进 SDK 树、指向已清理工作区的 @ohos/flutter_ohos，对 SDK 功能无价值。
    // 其他位置（如 bin/ 下指向根目录外的断链）仍视为非法越界，抛错以保护边界。
    if (isPackageCacheLink(rel)) return 0;
    throw new Error(`SDK 链接越出根目录: ${rel}`);
  }
  if (!inside(root, target)) {
    // AGENTS.md 是挂在 SDK 树上的 Harness 说明。Xcode 预编译 SDK 只服务 iOS/macOS 引擎。
    if (basename(source) === 'AGENTS.md' || isHostXcodeSdk(target)) return 0;
    // P9：包缓存路径内、目标虽存在但越界的链接（指向共享缓存/临时工作区），属构建产物，跳过。
    if (isPackageCacheLink(rel)) return 0;
    throw new Error(`SDK 链接越出根目录: ${rel}`);
  }
  // Resolve links to a corresponding path in the new snapshot, including absolute links.
  const finalDestination = join(finalRoot, rel);
  preserveSnapshotLink(destination, relative(dirname(finalDestination), join(finalRoot, relative(root, target))), target);
  return 1;
}

function copyTree(root: string, source: string, destination: string, finalRoot: string): number {
  if (isAgentSkillAttachment(root, source)) return 0;
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) return copyLink(root, source, destination, finalRoot);
  if (stat.isDirectory()) {
    mkdirSync(destination, { mode: stat.mode });
    return readdirSync(source).reduce((count, name) =>
      count + copyTree(root, join(source, name), join(destination, name), finalRoot), 0);
  }
  if (!stat.isFile()) throw new Error(`SDK 包含不支持的文件类型: ${relative(root, source)}`);
  // Reflink where supported, independent copy otherwise; never hard links.
  copyFileSync(source, destination, constants.COPYFILE_FICLONE);
  return 1;
}

/** `cp -R` 把链接原样搬过来；按 copyTree 的规则重写或丢弃，并去掉 Agent 挂载。 */
function repairClonedTree(root: string, source: string, destination: string, finalRoot: string): number {
  const stat = lstatSync(destination);
  if (stat.isSymbolicLink()) {
    unlinkSync(destination);
    return copyLink(root, source, destination, finalRoot);
  }
  if (!stat.isDirectory()) return 1;
  let count = 0;
  for (const name of readdirSync(destination)) {
    const child = join(destination, name);
    if (AGENT_SKILL_DIRS.has(name)) { rmSync(child, { recursive: true, force: true }); continue; }
    count += repairClonedTree(root, join(source, name), child, finalRoot);
  }
  return count;
}

function treeBytes(path: string): number {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + treeBytes(join(path, name)), 0);
}

export function freeDiskBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch { return null; }
}

function defaultMinFreeBytes(): number {
  const gb = Number(process.env.ACE_SDK_OVERLAY_MIN_FREE_GB);
  return (Number.isFinite(gb) && gb >= 0 ? gb : 5) * 1024 ** 3;
}

function ensureFreeSpace(path: string, copyBytes: number, options: SdkOverlayOptions): void {
  const free = (options.freeBytes || freeDiskBytes)(path);
  if (free == null) return;
  const needed = copyBytes + (options.minFreeBytes ?? defaultMinFreeBytes());
  if (free < needed) {
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    throw new Error(`磁盘剩余 ${gb(free)}G，建 SDK 副本需要 ${gb(needed)}G（复制 ${gb(copyBytes)}G + 保留余量）。请先清理已结束 run 的 sdk-overlay`);
  }
}

export function createSdkOverlay(sdkRoot: string, overlayDir: string, options: SdkOverlayOptions = {}): SdkOverlayResult {
  if (!existsSync(sdkRoot)) throw new Error(`SDK 根目录不存在: ${sdkRoot}`);
  const root = realpathSync(sdkRoot);
  overlayDir = resolve(overlayDir);
  if (inside(root, overlayDir)) throw new Error('SDK 副本目录不能位于共享 SDK 内');
  const manifestPath = join(overlayDir, 'overlay-manifest.json');
  const sdkLink = join(overlayDir, 'sdk');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!READABLE_VERSIONS.has(manifest.version) || manifest.sdkRoot !== root || !existsSync(sdkLink)
      || lstatSync(sdkLink).isSymbolicLink()) {
      throw new Error('已有 SDK 隔离目录不兼容或不完整，请创建新 run；禁止退回共享 SDK');
    }
    const flutterBin = overlayFlutterBinForRun(overlayDir);
    if (!flutterBin) throw new Error('SDK 副本缺少独立 Flutter 入口');
    return { overlayDir, sdkLink, flutterBin, writableDirs: WRITABLE_SUBDIRS, entries: manifest.entries };
  }
  mkdirSync(overlayDir, { recursive: true });
  if (existsSync(sdkLink)) {
    // 清理只保留 har-cache 等运行小目录；残留的 sdk/ 链接或目录只能来自已删除副本。
    // 不删除这些路径以外的文件，并绝不跟随 sdk/ 的符号链接。
    if (lstatSync(sdkLink).isSymbolicLink()) unlinkSync(sdkLink);
    else {
      for (const name of readdirSync(sdkLink)) {
        const child = join(sdkLink, name);
        if (lstatSync(child).isSymbolicLink()) unlinkSync(child);
      }
      rmSync(sdkLink, { recursive: true, force: true });
    }
  }

  const platform = options.platform || process.platform;
  const clone = options.clone ?? platform === 'darwin';
  const names = readdirSync(root).filter((name) => !AGENT_SKILL_DIRS.has(name));
  const copied = names.filter((name) => !SHARED_LINKED_ENTRIES.includes(name));
  const copyBytes = () => copied.reduce((sum, name) => sum + treeBytes(join(root, name)), 0);
  if (!clone) ensureFreeSpace(overlayDir, copyBytes(), options);
  else ensureFreeSpace(overlayDir, 0, options);

  const staging = mkdtempSync(join(overlayDir, '.snapshot-'));
  const stagedSdk = join(staging, 'sdk');
  let published = false;
  try {
    mkdirSync(stagedSdk, { mode: lstatSync(root).mode });
    const linked: string[] = [];
    const linkFallbackCopies: string[] = [];
    let copyMethod = 'copy';
    let entries = 0;
    let cloned = false;
    if (clone && copied.length) {
      try {
        execFileSync('cp', ['-c', '-R', ...copied.map((name) => join(root, name)), stagedSdk], { stdio: 'ignore' });
        cloned = true;
        copyMethod = 'clonefile';
        for (const name of copied) entries += repairClonedTree(root, join(root, name), join(stagedSdk, name), sdkLink);
      } catch (error) {
        if (cloned) throw error;
        for (const name of readdirSync(stagedSdk)) rmSync(join(stagedSdk, name), { recursive: true, force: true });
        ensureFreeSpace(overlayDir, copyBytes(), options);
      }
    }
    if (!cloned) {
      for (const name of copied) entries += copyTree(root, join(root, name), join(stagedSdk, name), sdkLink);
    }
    for (const name of names.filter((n) => SHARED_LINKED_ENTRIES.includes(n))) {
      const source = join(root, name);
      if (lstatSync(source).isSymbolicLink()) { entries += copyLink(root, source, join(stagedSdk, name), sdkLink); continue; }
      if (linkSharedDir(source, join(stagedSdk, name), platform, options.link) === 'copy') linkFallbackCopies.push(name);
      else linked.push(name);
      entries += 1;
    }
    if (!existsSync(join(stagedSdk, 'bin', 'flutter'))
      && !existsSync(join(stagedSdk, 'bin', 'flutter.bat'))) throw new Error('SDK 缺少 Flutter 入口');
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify({
      version: OVERLAY_VERSION, isolation: 'copy-with-readonly-links', sdkRoot: root,
      writableDirs: WRITABLE_SUBDIRS, linkedReadOnly: linked, linkFallbackCopies, copyMethod,
      entries, createdAt: new Date().toISOString(),
    }, null, 2));
    renameSync(stagedSdk, sdkLink);
    published = true;
    renameSync(join(staging, 'manifest.json'), manifestPath);
    return { overlayDir, sdkLink, flutterBin: overlayFlutterBinForRun(overlayDir), writableDirs: WRITABLE_SUBDIRS, entries };
  } catch (error) {
    if (published) rmSync(sdkLink, { recursive: true, force: true });
    throw error;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function overlayFlutterBinForRun(overlayDir: string): string | null {
  const sdkLink = resolve(overlayDir, 'sdk');
  try {
    const manifest = JSON.parse(readFileSync(join(overlayDir, 'overlay-manifest.json'), 'utf8'));
    if (!READABLE_VERSIONS.has(manifest.version) || lstatSync(sdkLink).isSymbolicLink()) return null;
    for (const name of ['flutter', 'flutter.bat']) {
      const candidate = join(sdkLink, 'bin', name);
      if (existsSync(candidate) && inside(sdkLink, realpathSync(candidate))) return candidate;
    }
  } catch { /* Missing or unsafe snapshots are unusable. */ }
  return null;
}

function unlinkEntry(path: string): void {
  try { unlinkSync(path); } catch { rmdirSync(path); }
}

/** 删掉 run 的 SDK 副本（sdk/、清单、半成品、精确版本对齐副本），保留 har-cache 等小目录。链接只解除，不跟进共享 SDK。 */
export async function removeSdkOverlaySnapshot(overlayDir: string): Promise<boolean> {
  overlayDir = resolve(overlayDir);
  if (basename(overlayDir) !== 'sdk-overlay') throw new Error(`不是 run 的 sdk-overlay 目录: ${overlayDir}`);
  let names: string[];
  try { names = await readdir(overlayDir); } catch { return false; }
  const sdk = join(overlayDir, 'sdk');
  let removed = false;
  if (names.includes('sdk')) {
    if (lstatSync(sdk).isSymbolicLink()) unlinkEntry(sdk);
    else {
      for (const name of readdirSync(sdk)) {
        const child = join(sdk, name);
        if (lstatSync(child).isSymbolicLink()) unlinkEntry(child);
      }
      await rm(sdk, { recursive: true, force: true });
    }
    removed = true;
  }
  // 精确版本对齐副本（git worktree）：先从其 .git 文件反查共享仓并注销 worktree 登记，
  // 避免共享仓 .git/worktrees/ 累积失效登记，再删副本目录释放磁盘。
  if (names.includes('aligned-sdk')) {
    const aligned = join(overlayDir, 'aligned-sdk');
    await removeAlignedWorktree(aligned);
    await rm(aligned, { recursive: true, force: true });
    removed = true;
  }
  for (const name of names.filter((n) => n === 'overlay-manifest.json' || n.startsWith('.snapshot-'))) {
    await rm(join(overlayDir, name), { recursive: true, force: true });
    removed = true;
  }
  return removed;
}

/** 注销对齐副本对应的 git worktree 登记。副本 .git 是文本文件：`gitdir: <共享仓>/.git/worktrees/<name>`。
 *  解析出共享仓路径后 `git worktree remove --force`，再 `prune`。失败不阻断目录删除。 */
async function removeAlignedWorktree(alignedDir: string): Promise<void> {
  try {
    const dotGit = join(alignedDir, '.git');
    const stat = existsSync(dotGit) ? lstatSync(dotGit) : null;
    if (!stat?.isFile()) return; // 非 worktree（无 .git 文件）无需注销
    const text = readFileSync(dotGit, 'utf8').trim();
    const match = text.match(/^gitdir:\s*(.+)$/);
    if (!match) return;
    // match[1] = <共享仓>/.git/worktrees/<name> → 共享仓根 = 上三级
    const sharedGitDir = dirname(dirname(match[1])); // <共享仓>/.git
    const sharedRoot = dirname(sharedGitDir);
    if (!existsSync(sharedRoot)) return;
    await execFileAsync('git', ['-C', sharedRoot, 'worktree', 'remove', '--force', alignedDir], { timeout: 30000 }).catch(() => {});
    await execFileAsync('git', ['-C', sharedRoot, 'worktree', 'prune'], { timeout: 30000 }).catch(() => {});
  } catch { /* 注销失败不阻断副本删除 */ }
}

const ENDED_RUN_STATUSES = new Set(['completed', 'failed', 'stopped', 'crashed']);

/** 启动时清掉已结束 run 的 SDK 副本；状态读不到的 run 不动。 */
export async function sweepEndedRunSdkOverlays(
  runsDir: string,
  statusOf: (runId: string) => Promise<string | null | undefined>,
): Promise<string[]> {
  let runIds: string[];
  try { runIds = await readdir(runsDir); } catch { return []; }
  const removed: string[] = [];
  for (const runId of runIds) {
    const overlayDir = join(runsDir, runId, 'sdk-overlay');
    if (!existsSync(join(overlayDir, 'sdk')) && !existsSync(join(overlayDir, 'overlay-manifest.json'))) continue;
    const status = await statusOf(runId).catch(() => null);
    if (!status || !ENDED_RUN_STATUSES.has(status)) continue;
    if (await removeSdkOverlaySnapshot(overlayDir)) removed.push(runId);
  }
  return removed;
}

export { WRITABLE_SUBDIRS as SDK_OVERLAY_WRITABLE_DIRS, SHARED_LINKED_ENTRIES as SDK_OVERLAY_SHARED_LINKS };
