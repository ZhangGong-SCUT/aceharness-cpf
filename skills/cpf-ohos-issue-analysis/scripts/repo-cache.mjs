#!/usr/bin/env node
/**
 * 共享裸仓镜像缓存（repo mirror cache）
 *
 * 解决：isolated-copy 模式下每个 run 工作区全新、repo/ 不存在 → 每次 run 都全量
 * clone 上游（分钟级 + 重复带宽）。本脚本维护一份共享裸仓镜像：
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
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function cacheDir() {
  return process.env.ACEHARNESS_REPO_CACHE_DIR
    || join(homedir(), '.aceharness', 'repo-cache');
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

function withFlock(lockPath, gitArgs) {
  mkdirSync(join(lockPath, '..'), { recursive: true });
  // flock -w 900：最多等 15 分钟（大仓首次 clone --mirror 可能很久）
  try {
    const output = execFileSync('flock', ['-w', '900', lockPath, 'git', ...gitArgs], {
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 0,
    });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message || '').trim() };
  }
}

function isValidGitRepo(dir) {
  return existsSync(join(dir, '.git')) || (existsSync(dir) && existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects')) && existsSync(join(dir, 'refs')));
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

function checkoutBranch(dest, branch, fallbackBranch) {
  const branches = listRemoteBranches(dest);
  const pick = (candidate) => (candidate && branches.has(candidate) ? candidate : null);
  const target = pick(branch) || pick(fallbackBranch);
  if (!target) {
    return { branch: null, branchSource: 'default_branch', error: null };
  }
  const result = runGitOk(['-C', dest, 'checkout', '-B', target, '--track', `origin/${target}`]);
  if (!result.ok) {
    return { branch: null, branchSource: 'default_branch', error: result.error };
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

  // 场景 A：dest 已存在且有效 → fetch 复用（run 内重入）
  if (isValidGitRepo(dest)) {
    const fetchResult = runGitOk(['-C', dest, 'fetch', '--all', '--prune']);
    const branchResult = options.branch || options.fallbackBranch
      ? checkoutBranch(dest, options.branch, options.fallbackBranch)
      : { branch: currentBranch(dest), branchSource: 'existing' };
    finish({
      result: 'success',
      from_cache: true,
      reused_existing: true,
      fetch_error: fetchResult.ok ? null : fetchResult.error,
      branch: branchResult.branch || currentBranch(dest),
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

main();
