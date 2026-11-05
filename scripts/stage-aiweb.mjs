#!/usr/bin/env node
/**
 * 把 CPF-AIWeb 的可运行源码收进本仓库 aiweb/，供 npm 包携带。
 * 不复制 node_modules、.env、日志和数据库。硬编码令牌回退会被清掉。
 *
 * 源目录：CPF_AIWEB_ROOT，否则 ../CPF-AIWeb（与 ACEHarness 同级）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.resolve(process.env.CPF_AIWEB_ROOT || path.join(repoRoot, '..', 'CPF-AIWeb'));
const destRoot = path.join(repoRoot, 'aiweb');
const entries = ['Server', 'web', 'TAG', 'PrCheck', 'platformAudit.js', 'README.md', '.env.example'];

function skip(src) {
  const base = path.basename(src);
  if (base === 'node_modules' || base === '.git' || base === 'logs' || base === 'coverage') return false;
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return false;
  if (base === 'package-lock.json' || base.endsWith('.log')) return false;
  return true;
}

if (!fs.existsSync(path.join(sourceRoot, 'Server', 'server.js'))) {
  if (fs.existsSync(path.join(destRoot, 'Server', 'server.js'))) {
    console.log(`[stage-aiweb] 源目录不存在，沿用已有 ${destRoot}`);
    process.exit(0);
  }
  console.error(`[stage-aiweb] 找不到 CPF-AIWeb：${sourceRoot}`);
  process.exit(1);
}

fs.rmSync(destRoot, { recursive: true, force: true });
fs.mkdirSync(destRoot, { recursive: true });
for (const entry of entries) {
  const from = path.join(sourceRoot, entry);
  if (!fs.existsSync(from)) {
    console.error(`[stage-aiweb] 缺少 ${from}`);
    process.exit(1);
  }
  fs.cpSync(from, path.join(destRoot, entry), { recursive: true, filter: skip });
}

const configPath = path.join(destRoot, 'Server', 'library', 'config.js');
const configText = fs.readFileSync(configPath, 'utf8');
const stripped = configText.replace(
  /(gitcodeToken:\s*process\.env\.GITCODE_TOKEN\s*\|\|\s*)(['"])[^'"]*\2/,
  "$1''",
);
if (stripped === configText || /gitcodeToken:\s*process\.env\.GITCODE_TOKEN\s*\|\|\s*['"][^'"]+['"]/.test(stripped)) {
  console.error('[stage-aiweb] 未能清掉 GitCode 令牌回退，已中止');
  process.exit(1);
}
fs.writeFileSync(configPath, stripped);

function mustReplace(rel, from, to) {
  const file = path.join(destRoot, rel);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) {
    console.error(`[stage-aiweb] 未找到补丁锚点：${rel}`);
    process.exit(1);
  }
  fs.writeFileSync(file, text.replace(from, to));
}

mustReplace(
  'TAG/router.js',
  "const DB_DIR = path.resolve(__dirname, '../../db/GitCodeTag');",
  "const DB_DIR = process.env.AIWEB_TAG_DB_DIR || path.resolve(__dirname, '../../db/GitCodeTag');",
);
mustReplace(
  'PrCheck/router.js',
  "const DB_DIR = path.resolve(__dirname, '../../db/PrCheck');",
  "const DB_DIR = process.env.AIWEB_PRCHECK_DB_DIR || path.resolve(__dirname, '../../db/PrCheck');",
);
mustReplace(
  'platformAudit.js',
  "const AUDIT_FILE = path.resolve(__dirname, '..', 'db', 'platform-audit.log');",
  "const AUDIT_FILE = process.env.AIWEB_AUDIT_FILE || path.resolve(__dirname, '..', 'db', 'platform-audit.log');",
);

const secretHit = [];
function scan(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      scan(full);
      continue;
    }
    if (!/\.(js|mjs|cjs|json|md|html|css|example|yaml|yml)$/.test(ent.name)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (/ie_2_[A-Za-z0-9]+/.test(text) || /npm_[A-Za-z0-9]{20,}/.test(text)) secretHit.push(full);
  }
}
scan(destRoot);
if (secretHit.length) {
  console.error(`[stage-aiweb] 复制结果仍含令牌，已中止（${secretHit.length} 个文件）`);
  process.exit(1);
}

console.log(`[stage-aiweb] 已写入 ${destRoot}`);
