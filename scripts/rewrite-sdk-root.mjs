#!/usr/bin/env node
/**
 * 把 SDK 清单里的源机路径换成目标机路径，并写成无 BOM 的 UTF-8。
 * 用法: node rewrite-sdk-root.mjs <文件> <原前缀> <新前缀>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function rewritePrefixedText(text, from, to) {
  if (!from) throw new Error('缺少原路径');
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body.split(from).join(to);
}

function main() {
  const [file, from, to] = process.argv.slice(2);
  if (!file || !from || !to) {
    console.error('用法: node rewrite-sdk-root.mjs <文件> <原前缀> <新前缀>');
    process.exit(1);
  }
  const next = rewritePrefixedText(readFileSync(file, 'utf8'), from, to);
  writeFileSync(file, next, 'utf8');
  if (!next.includes(to)) {
    console.error(`路径改写失败: ${file}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
