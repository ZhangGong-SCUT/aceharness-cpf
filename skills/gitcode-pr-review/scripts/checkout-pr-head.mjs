#!/usr/bin/env node
/**
 * 把 PR head 挂到本次 run 的 repo/。
 * 本机已有对应仓库时只 fetch 该分支；没有仓库时才允许浅克隆。
 * 浅克隆至少保留父提交。--depth 1 时 HEAD~1 在 macOS、Linux、Windows 上都不存在。
 * 禁止不带 --depth 和 --branch 的 git clone。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeRoot } from '../../../scripts/runtime-root.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const installRoot = resolve(here, '../../..');

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) return '';
  return process.argv[index + 1];
}

export const SHALLOW_DEPTH = '2';

export function shallowCloneArgs(url, branch, dest) {
  if (!url || !branch || !dest) throw new Error('浅克隆缺少 url、分支或目标目录');
  return ['clone', '--depth', SHALLOW_DEPTH, '--branch', branch, '--single-branch', url, dest];
}

function gitBin() {
  return process.env.ACE_GIT || 'git';
}

function git(cwd, args) {
  return execFileSync(gitBin(), ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(cwd, args) {
  try { return git(cwd, args); } catch { return ''; }
}

function configCandidates(explicit) {
  const list = [
    explicit || '',
    arg('--config'),
    process.env.ACE_OHOS_FLUTTER_SDKS || '',
    join(runtimeRoot(), 'configs', 'ohos-flutter-sdks.yaml'),
    join(installRoot, 'configs', 'ohos-flutter-sdks.yaml'),
  ];
  return list.filter(Boolean);
}

function readInventory(file) {
  const text = readFileSync(file, 'utf8');
  return text.split(/\n\s*-\s+id:\s*/).slice(1).map((block) => {
    const id = (block.match(/^([^\n]+)/) || [])[1]?.trim() || '';
    const path = (block.match(/^\s*path:\s*(.+)$/m) || [])[1]?.trim() || '';
    const aliases = [...block.matchAll(/^\s+-\s+(\S+)/gm)].map((item) => item[1]);
    return { id, path, aliases };
  }).filter((item) => item.path);
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

export function matchSdkRepo(entries, baseRef) {
  const want = normalize(baseRef);
  if (!want) return null;
  return entries.find((entry) => [entry.id, ...(entry.aliases || [])].some((item) => normalize(item) === want)) || null;
}

function loadSdkRepo(baseRef, configFile) {
  const file = configCandidates(configFile).find((item) => existsSync(item));
  if (!file) throw new Error('找不到 ohos-flutter-sdks.yaml，无法按 base_ref 定位本机仓库');
  const match = matchSdkRepo(readInventory(file), baseRef);
  if (!match) throw new Error(`清单里没有 base_ref=${baseRef} 对应的本机仓库`);
  return { config: file, path: resolve(match.path) };
}

