#!/usr/bin/env node
/**
 * 共享裸仓镜像缓存（repo mirror cache）
 *
 * 解决：isolated-copy 模式下每个 run 工作区全新、repo/ 不存在 → 每次 run 都全量
 * clone 上游（分钟级 + 重复带宽）。优先用本机 ohos-flutter-sdks.yaml 里同一仓库的 SDK
 * 做本地克隆，再只增量拉取目标分支。没有对上的 SDK 时，才用共享裸仓镜像：
 *   上游 --(一次性全量/增量 fetch)--> ~/.aceharness/repo-cache/<host>/<owner>/<repo>.git
 *   run  --(本地 hardlink clone, 秒级)--> <dest>，再把 origin 指回真实上游并补增量
 *
 * 用法（agent 统一走本脚本，禁止手写 git clone 全量拉取）：
 *   node repo-cache.mjs ensure --repo <url>
 *   node repo-cache.mjs clone --repo <url> --dest repo/ [--branch oh-3.27.4-dev] [--fallback-branch dev]
 *   node repo-cache.mjs status
 *
 * 行为约定：
 * - dest 已存在且为有效 git 仓 → 不重新 clone，仅 fetch --all --prune（run 内复用）
 * - 镜像操作任何失败 → 自动降级为直连上游 clone（保底路径与旧流程一致）
 * - 本地 clone 使用 hardlink（对象不占额外空间，且不受镜像 repack 影响，无 alternates 依赖）
 * - 并发：镜像更新用 flock 串行化；dest 是 run 私有目录无需锁
 * - 输出：stdout 单行 JSON（clone_result/from_cache/branch/commit/duration_ms/...）
 */

import { execFileSync } from 'node:child_process';
import { constants, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLock } from '../../../scripts/file-lock.mjs';
import { runtimeRoot } from '../../../scripts/runtime-root.mjs';

function cacheDir() {
  return process.env.ACEHARNESS_REPO_CACHE_DIR
    || join(runtimeRoot(), 'repo-cache');
}

/** 规范化仓库 URL：去 userinfo、去 .git 尾巴、host 小写 */
function normalizeRepoUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) throw new Error('--repo 不能为空');
  url = url.replace(/^https?:\/\/[^@/]+@/i, (m) => m.replace(/[^@]+@/, ''));
  url = url.replace(/\.git$/i, '');
  return url;
}

/** 从 URL 解析镜像路径：<cache>/<host>/<owner>/<repo>.git */
function mirrorInfo(rawUrl) {
  const normalized = normalizeRepoUrl(rawUrl);
  const match = normalized.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/?#]+)/i);
  if (!match) {
    throw new Error(`无法解析仓库 URL: ${rawUrl}`);
  }
  const [, host, owner, repo] = match;
  const hostDir = host.toLowerCase();
  return {
    url: normalized,
    key: `${hostDir}/${owner}/${repo}`,
    path: join(cacheDir(), hostDir, owner, `${repo}.git`),
    lockPath: join(cacheDir(), 'locks', `${hostDir}__${owner}__${repo}.lock`),
  };
}

function runGit(args, options = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  return execFileSync('git', args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', options.stdioErr ? 'inherit' : 'pipe'],
    timeout: options.timeoutMs || 0,
  });
}

function runGitOk(args, options = {}) {
  try {
    return { ok: true, output: runGit(args, options) };
  } catch (error) {
    const stderr = String(error.stderr || error.message || '');
    return { ok: false, error: stderr.trim() };
  }
}

export function runLockedGit(lockPath, gitArgs, deps = {}) {
  const exec = deps.execFileSync || execFileSync;
  const run = deps.runGit || runGit;
  const platform = deps.platform || process.platform;
  mkdirSync(dirname(lockPath), { recursive: true });
  if (platform !== 'win32') {
    try {
      const output = exec('flock', ['-w', '900', lockPath, 'git', ...gitArgs], {
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 0,
      });
      return { ok: true, output };
    } catch (error) {
      if (error.code !== 'ENOENT') return { ok: false, error: String(error.stderr || error.message || '').trim() };
    }
  }
  try {
    const output = withFileLock(lockPath, () => run(gitArgs), deps.lock);
    return { ok: true, output };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message || error).trim() };
  }
}

