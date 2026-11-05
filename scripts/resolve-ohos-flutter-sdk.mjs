#!/usr/bin/env node
/**
 * 按 repo 分支从 configs/ohos-flutter-sdks.yaml 对号入座。
 * 用法:
 *   node scripts/resolve-ohos-flutter-sdk.mjs --branch oh-3.35.7-release
 *   node scripts/resolve-ohos-flutter-sdk.mjs --repo ./repo
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function parseArgs(argv) {
  const out = { branch: '', baseBranch: '', repo: '', config: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--branch') out.branch = value || '';
    if (key === '--base-branch') out.baseBranch = value || '';
    if (key === '--repo') out.repo = value || '';
    if (key === '--config') out.config = value || '';
  }
  return out;
}

function readYamlInventory(filePath) {
  const text = readFileSync(filePath, 'utf-8');
  const dailySdk = (text.match(/^\s*dailySdk:\s*(.+)$/m) || [])[1]?.trim();
  const sdkRoot = (text.match(/^\s*sdkRoot:\s*(.+)$/m) || [])[1]?.trim();
  const blocks = text.split(/\n\s*-\s+id:\s*/).slice(1);
  const sdks = blocks.map((block) => {
    const id = (block.match(/^([^\n]+)/) || [])[1]?.trim();
    const version = (block.match(/^\s*version:\s*(.+)$/m) || [])[1]?.trim() || '';
    const path = (block.match(/^\s*path:\s*(.+)$/m) || [])[1]?.trim() || '';
    const aliases = [...block.matchAll(/^\s+-\s+(\S+)/gm)].map((item) => item[1]);
    return { id, version, aliases, path };
  }).filter((item) => item.id && item.path);
  return { dailySdk, sdkRoot, sdks };
}

function flutterBin(sdkRoot) {
  const posix = join(sdkRoot, 'bin', 'flutter');
  if (process.platform !== 'win32' && existsSync(posix)) return posix;
  const bat = join(sdkRoot, 'bin', 'flutter.bat');
  return existsSync(bat) ? bat : posix;
}

function usable(sdkRoot) {
  if (!sdkRoot || !existsSync(flutterBin(sdkRoot))) return false;
  return existsSync(join(sdkRoot, 'bin', 'cache', 'artifacts', 'engine'));
}

function versionHint(branch) {
  return (String(branch || '').match(/(\d+\.\d+\.\d+)/) || String(branch || '').match(/(\d+\.\d+)/) || [])[1] || null;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/[_/]/g, '-');
}

function readBranch(repoPath) {
  const head = join(repoPath, '.git', 'HEAD');
  if (!existsSync(head)) return null;
  const text = readFileSync(head, 'utf-8').trim();
  const ref = (text.match(/^ref:\s*refs\/heads\/(.+)$/) || [])[1] || null;
  if (ref) return ref.trim();
  // detached HEAD：origin/HEAD → packed-refs → 唯一本地分支
  const hash = (text.match(/^[0-9a-f]{40}$/i) || [])[0];
  if (!hash) return null;
  const originHead = join(repoPath, '.git', 'refs', 'remotes', 'origin', 'HEAD');
  if (existsSync(originHead)) {
    const oh = (readFileSync(originHead, 'utf-8').trim().match(/^ref:\s*refs\/remotes\/origin\/(.+)$/) || [])[1];
    if (oh) return oh.trim();
  }
  const packed = join(repoPath, '.git', 'packed-refs');
  if (existsSync(packed)) {
    const matches = [...readFileSync(packed, 'utf-8').matchAll(/^([0-9a-f]{40}) refs\/remotes\/origin\/(\S+)$/gm)]
      .filter((m) => m[1] === hash)
      .map((m) => m[2]);
    const preferred = matches.find((b) => /^(dev|master|main)$/.test(b));
    if (preferred || matches.length > 0) return preferred || matches[0];
  }
  const headsDir = join(repoPath, '.git', 'refs', 'heads');
  if (existsSync(headsDir)) {
    const heads = readdirSync(headsDir).filter((f) => f !== '.DS_Store');
    if (heads.length === 1 && readFileSync(join(headsDir, heads[0]), 'utf-8').trim() === hash) return heads[0];
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const configPath = args.config
  || process.env.ACE_OHOS_FLUTTER_SDKS
  || join(process.env.APPDATA || '', 'ACEHarness', 'configs', 'ohos-flutter-sdks.yaml')
  || join(repoRoot, 'configs', 'ohos-flutter-sdks.yaml');
const fallbackConfig = existsSync(configPath) ? configPath : join(repoRoot, 'configs', 'ohos-flutter-sdks.yaml');
if (!existsSync(fallbackConfig)) {
  console.error(JSON.stringify({ matched: false, reason: `找不到清单: ${fallbackConfig}` }, null, 2));
  process.exit(2);
}

const inventory = readYamlInventory(fallbackConfig);
const discovered = inventory.sdkRoot && existsSync(inventory.sdkRoot)
  ? readdirSync(inventory.sdkRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: entry.name,
      version: versionHint(entry.name) || entry.name,
      aliases: [entry.name],
      path: resolve(inventory.sdkRoot, entry.name),
    }))
  : [];
const entries = [...discovered, ...inventory.sdks].filter((entry) => usable(entry.path));
const branch = args.branch || (args.repo ? readBranch(resolve(args.repo)) : null);
const hint = versionHint(branch);
const scoreEntry = (entry, candidate) => {
  const aliases = [entry.id, entry.version, ...(entry.aliases || [])].map(normalize);
  const candidateHint = versionHint(candidate);
  let score = 0;
  if (candidate && aliases.includes(normalize(candidate))) score = 100;
  else if (candidateHint && aliases.includes(normalize(candidateHint))) score = 80;
  else if (candidateHint && aliases.some((alias) => alias.includes(normalize(candidateHint)))) score = 60;
  return score;
};
// feature 分支名可能不含版本号（pixelmapPurgeableFinal）：主分支对不上时用 --base-branch 兜底
const candidates = branch && args.baseBranch && branch !== args.baseBranch
  ? [{ name: branch, viaFallback: false }, { name: args.baseBranch, viaFallback: true }]
  : [{ name: branch, viaFallback: false }];
let winner = null;
for (const candidate of candidates) {
  const best = entries
    .map((entry) => ({ entry, score: scoreEntry(entry, candidate.name) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)[0];
  if (best) {
    winner = { ...best, branchName: candidate.name, viaFallback: candidate.viaFallback };
    break;
  }
}

const result = winner
  ? {
    matched: true,
    branch,
    versionHint: hint,
    sdkId: winner.entry.id,
    sdkRoot: resolve(winner.entry.path),
    flutterBin: flutterBin(winner.entry.path),
    dailySdk: inventory.dailySdk || null,
    inventory: entries.map((entry) => entry.id),
    reason: winner.viaFallback
      ? `按 base 分支 ${winner.branchName} 选中 ${winner.entry.id}（feature 分支 ${branch} 不含版本号）`
      : `按 ${winner.branchName} 选中 ${winner.entry.id}`,
  }
  : {
    matched: false,
    branch,
    versionHint: hint,
    sdkId: null,
    sdkRoot: null,
    flutterBin: null,
    dailySdk: inventory.dailySdk || null,
    inventory: entries.map((entry) => entry.id),
    reason: branch
      ? `没有与 ${branch} 对应的 SDK。禁止改用日常 SDK。`
      : '没有 repo 分支，无法对号入座',
  };

console.log(JSON.stringify(result, null, 2));
process.exit(result.matched ? 0 : 1);
