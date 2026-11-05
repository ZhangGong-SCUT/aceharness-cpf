/** Per-run SDK snapshot. No file or directory may link back to the shared SDK. */
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export interface SdkOverlayResult {
  overlayDir: string;
  flutterBin: string | null;
  sdkLink: string;
  writableDirs: string[];
  entries: number;
}
const WRITABLE_SUBDIRS = ['.'];
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
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

function copyTree(root: string, source: string, destination: string, finalRoot: string): number {
  if (isAgentSkillAttachment(root, source)) return 0;
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    const rel = relative(root, source);
    let target: string;
    try {
      target = realpathSync(source);
    } catch (error) {
      if (basename(source) === 'AGENTS.md') return 0;
      throw error;
    }
    if (!inside(root, target)) {
      // AGENTS.md 是挂在 SDK 树上的 Harness 说明。Xcode 预编译 SDK 只服务 iOS/macOS 引擎。
      if (basename(source) === 'AGENTS.md' || isHostXcodeSdk(target)) return 0;
      throw new Error(`SDK 链接越出根目录: ${rel}`);
    }
    // Resolve links to a corresponding path in the new snapshot, including absolute links.
    const finalDestination = join(finalRoot, relative(root, source));
    symlinkSync(relative(dirname(finalDestination), join(finalRoot, relative(root, target))), destination);
    return 1;
  }
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

export function createSdkOverlay(sdkRoot: string, overlayDir: string): SdkOverlayResult {
  if (!existsSync(sdkRoot)) throw new Error(`SDK 根目录不存在: ${sdkRoot}`);
  const root = realpathSync(sdkRoot);
  overlayDir = resolve(overlayDir);
  if (inside(root, overlayDir)) throw new Error('SDK 副本目录不能位于共享 SDK 内');
  const manifestPath = join(overlayDir, 'overlay-manifest.json');
  const sdkLink = join(overlayDir, 'sdk');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== 2 || manifest.sdkRoot !== root || !existsSync(sdkLink)
      || lstatSync(sdkLink).isSymbolicLink()) {
      throw new Error('已有 SDK 隔离目录不兼容或不完整，请创建新 run；禁止退回共享 SDK');
    }
    const flutterBin = overlayFlutterBinForRun(overlayDir);
    if (!flutterBin) throw new Error('SDK 副本缺少独立 Flutter 入口');
    return { overlayDir, sdkLink, flutterBin, writableDirs: WRITABLE_SUBDIRS, entries: manifest.entries };
  }
  mkdirSync(overlayDir, { recursive: true });
  if (existsSync(sdkLink)) throw new Error('SDK 隔离目录缺少有效清单，请创建新 run');
  const staging = mkdtempSync(join(overlayDir, '.snapshot-'));
  let published = false;
  try {
    const entries = copyTree(root, root, join(staging, 'sdk'), sdkLink);
    if (!existsSync(join(staging, 'sdk', 'bin', 'flutter'))
      && !existsSync(join(staging, 'sdk', 'bin', 'flutter.bat'))) throw new Error('SDK 缺少 Flutter 入口');
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify({
      version: 2, isolation: 'independent-copy', sdkRoot: root,
      writableDirs: WRITABLE_SUBDIRS, entries, createdAt: new Date().toISOString(),
    }, null, 2));
    renameSync(join(staging, 'sdk'), sdkLink);
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
    if (manifest.version !== 2 || lstatSync(sdkLink).isSymbolicLink()) return null;
    for (const name of ['flutter', 'flutter.bat']) {
      const candidate = join(sdkLink, 'bin', name);
      if (existsSync(candidate) && inside(sdkLink, realpathSync(candidate))) return candidate;
    }
  } catch { /* Missing or unsafe snapshots are unusable. */ }
  return null;
}
export { WRITABLE_SUBDIRS as SDK_OVERLAY_WRITABLE_DIRS };
