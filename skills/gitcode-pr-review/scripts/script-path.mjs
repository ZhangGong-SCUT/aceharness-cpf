import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 脚本文件的本地路径。
 * Windows 上 `new URL(import.meta.url).pathname` 是 `/D:/...`。
 * cwd 在另一盘时 `path.resolve` 会把它解析成 `E:\D:\...`，realpath 报 ENOENT。
 */
export function scriptFile(metaUrl) {
  return fileURLToPath(metaUrl);
}

/** 与当前脚本同目录的另一个脚本。`name` 只是文件名，不带 `../`。 */
export function siblingScript(metaUrl, name) {
  return join(dirname(scriptFile(metaUrl)), name);
}

/**
 * 是否由命令行直接运行。
 * realpath 两侧都解析，skills 经符号链接调用时 argv 与 import.meta.url 仍能对上。
 * 解析失败返回 false，避免把导入该模块误当成直接运行。
 */
export function isDirectRun(metaUrl) {
  const argv = process.argv[1];
  if (!argv || !metaUrl) return false;
  try {
    return realpathSync(resolve(argv)) === realpathSync(scriptFile(metaUrl));
  } catch {
    return false;
  }
}
