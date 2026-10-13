/**
 * F11/R08：run 级 SDK overlay——真实文件系统隔离机制（不只是指纹检测）。
 *
 * 结构：overlayDir/sdk 是原 SDK 的符号链接镜像，唯独 bin/cache 是真实目录：
 * cache 内条目逐个 symlink 到共享只读产物；flutter/dart 工具运行时新写/替换的
 * cache 条目只会落在 overlay 的真实目录里，共享 SDK 保持只读。
 * 代价接近零（全是 symlink），删除 overlay 不影响共享 SDK。
 *
 * 使用约束：overlay 通过 `flutter` 可执行文件路径生效——调用方解析 SDK 后，
 * 若 run 存在 overlay，应把 flutterBin 指向 overlay 内的 bin/flutter。
 */
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

export interface SdkOverlayResult {
  overlayDir: string;
  /** overlay 内的 flutter 入口（调用方应优先用它替换共享 SDK 的 flutterBin） */
  flutterBin: string | null;
  sdkLink: string;
  /** 被落成真实目录的子路径（相对 sdk 根），其余皆为 symlink */
  writableDirs: string[];
  entries: number;
}

/** 需要可写的子树：flutter 工具运行时会改写这些目录 */
const WRITABLE_SUBDIRS = ['bin/cache'];

function linkOrCopyEntry(src: string, dst: string): void {
  const stat = lstatSync(src);
  if (stat.isSymbolicLink()) {
    // 保留原符号链接（SDK 内部常有相对链接），读不出时退化为实体复制
    try { symlinkSync(readlinkSync(src), dst); return; } catch { /* fallthrough */ }
  }
  if (stat.isDirectory()) {
    symlinkSync(src, dst, 'dir');
  } else {
    symlinkSync(src, dst, 'file');
  }
}

/** 把 srcDir 内容镜像到 dstDir：子项默认 symlink；
 * writableSubdirs 及其祖先目录落成真实目录（祖先不实体化会把整棵子树链接进共享 SDK），
 * 可写区内的文件落成实体复制（工具可能原地改写） */
function mirrorTree(srcDir: string, dstDir: string, relPrefix: string, writableSubdirs: string[]): number {
  mkdirSync(dstDir, { recursive: true });
  let count = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    const isWritable = writableSubdirs.some((w) => rel === w || rel.startsWith(`${w}/`));
    const containsWritable = writableSubdirs.some((w) => w.startsWith(`${rel}/`));
    if (isWritable || containsWritable) {
      const realSrc = entry.isSymbolicLink() ? resolve(srcDir, readlinkSync(src)) : src;
      if (existsSync(realSrc) && lstatSync(realSrc).isDirectory()) {
        count += mirrorTree(realSrc, dst, rel, writableSubdirs);
        continue;
      }
      // 可写区内的文件落成实体复制（flutter 工具可能原地改写 cache 条目）
      cpSync(src, dst);
      count += 1;
      continue;
    }
    linkOrCopyEntry(src, dst);
    count += 1;
  }
  return count;
}

/**
 * 在 overlayDir 下创建 sdk 镜像。幂等：已存在 manifest 且 sdkRoot 一致时直接复用。
 * 任何一步失败都只影响本 run 的 overlay 目录，不触碰共享 SDK。
 */
export function createSdkOverlay(sdkRoot: string, overlayDir: string): SdkOverlayResult {
  const root = resolve(sdkRoot);
  if (!existsSync(root)) throw new Error(`SDK 根目录不存在: ${root}`);
  const manifestPath = join(overlayDir, 'overlay-manifest.json');
  const sdkLink = join(overlayDir, 'sdk');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (manifest?.sdkRoot === root && existsSync(sdkLink)) {
        return {
          overlayDir,
          flutterBin: overlayFlutterBin(sdkLink),
          sdkLink,
          writableDirs: manifest.writableDirs || WRITABLE_SUBDIRS,
          entries: manifest.entries || 0,
        };
      }
    } catch { /* manifest 损坏则重建 */ }
  }
  mkdirSync(sdkLink, { recursive: true });
  const entries = mirrorTree(root, sdkLink, '', WRITABLE_SUBDIRS);
  const result: SdkOverlayResult = {
    overlayDir,
    flutterBin: overlayFlutterBin(sdkLink),
    sdkLink,
    writableDirs: WRITABLE_SUBDIRS,
    entries,
  };
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    sdkRoot: root,
    sdkRootShaHint: createHash('sha256').update(root).digest('hex').slice(0, 16),
    writableDirs: WRITABLE_SUBDIRS,
    entries,
    createdAt: new Date().toISOString(),
  }, null, 2));
  return result;
}

function overlayFlutterBin(sdkLink: string): string | null {
  for (const name of ['flutter', 'flutter.bat']) {
    const candidate = join(sdkLink, 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 若 run 已有 overlay 且包含 flutter 入口，返回 overlay 内的 flutterBin；否则返回 null */
export function overlayFlutterBinForRun(overlayDir: string): string | null {
  const sdkLink = join(overlayDir, 'sdk');
  if (!existsSync(sdkLink)) return null;
  return overlayFlutterBin(sdkLink);
}

export { WRITABLE_SUBDIRS as SDK_OVERLAY_WRITABLE_DIRS };
