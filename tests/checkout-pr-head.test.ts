import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutPrHead, matchSdkRepo, shallowCloneArgs } from '../skills/gitcode-pr-review/scripts/checkout-pr-head.mjs';

const roots: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ace-checkout-'));
  roots.push(dir);
  return dir;
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.email=ace@example.com', '-c', 'user.name=ace', ...args], {
    encoding: 'utf8',
  }).trim();
}

function initRepo(dir: string) {
  git(dir, ['init', '-b', 'oh-3.35.7-release']);
  writeFileSync(join(dir, 'README'), 'base\n');
  git(dir, ['add', 'README']);
  git(dir, ['commit', '-m', 'base']);
  git(dir, ['checkout', '-b', 'feat/widget-tap-path-text']);
  writeFileSync(join(dir, 'README'), 'head\n');
  git(dir, ['commit', '-am', 'head']);
  return git(dir, ['rev-parse', 'HEAD']);
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('checkout-pr-head', () => {
  it('浅克隆参数必须带 depth 和 branch', () => {
    expect(shallowCloneArgs('https://gitcode.com/a/b.git', 'feat', '/tmp/repo')).toEqual([
      'clone', '--depth', '1', '--branch', 'feat', '--single-branch', 'https://gitcode.com/a/b.git', '/tmp/repo',
    ]);
    expect(() => shallowCloneArgs('https://gitcode.com/a/b.git', '', '/tmp/repo')).toThrow(/分支/);
  });

  it('按 base_ref 别名命中清单', () => {
    const match = matchSdkRepo([
      { id: '3.35.7-ohos', path: '/sdk', aliases: ['oh-3.35.7-release'] },
    ], 'oh-3.35.7-release');
    expect(match?.path).toBe('/sdk');
  });

  it('本地提交已是 head_sha 时不 fetch，只用 worktree', () => {
    const root = tempDir();
    const source = join(root, 'sdk');
    const run = join(root, 'run');
    execFileSync('mkdir', ['-p', source, run]);
    const sha = initRepo(source);
    git(source, ['checkout', 'oh-3.35.7-release']);
    const result = checkoutPrHead({
      sourcePath: source,
      runDir: run,
      baseRef: 'oh-3.35.7-release',
      headRef: 'feat/widget-tap-path-text',
      headSha: sha,
      headRepo: 'z2036709353/flutter_flutter',
      forkUrl: 'https://invalid.example/no-fetch.git',
    });
    expect(result.fetched).toBe(false);
    expect(result.cloned).toBe(false);
    expect(result.mode).toBe('worktree');
    expect(result.head).toBe(sha);
    expect(result.direct_push).toBe(false);
  });

  it('对不上时只从 myfork 取该分支，不整仓克隆进 run', () => {
    const root = tempDir();
    const source = join(root, 'sdk');
    const fork = join(root, 'fork.git');
    const run = join(root, 'run');
    execFileSync('mkdir', ['-p', source, run]);
    execFileSync('git', ['init', '--bare', '-b', 'feat/widget-tap-path-text', fork]);
    const sha = initRepo(source);
    git(source, ['remote', 'add', 'myfork', fork]);
    git(source, ['push', 'myfork', 'feat/widget-tap-path-text']);
    git(source, ['checkout', 'oh-3.35.7-release']);
    git(source, ['update-ref', '-d', 'refs/heads/feat/widget-tap-path-text']);
    const result = checkoutPrHead({
      sourcePath: source,
      runDir: run,
      baseRef: 'oh-3.35.7-release',
      headRef: 'feat/widget-tap-path-text',
      headSha: sha,
      headRepo: 'z2036709353/flutter_flutter',
      forkUrl: fork,
    });
    expect(result.cloned).toBe(false);
    expect(result.fetched).toBe(true);
    expect(result.head).toBe(sha);
    expect(result.repo).toBe(join(run, 'repo'));
  });
});
