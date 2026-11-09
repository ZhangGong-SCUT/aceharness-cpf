/**
 * 把安装包里的 configs/skills/scripts 补进运行时目录。
 * 只补缺失文件，不覆盖已有内容。目录若已链接到安装包，则跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_NAMES = new Set(['node_modules', '.git']);

function sameDirectory(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

/** @returns {number} 新复制的文件数 */
export function syncMissingTree(src, dst) {
  if (!fs.existsSync(src)) return 0;
  const current = fs.lstatSync(src);
  if (current.isSymbolicLink()) {
    if (fs.existsSync(dst)) return 0;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(fs.readlinkSync(src), dst);
    return 1;
  }
  if (current.isDirectory()) {
    if (fs.existsSync(dst) && sameDirectory(src, dst)) return 0;
    fs.mkdirSync(dst, { recursive: true });
    let copied = 0;
    for (const name of fs.readdirSync(src)) {
      if (SKIP_NAMES.has(name)) continue;
      copied += syncMissingTree(path.join(src, name), path.join(dst, name));
    }
    return copied;
  }
  if (fs.existsSync(dst)) return 0;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return 1;
}

export function syncRuntimeTrees(installRoot, runtimeRoot) {
  let copied = 0;
  for (const name of ['configs', 'skills', 'scripts']) {
    copied += syncMissingTree(path.join(installRoot, name), path.join(runtimeRoot, name));
  }
  return copied;
}

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  const installRoot = process.argv[2];
  const runtimeRoot = process.argv[3];
  if (!installRoot || !runtimeRoot) {
    console.error('用法: node scripts/sync-missing-runtime-files.mjs <安装根> <运行时目录>');
    process.exit(1);
  }
  const copied = syncRuntimeTrees(installRoot, runtimeRoot);
  console.log(copied ? `已补齐 ${copied} 个缺失文件到 ${runtimeRoot}` : `运行时文件已齐: ${runtimeRoot}`);
}