function withFlock(lockPath, gitArgs) {
  return runLockedGit(lockPath, gitArgs);
}

function isValidGitRepo(dir) {
  return existsSync(join(dir, '.git')) || (existsSync(dir) && existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects')) && existsSync(join(dir, 'refs')));
}

function repoBasename(rawUrl) {
  try {
    const normalized = normalizeRepoUrl(rawUrl);
    const match = normalized.match(/\/([^/?#]+)$/);
    return match ? match[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

export function branchVersion(name) {
  const match = String(name || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

function versionAtLeast335(version) {
  if (!version) return false;
  const [major, minor] = version;
  return major > 3 || (major === 3 && minor >= 35);
}

function versionBelow335(version) {
  if (!version) return false;
  const [major, minor] = version;
  return major < 3 || (major === 3 && minor < 35);
}

/** 单个分支名：3.35 及以上拒绝。没有版本号时不在这里拒绝，由整次请求判断。 */
export function flutterEngineCloneBlock(repo, branch) {
  if (repoBasename(repo) !== 'flutter_engine') return null;
  const version = branchVersion(branch);
  if (!versionAtLeast335(version)) return null;
  return `3.35 及以上禁止拉取 flutter_engine（请求分支 ${branch}）。embedding 源码在 framework 仓 repo/engine/src/flutter/，不要创建 repo-engine/。`;
}

/** 整次 clone：必须有一个明确低于 3.35 的分支。只写 dev、或任一分支不低于 3.35，都拒绝。 */
export function flutterEngineCloneRequestBlock(repo, branches) {
  if (repoBasename(repo) !== 'flutter_engine') return null;
  const names = (Array.isArray(branches) ? branches : [branches]).map((name) => String(name || '').trim()).filter(Boolean);
  const tooNew = names.find((name) => versionAtLeast335(branchVersion(name)));
  if (tooNew) return flutterEngineCloneBlock(repo, tooNew);
  if (names.some((name) => versionBelow335(branchVersion(name)))) return null;
  return `拉取 flutter_engine 必须给出低于 3.35 的版本分支（收到 ${names.join(', ') || '空'}）。3.35 及以上只用 framework 仓 repo/engine/src/flutter/，不要创建 repo-engine/。`;
}

/** 运行时清单：<运行时根>/configs/ohos-flutter-sdks.yaml */
function sdkInventoryPath() {
  return join(runtimeRoot(), 'configs', 'ohos-flutter-sdks.yaml');
}

function readSdkInventory(configPath = sdkInventoryPath()) {
  if (!existsSync(configPath)) return [];
  const sdks = [];
  let current = null;
  let inAliases = false;
  for (const raw of readFileSync(configPath, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const id = line.match(/^ {2}- id:\s*(\S+)\s*$/);
    if (id) {
      current = { id: id[1], aliases: [], path: '' };
      sdks.push(current);
      inAliases = false;
      continue;
    }
    if (!current) continue;
    const sdkPath = line.match(/^ {4}path:\s*(\S+)\s*$/);
    if (sdkPath) {
      current.path = sdkPath[1];
      inAliases = false;
      continue;
    }
    if (/^ {4}aliases:\s*$/.test(line)) {
      inAliases = true;
      continue;
    }
    const alias = line.match(/^ {6}- (\S+)\s*$/);
    if (inAliases && alias) current.aliases.push(alias[1]);
    else if (!line.startsWith('      ')) inAliases = false;
  }
  return sdks.filter((sdk) => sdk.path);
}

/** 分支能对上清单、且 origin 仓库名与 --repo 相同的本地 SDK。 */
function findLocalSdkSource(options) {
  const wantedRepo = repoBasename(options.repo);
  if (!wantedRepo) return null;
  const names = [options.branch, options.fallbackBranch].filter(Boolean);
  for (const name of names) {
    const entry = readSdkInventory().find((sdk) => sdk.id === name || sdk.aliases.includes(name));
    if (!entry || !isValidGitRepo(entry.path)) continue;
    const origin = runGitOk(['-C', entry.path, 'remote', 'get-url', 'origin']);
    if (!origin.ok || repoBasename(origin.output) !== wantedRepo) continue;
    return { id: entry.id, path: entry.path, matchedBranch: name };
  }
  return null;
}

const DEFAULT_SHALLOW_FETCH_DEPTH = 500;

/** @param {Record<string, string | undefined>} [env] */
export function shallowFetchDepth(env = process.env) {
  const parsed = Number.parseInt(String(env.ACE_REPO_CACHE_SHALLOW_DEPTH || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SHALLOW_FETCH_DEPTH;
}

/** 浅仓里拉一个本地还没有的分支时限深度；不限的话会把该分支几乎整段历史拉下来（实测 40 万对象，超过 agent 命令时限）。 */
export function fetchBranchArgs(dest, name, { shallow, hasBranch, depth = shallowFetchDepth() }) {
  const args = ['-C', dest, 'fetch'];
  if (shallow && !hasBranch) args.push(`--depth=${depth}`);
  return [...args, 'origin', `+refs/heads/${name}:refs/remotes/origin/${name}`];
}

function fetchRemoteBranch(dest, name) {
  if (!name) return { ok: false, error: 'empty branch' };
  const shallow = existsSync(join(dest, '.git', 'shallow'));
  const hasBranch = runGitOk(['-C', dest, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]).ok;
  return runGitOk(fetchBranchArgs(dest, name, { shallow, hasBranch }));
}

/** 拷出来的 .git 要和 `git clone --no-checkout` 一样：没有索引、不认源仓的 worktree、不带残留锁。 */
const COPIED_GIT_TRANSIENT = ['index', 'worktrees', 'FETCH_HEAD', 'ORIG_HEAD', 'gc.pid', 'gc.log'];

function removeLockFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'objects') removeLockFiles(path);
    } else if (entry.name.endsWith('.lock')) {
      rmSync(path, { force: true });
    }
  }
}

/**
 * 写时复制拷本地 SDK 的 .git（APFS/btrfs/XFS 上秒级、几乎不占新空间）。
 * git clone 本地浅仓会重新打包，几个 run 同时做要好几分钟、每个多写约 2GB。
 * 文件系统不支持 reflink 时 COPYFILE_FICLONE_FORCE 直接报错，由调用方退回 git clone。
 */
export function copyGitDirCow(source, dest, copy = cpSync) {
  const gitDir = join(dest, '.git');
  try {
    mkdirSync(dest, { recursive: true });
    copy(join(source, '.git'), gitDir, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE_FORCE,
      verbatimSymlinks: true,
    });
    for (const name of COPIED_GIT_TRANSIENT) rmSync(join(gitDir, name), { recursive: true, force: true });
    removeLockFiles(gitDir);
    return { ok: true };
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    return { ok: false, error: String(error?.message || error) };
  }
}

/** 从本地 SDK 克隆对象，origin 改回请求的上游，只拉目标分支再检出。失败则返回 null 以外的错误，由调用方决定是否退回旧路径。 */
function cloneFromLocalSdk(options, dest, upstreamUrl) {
  const local = findLocalSdkSource(options);
  if (!local) return null;
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  const copied = statSync(join(local.path, '.git')).isDirectory() ? copyGitDirCow(local.path, dest) : { ok: false };
  const cloned = copied.ok ? copied : runGitOk(['clone', '--no-checkout', local.path, dest]);
  if (!cloned.ok) {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    return { ok: false, local, error: cloned.error };
  }
  const remote = runGitOk(['-C', dest, 'remote', 'set-url', 'origin', upstreamUrl]);
  if (!remote.ok) return { ok: false, local, error: remote.error };
  let fetched = null;
  let fetchError = null;
  for (const name of [options.branch, options.fallbackBranch].filter(Boolean)) {
    const result = fetchRemoteBranch(dest, name);
    if (result.ok) {
      fetched = name;
      if (name === options.branch) break;
    } else {
      fetchError = result.error;
    }
  }
  const branchResult = options.branch || options.fallbackBranch
    ? checkoutBranch(dest, options.branch, options.fallbackBranch)
    : { branch: currentBranch(dest), branchSource: 'default_branch', error: null };
  return { ok: Boolean(branchResult.branch), local, fetched, fetchError, branchResult, error: branchResult.error };
}

/** 确保镜像存在且最新。返回 { updated, created, error } */
function ensureMirror(mirror) {
  mkdirSync(join(mirror.path, '..'), { recursive: true });
  if (!existsSync(mirror.path)) {
    const result = withFlock(mirror.lockPath, ['clone', '--mirror', mirror.url, mirror.path]);
    if (!result.ok) return { created: false, updated: false, error: result.error };
    return { created: true, updated: true, error: null };
  }
  const result = withFlock(mirror.lockPath, ['-C', mirror.path, 'fetch', '--all', '--prune', '--tags']);
  if (!result.ok) return { created: false, updated: false, error: result.error };
  return { created: false, updated: true, error: null };
}

/** 列出 dest 的远端分支（origin/*） */
function listRemoteBranches(dest) {
  const result = runGitOk(['-C', dest, 'branch', '-r', '--format=%(refname:short)']);
  if (!result.ok) return new Set();
  return new Set(
    result.output.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.includes('HEAD ->'))
      .map((line) => line.replace(/^origin\//, '')),
  );
}

/** 符号链接启动时 argv 仍是链接路径，import.meta.url 已是真实文件。两边都解析后再比较。 */
export function isRepoCacheCli(argvPath, moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return resolve(argvPath) === modulePath;
  }
}

/**
 * --track 要求起点本身是分支。本地 SDK 拷出来的 origin/分支有时只是一个提交，
 * Git 会报 “is not a branch”。这时改为直接检出该提交，不再因为设不上上游就整次克隆失败。
 */
export function checkoutBranch(dest, branch, fallbackBranch, deps = {}) {
  const git = deps.runGitOk || runGitOk;
  const branches = deps.listRemoteBranches ? deps.listRemoteBranches(dest) : listRemoteBranches(dest);
  const pick = (candidate) => (candidate && branches.has(candidate) ? candidate : null);
  const target = pick(branch) || pick(fallbackBranch);
  if (!target) {
    return { branch: null, branchSource: 'default_branch', error: null };
  }
  const tracked = git(['-C', dest, 'checkout', '-B', target, '--track', `origin/${target}`]);
  const result = tracked.ok || !/not a branch|cannot set up tracking/i.test(tracked.error || '')
    ? tracked
    : git(['-C', dest, 'checkout', '-B', target, `origin/${target}`]);
  if (!result.ok) {
    return { branch: null, branchSource: 'default_branch', error: result.error || tracked.error };
  }
  return {
    branch: target,
    branchSource: target === branch ? 'requested' : 'fallback_branch',
    error: null,
  };
}

function currentCommit(dest) {
  const result = runGitOk(['-C', dest, 'rev-parse', 'HEAD']);
  return result.ok ? result.output.trim() : null;
}

function currentBranch(dest) {
  const result = runGitOk(['-C', dest, 'rev-parse', '--abbrev-ref', 'HEAD']);
  return result.ok ? result.output.trim() : null;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function parseArgs(argv) {
  const command = argv[0] || 'status';
  const options = { command };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--repo') { options.repo = next; i += 1; }
    else if (arg === '--dest') { options.dest = next; i += 1; }
    else if (arg === '--branch') { options.branch = next; i += 1; }
    else if (arg === '--fallback-branch') { options.fallbackBranch = next; i += 1; }
    else {
      throw new Error(`未知参数: ${arg}（用法见文件头注释）`);
    }
  }
  return options;
}

function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const info = statSync(current, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isDirectory()) {
      for (const name of readdirSync(current)) stack.push(join(current, name));
    } else {
      total += info.size;
    }
  }
  return total;
}

function commandStatus() {
  const root = cacheDir();
  if (!existsSync(root)) {
    emit({ result: 'success', cache_dir: root, mirrors: [], total_mb: 0 });
    return;
  }
  const mirrors = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name.endsWith('.git')) {
          const fetchHead = join(full, 'FETCH_HEAD');
          const lastFetch = existsSync(fetchHead) ? statSync(fetchHead).mtime.toISOString() : null;
          mirrors.push({
            key: full.slice(root.length + 1).replace(/\.git$/, ''),
            path: full,
            size_mb: Math.round(dirSizeBytes(full) / 1024 / 1024),
            last_fetch: lastFetch,
          });
        } else {
          walk(full);
        }
      }
    }
  };
  walk(root);
  const totalMb = mirrors.reduce((sum, item) => sum + item.size_mb, 0);
  emit({ result: 'success', cache_dir: root, mirrors, total_mb: totalMb });
}

function commandEnsure(options) {
  const started = Date.now();
  const mirror = mirrorInfo(options.repo);
  const ensured = ensureMirror(mirror);
  emit({
    result: ensured.error ? 'degraded' : 'success',
    repo_url: mirror.url,
    mirror_path: mirror.path,
    created: ensured.created,
    error: ensured.error,
    duration_ms: Date.now() - started,
  });
  if (ensured.error) process.exitCode = 0; // 降级不算失败，调用方看 result 字段
}

function commandClone(options) {
  const started = Date.now();
  const mirror = mirrorInfo(options.repo);
  const dest = resolve(options.dest || 'repo');
  const payload = {
    result: 'failed',
    from_cache: false,
    repo_url: mirror.url,
    dest,
    mirror_path: mirror.path,
    branch: null,
    branch_source: null,
    commit: null,
    duration_ms: 0,
    error: null,
  };
  const finish = (extra) => {
    payload.duration_ms = Date.now() - started;
    emit({ ...payload, ...extra });
  };

  const blocked = flutterEngineCloneRequestBlock(options.repo, [options.branch, options.fallbackBranch]);
  if (blocked) {
    finish({ result: 'failed', error: blocked });
    process.exitCode = 1;
    return;
  }

  // 场景 0：清单里有同一仓库的本地 SDK → 本地克隆，只增量拉取目标分支
  if (!isValidGitRepo(dest)) {
    const localClone = cloneFromLocalSdk(options, dest, mirror.url);
    if (localClone) {
      if (!localClone.ok) {
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
        finish({
          result: 'failed',
          local_sdk: localClone.local.path,
          local_sdk_id: localClone.local.id,
          error: localClone.error || '本地 SDK 拷贝后未能检出分支',
        });
        process.exitCode = 1;
        return;
      }
      const wanted = options.branch;
      const fresh = !wanted || localClone.fetched === wanted;
      finish({
        result: fresh ? 'success' : 'degraded',
        from_cache: true,
        local_sdk: localClone.local.path,
        local_sdk_id: localClone.local.id,
        degraded_reason: fresh ? null : `目标分支增量拉取失败，检出本地已有提交：${localClone.fetchError || ''}`.trim(),
        branch: localClone.branchResult.branch,
        branch_source: localClone.branchResult.branchSource,
        commit: currentCommit(dest),
      });
      return;
    }
  }

  // 场景 A：dest 已存在且有效 → 只拉目标分支（未指定分支时才 fetch --all）
  if (isValidGitRepo(dest)) {
    const names = [options.branch, options.fallbackBranch].filter(Boolean);
    let fetchResult = { ok: true, error: null };
    if (names.length) {
      for (const name of names) {
        const result = fetchRemoteBranch(dest, name);
        if (!result.ok) fetchResult = result;
        else if (!options.branch || name === options.branch) {
          fetchResult = result;
          break;
        }
      }
    } else {
      fetchResult = runGitOk(['-C', dest, 'fetch', '--all', '--prune']);
    }
    const branchResult = options.branch || options.fallbackBranch
      ? checkoutBranch(dest, options.branch, options.fallbackBranch)
      : { branch: currentBranch(dest), branchSource: 'existing' };
    const checkedOut = branchResult.branch || currentBranch(dest);
    finish({
      result: checkedOut ? (fetchResult.ok ? 'success' : 'degraded') : 'failed',
      from_cache: true,
      reused_existing: true,
      fetch_error: fetchResult.ok ? null : fetchResult.error,
      degraded_reason: fetchResult.ok ? null : `增量拉取失败：${fetchResult.error}`,
      branch: checkedOut,
      branch_source: branchResult.branchSource,
      commit: currentCommit(dest),
    });
    return;
  }

  // 场景 B：走镜像
  const ensured = ensureMirror(mirror);
  if (ensured.error) {
    // 镜像不可用 → 降级直连
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    const direct = runGitOk(['clone', mirror.url, dest]);
    if (!direct.ok) {
      finish({ result: 'failed', error: `镜像与直连均失败：${ensured.error} / ${direct.error}` });
      process.exitCode = 1;
      return;
    }
    const branchResult = options.branch || options.fallbackBranch
      ? checkoutBranch(dest, options.branch, options.fallbackBranch)
      : { branch: currentBranch(dest), branchSource: 'default_branch' };
    finish({
      result: 'degraded',
      from_cache: false,
      degraded_reason: `镜像更新失败已直连：${ensured.error}`,
      branch: branchResult.branch || currentBranch(dest),
      branch_source: branchResult.branchSource,
      commit: currentCommit(dest),
    });
    return;
  }

  // 镜像就绪 → 本地 hardlink clone（本地路径默认 hardlink，秒级）
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  const localClone = runGitOk(['clone', '--no-checkout', mirror.path, dest]);
  if (!localClone.ok) {
    // 本地 clone 失败 → 降级直连
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    const direct = runGitOk(['clone', mirror.url, dest]);
    if (!direct.ok) {
      finish({ result: 'failed', error: `本地镜像 clone 与直连均失败：${localClone.error} / ${direct.error}` });
      process.exitCode = 1;
      return;
    }
    const branchResult = options.branch || options.fallbackBranch
      ? checkoutBranch(dest, options.branch, options.fallbackBranch)
      : { branch: currentBranch(dest), branchSource: 'default_branch' };
    finish({
      result: 'degraded',
      from_cache: false,
      degraded_reason: `本地镜像 clone 失败已直连：${localClone.error}`,
      branch: branchResult.branch || currentBranch(dest),
      branch_source: branchResult.branchSource,
      commit: currentCommit(dest),
    });
    return;
  }

  // origin 指回真实上游（后续 git -C repo/ fetch/checkout 行为与旧流程完全一致）
  runGitOk(['-C', dest, 'remote', 'set-url', 'origin', mirror.url]);

  // 增量补齐：镜像刚 fetch 过基本秒过；失败不阻断（镜像数据兜底）
  const delta = runGitOk(['-C', dest, 'fetch', 'origin', '--prune', '--tags']);

  const branchResult = options.branch || options.fallbackBranch
    ? checkoutBranch(dest, options.branch, options.fallbackBranch)
    : { branch: currentBranch(dest), branchSource: 'default_branch' };

  finish({
    result: 'success',
    from_cache: true,
    mirror_created: ensured.created,
    delta_fetch_error: delta.ok ? null : delta.error,
    branch: branchResult.branch || currentBranch(dest),
    branch_source: branchResult.branchSource,
    commit: currentCommit(dest),
  });
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    emit({ result: 'failed', error: error.message });
    process.exitCode = 1;
    return;
  }
  if (options.command === 'status') {
    commandStatus();
    return;
  }
  if (!options.repo) {
    emit({ result: 'failed', error: `${options.command} 需要 --repo <url>` });
    process.exitCode = 1;
    return;
  }
  if (options.command === 'ensure') {
    commandEnsure(options);
    return;
  }
  if (options.command === 'clone') {
    commandClone(options);
    return;
  }
  emit({ result: 'failed', error: `未知子命令: ${options.command}（ensure|clone|status）` });
  process.exitCode = 1;
}

if (isRepoCacheCli(process.argv[1])) main();