function forkUrl(headRepo) {
  const repo = String(headRepo || '').replace(/\.git$/i, '').replace(/^https?:\/\/[^/]+\//, '');
  if (!repo.includes('/')) throw new Error('缺少 head_repo，无法确定 fork');
  return `https://gitcode.com/${repo}.git`;
}

function sameCommit(left, right) {
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function ensureMyfork(source, url) {
  const remotes = tryGit(source, ['remote']).split(/\s+/).filter(Boolean);
  if (!remotes.includes('myfork')) {
    git(source, ['remote', 'add', 'myfork', url]);
    return;
  }
  const current = tryGit(source, ['remote', 'get-url', 'myfork']).replace(/\.git$/i, '');
  const wanted = url.replace(/\.git$/i, '');
  if (current && current !== wanted) git(source, ['remote', 'set-url', 'myfork', url]);
}

function localSha(source, headRef) {
  return tryGit(source, ['rev-parse', '--verify', `${headRef}^{commit}`]);
}

function hasCommit(source, ref) {
  return Boolean(ref && tryGit(source, ['rev-parse', '--verify', `${ref}^{commit}`]));
}

function fetchHead(source, headRef) {
  const current = tryGit(source, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current === headRef) {
    git(source, ['fetch', '--depth', SHALLOW_DEPTH, 'myfork', headRef]);
    return 'fetched-current';
  }
  git(source, ['fetch', '--depth', SHALLOW_DEPTH, 'myfork', `${headRef}:${headRef}`]);
  return 'fetched-branch';
}

function fetchBase(source, baseRef) {
  if (!baseRef || hasCommit(source, baseRef)) return false;
  for (const remote of ['origin', 'myfork']) {
    const remotes = tryGit(source, ['remote']).split(/\s+/).filter(Boolean);
    if (!remotes.includes(remote)) continue;
    try {
      git(source, ['fetch', '--depth', SHALLOW_DEPTH, remote, `${baseRef}:refs/heads/${baseRef}`]);
    } catch {
      continue;
    }
    if (hasCommit(source, baseRef)) return true;
  }
  return false;
}

function ensureWorktree(source, dest, headRef, headSha) {
  const want = headSha || localSha(source, headRef);
  if (existsSync(join(dest, '.git'))) {
    const current = tryGit(dest, ['rev-parse', 'HEAD']);
    if (sameCommit(current, want)) return 'reuse';
    git(dest, ['checkout', '--detach', want]);
    return 'update';
  }
  if (existsSync(dest)) throw new Error(`repo/ 已存在但不是工作树，拒绝覆盖：${dest}`);
  mkdirSync(dirname(dest), { recursive: true });
  try {
    git(source, ['worktree', 'add', dest, headRef]);
    return 'worktree';
  } catch {
    git(source, ['worktree', 'add', '--detach', dest, want]);
    return 'detached';
  }
}

export function checkoutPrHead(options) {
  const headRef = options.headRef;
  if (!headRef) throw new Error('缺少 head_ref');
  const sdk = options.sourcePath
    ? { path: resolve(options.sourcePath) }
    : loadSdkRepo(options.baseRef, options.configFile);
  const dest = resolve(options.runDir, 'repo');
  const url = options.forkUrl || forkUrl(options.headRepo);
  let fetched = false;
  let cloned = false;
  if (!existsSync(join(sdk.path, '.git'))) {
    if (existsSync(sdk.path)) {
      throw new Error(`本机路径存在但不是 git 仓库，拒绝克隆覆盖：${sdk.path}`);
    }
    mkdirSync(dirname(sdk.path), { recursive: true });
    execFileSync(gitBin(), shallowCloneArgs(url, headRef, sdk.path), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cloned = true;
    ensureMyfork(sdk.path, url);
  } else if (!sameCommit(localSha(sdk.path, headRef), options.headSha)) {
    ensureMyfork(sdk.path, url);
    fetchHead(sdk.path, headRef);
    fetched = true;
  }
  fetchBase(sdk.path, options.baseRef);
  const mode = ensureWorktree(sdk.path, dest, headRef, options.headSha || localSha(sdk.path, headRef));
  const upstream = tryGit(dest, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  return {
    ok: true,
    source: sdk.path,
    repo: dest,
    head: tryGit(dest, ['rev-parse', 'HEAD']),
    mode,
    fetched,
    cloned,
    upstream: upstream || null,
    direct_push: false,
    push_hint: `禁止在 repo 里直接 git push。推送到 ${options.headRepo} 的 ${headRef} 必须带 fork URL 和 refspec。当前上游是 ${upstream || '无'}。`,
  };
}

function main() {
  const result = checkoutPrHead({
    runDir: resolve(arg('--run') || process.cwd()),
    baseRef: arg('--base-ref'),
    headRef: arg('--head-ref'),
    headSha: arg('--head-sha'),
    headRepo: arg('--head-repo'),
    configFile: arg('--config'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
