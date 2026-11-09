#!/usr/bin/env node
/**
 * 打包前确认安装包不会带走某一台电脑的管理员账号。
 * 管理员只写在本机 ~/.aceharness/data/users.json，由 ace 启动向导创建。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blockedNames = new Set(['users.json', 'admin.json', 'tokens.json', '.env', 'aiweb.env']);
const blockedSuffixes = ['/users.json', '/admin.json', '/tokens.json'];

function walk(dir, hits) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, hits);
      continue;
    }
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (blockedNames.has(ent.name) && ent.name !== '.env.example') hits.push(rel);
    else if (blockedSuffixes.some((suffix) => rel.endsWith(suffix))) hits.push(rel);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const hits = [];
for (const entry of pkg.files || []) {
  const full = path.join(root, entry);
  if (!fs.existsSync(full)) continue;
  if (fs.statSync(full).isDirectory()) walk(full, hits);
  else if (blockedNames.has(path.basename(full))) hits.push(entry);
}

if (hits.length) {
  console.error('[ACE] 安装包里有本机账号或密钥文件，已停止打包：');
  for (const hit of hits) console.error(`  ${hit}`);
  console.error('[ACE] 每台电脑的管理员由本机运行 ace 时自己创建，不要把 data/users.json、admin.json、tokens.json 或 .env 打进包。');
  process.exit(1);
}

console.log('[ACE] 打包检查通过：安装包不含管理员账号文件');
