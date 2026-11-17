import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutBranch, copyGitDirCow, fetchBranchArgs, isRepoCacheCli, shallowFetchDepth } from '../skills/cpf-ohos-issue-analysis/scripts/repo-cache.mjs';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const plainCopy: typeof cpSync = (src, dst, opts) => cpSync(src, dst, { ...opts, mode: 0 });

describe('fetchBranchArgs', () => {
  const refspec = 'origin +refs/heads/dev:refs/remotes/origin/dev';

  it('limits depth only for a branch the shallow repo does not have yet', () => {
    expect(fetchBranchArgs('/r', 'dev', { shallow: true, hasBranch: false, depth: 500 }).join(' '))
      .toBe(`-C /r fetch --depth=500 ${refspec}`);
    expect(fetchBranchArgs('/r', 'dev', { shallow: true, hasBranch: true, depth: 500 }).join(' '))
      .toBe(`-C /r fetch ${refspec}`);
    expect(fetchBranchArgs('/r', 'dev', { shallow: false, hasBranch: false, depth: 500 }).join(' '))
      .toBe(`-C /r fetch ${refspec}`);
  });

  it('reads the depth from ACE_REPO_CACHE_SHALLOW_DEPTH', () => {
    expect(shallowFetchDepth({})).toBe(500);
    expect(shallowFetchDepth({ ACE_REPO_CACHE_SHALLOW_DEPTH: '80' })).toBe(80);
    expect(shallowFetchDepth({ ACE_REPO_CACHE_SHALLOW_DEPTH: 'x' })).toBe(500);
  });
});

describe('repo-cache 启动与检出', () => {
  it('符号链接路径也能认出自己是命令行入口', () => {
    const script = fileURLToPath(new URL('../skills/cpf-ohos-issue-analysis/scripts/repo-cache.mjs', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'repo-cache-link-'));
    const link = join(dir, 'repo-cache.mjs');
    try {
      symlinkSync(script, link);
      expect(isRepoCacheCli(link, new URL('../skills/cpf-ohos-issue-analysis/scripts/repo-cache.mjs', import.meta.url).href)).toBe(true);
      expect(isRepoCacheCli(link)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upstream 不是分支时改为直接检出，而不是整次失败', () => {
    const calls: string[][] = [];
    const result = checkoutBranch('/repo', 'br_3.22.0-ohos-1.0.4', 'dev', {
      listRemoteBranches: () => new Set(['br_3.22.0-ohos-1.0.4']),
      runGitOk: (args: string[]) => {
        calls.push(args);
        if (args.includes('--track')) {
          return { ok: false, error: "fatal: cannot set up tracking information; starting point 'origin/br_3.22.0-ohos-1.0.4' is not a branch" };
        }
        return { ok: true, output: '' };
      },
    });
    expect(result).toMatchObject({ branch: 'br_3.22.0-ohos-1.0.4', branchSource: 'requested', error: null });
    expect(calls[1]).toEqual(['-C', '/repo', 'checkout', '-B', 'br_3.22.0-ohos-1.0.4', 'origin/br_3.22.0-ohos-1.0.4']);
  });
});

describe('copyGitDirCow', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function sourceRepo() {
    root = mkdtempSync(join(tmpdir(), 'repo-cache-copy-'));
    const src = join(root, 'sdk');
    mkdirSync(src);
    git(src, 'init', '-q', '-b', 'oh-3.41.9-dev');
    git(src, 'config', 'user.email', 't@t');
    git(src, 'config', 'user.name', 't');
    writeFileSync(join(src, 'a.txt'), 'a');
    git(src, 'add', '.');
    git(src, 'commit', '-qm', 'init');
    mkdirSync(join(src, '.git', 'worktrees', 'other'), { recursive: true });
    writeFileSync(join(src, '.git', 'index.lock'), '');
    writeFileSync(join(src, '.git', 'refs', 'heads', 'stale.lock'), '');
    return src;
  }

  it('leaves a repo shaped like git clone --no-checkout that can check out the branch', () => {
    const src = sourceRepo();
    const dest = join(root, 'repo');
    expect(copyGitDirCow(src, dest, plainCopy)).toEqual({ ok: true });
    for (const name of ['index', 'index.lock', 'worktrees', 'refs/heads/stale.lock']) {
      expect(existsSync(join(dest, '.git', name))).toBe(false);
    }
    expect(git(dest, 'rev-parse', 'HEAD')).toBe(git(src, 'rev-parse', 'HEAD'));
    git(dest, 'checkout', '-q', '-B', 'oh-3.41.9-dev');
    expect(existsSync(join(dest, 'a.txt'))).toBe(true);
    expect(existsSync(join(src, '.git', 'index'))).toBe(true);
  });

  it('reflinks on APFS', () => {
    if (process.platform !== 'darwin') return;
    const src = sourceRepo();
    expect(copyGitDirCow(src, join(root, 'repo')).ok).toBe(true);
  });

  it('either reflinks a usable repo or leaves nothing behind on the real filesystem', () => {
    const src = sourceRepo();
    const dest = join(root, 'repo');
    const result = copyGitDirCow(src, dest);
    if (result.ok) expect(git(dest, 'rev-parse', 'HEAD')).toBe(git(src, 'rev-parse', 'HEAD'));
    else expect(existsSync(dest)).toBe(false);
  });

  it('cleans up and reports failure when the filesystem cannot reflink', () => {
    const src = sourceRepo();
    const dest = join(root, 'repo');
    const result = copyGitDirCow(src, dest, () => { throw new Error('ENOTSUP: reflink'); });
    expect(result).toEqual({ ok: false, error: 'ENOTSUP: reflink' });
    expect(existsSync(dest)).toBe(false);
  });
});
