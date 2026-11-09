import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getWorkspaceRoot, resolveAceRuntimeRoot } from '@/lib/core/app-paths';
import { evalInputsDir } from '@/lib/workflow/diagnosis-script-step';
import { resolvePolicyPath } from '@/lib/workflow/pr-review-policy';
import { withFileLock } from '../scripts/file-lock.mjs';
import { programInvocation } from '../scripts/program-invocation.mjs';
import { resolveRuntimeRoot } from '../scripts/runtime-root.mjs';
import { rewritePrefixedText } from '../scripts/rewrite-sdk-root.mjs';
import { runLockedGit } from '../skills/cpf-ohos-issue-analysis/scripts/repo-cache.mjs';

const homes: string[] = [];
const previousHome = process.env.ACE_HOME;
afterEach(() => {
  if (previousHome === undefined) delete process.env.ACE_HOME;
  else process.env.ACE_HOME = previousHome;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('运行时根目录', () => {
  const cases = [
    {
      name: 'ACE_HOME 优先于平台默认目录',
      env: { ACE_HOME: 'D:\\ace-home', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', XDG_DATA_HOME: '/xdg' },
      platform: 'win32' as const,
      home: 'C:\\Users\\me',
      expected: 'D:\\ace-home',
    },
    {
      name: 'Windows 使用 APPDATA',
      env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', XDG_DATA_HOME: 'D:\\xdg' },
      platform: 'win32' as const,
      home: 'C:\\Users\\me',
      expected: 'C:\\Users\\me\\AppData\\Roaming\\ACEHarness',
    },
    {
      name: 'Linux 设置了 XDG_DATA_HOME 时不用家目录',
      env: { XDG_DATA_HOME: '/xdg/data', APPDATA: '/ignored' },
      platform: 'linux' as const,
      home: '/home/dev',
      expected: '/xdg/data/aceharness',
    },
    {
      name: 'macOS 默认家目录',
      env: { APPDATA: '/ignored' },
      platform: 'darwin' as const,
      home: '/Users/dev',
      expected: '/Users/dev/.aceharness',
    },
  ];

  it.each(cases)('$name', ({ env, platform, home, expected }) => {
    expect(resolveAceRuntimeRoot({ env, platform, home })).toBe(expected);
    expect(resolveRuntimeRoot({ env, platform, home })).toBe(expected);
  });

  it('当前进程上引擎和脚本算出同一个目录', () => {
    expect(getWorkspaceRoot()).toBe(resolveRuntimeRoot({
      env: process.env,
      platform: process.platform,
      home: homedir(),
    }));
  });

  it('快照目录和策略文件跟着 ACE_HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'ace-home-'));
    homes.push(home);
    process.env.ACE_HOME = home;
    expect(evalInputsDir()).toBe(join(home, 'eval-inputs'));
    expect(resolvePolicyPath()).toBe(join(home, 'configs', 'pr-review-policies.yaml'));
  });
});

describe('Windows 程序调用和 SDK 清单', () => {
  it('普通程序原样执行，bat 交给 cmd.exe', () => {
    expect(programInvocation('/sdk/bin/flutter', ['build', 'hap', '--debug'], 'darwin')).toEqual({
      file: '/sdk/bin/flutter',
      args: ['build', 'hap', '--debug'],
    });
    expect(programInvocation('C:\\sdk\\bin\\flutter.bat', ['build', 'hap', '--debug'], 'win32')).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\sdk\\bin\\flutter.bat build hap --debug"'],
    });
  });

  it('带空格的 bat 路径被引号包住', () => {
    const command = programInvocation('C:\\Program Files\\flutter.bat', ['build', 'hap'], 'win32');
    const inner = '"C:\\Program Files\\flutter.bat" build hap';
    expect(command.args[3]).toBe(`"${inner}"`);
  });

  it('改写 SDK 前缀并去掉 BOM', () => {
    const text = '\ufeffsdkRoot: /home/flutter/flutter-sdks\npath: /home/flutter/flutter-sdks/3.44.9-ohos\n';
    expect(rewritePrefixedText(text, '/home/flutter/flutter-sdks', 'D:/sdks')).toBe(
      'sdkRoot: D:/sdks\npath: D:/sdks/3.44.9-ohos\n',
    );
  });
});

describe('没有 flock 时的仓库锁', () => {
  it('flock 不存在时改用文件锁，并在结束后删除锁文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-lock-'));
    homes.push(dir);
    const lock = join(dir, 'locks', 'repo.lock');
    const result = runLockedGit(lock, ['status'], {
      platform: 'linux',
      execFileSync: () => {
        const error = new Error('spawn flock ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
      runGit: () => 'git-ok',
    });
    expect(result).toEqual({ ok: true, output: 'git-ok' });
    expect(() => readFileSync(lock)).toThrow();
  });

  it('本机没有 flock 时仍能串行执行 git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-lock-real-'));
    homes.push(dir);
    const result = runLockedGit(join(dir, 'repo.lock'), ['--version']);
    expect(result.ok).toBe(true);
    expect(String(result.output)).toMatch(/git version/);
  });

  it('锁被占用时超时', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-lock-busy-'));
    homes.push(dir);
    const lock = join(dir, 'busy.lock');
    expect(() => withFileLock(lock, () => {
      withFileLock(lock, () => undefined, { timeoutMs: -1, pollMs: 1, sleep: () => undefined });
    })).toThrow(/等待锁超时/);
  });
});

describe('安装脚本选择安装包', () => {
  const script = join(__dirname, '..', 'deploy', 'install.sh');

  function pick(explicit: string, dist: string): string {
    return execFileSync('bash', ['-c', 'ACE_INSTALL_LIBRARY=1 source "$1"; pick_tgz "$2" "$3"', 'bash', script, explicit, dist], {
      encoding: 'utf8',
    }).trim();
  }

  it('选 dist 里最新的 cpf-ohos-aceharness tgz，显式参数优先', () => {
    const dist = mkdtempSync(join(tmpdir(), 'ace-dist-'));
    homes.push(dist);
    const older = join(dist, 'cpf-ohos-aceharness-1.0.0-beta.90.tgz');
    const newer = join(dist, 'cpf-ohos-aceharness-1.0.0-beta.97.tgz');
    writeFileSync(older, '');
    writeFileSync(newer, '');
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    utimesSync(newer, new Date('2026-11-06T00:00:00Z'), new Date('2026-11-06T00:00:00Z'));
    expect(pick('', dist)).toBe(newer);
    expect(pick(older, dist)).toBe(older);
    mkdirSync(join(dist, 'empty'));
  });

  it('安装脚本把运行时目录交给 runtime-root，Windows 不再用 Set-Content 写清单', () => {
    const sh = readFileSync(script, 'utf8');
    const ps1 = readFileSync(join(__dirname, '..', 'deploy', 'install.ps1'), 'utf8');
    expect(sh).toContain('runtime-root.mjs');
    expect(sh).toContain('rewrite-sdk-root.mjs');
    expect(sh).not.toContain('cpf-ohos-aceharness-1.0.0-beta.90.tgz');
    expect(ps1).toContain('runtime-root.mjs');
    expect(ps1).toContain('rewrite-sdk-root.mjs');
    expect(ps1).toContain('ItemType Junction');
    expect(ps1).not.toContain('Set-Content');
    expect(ps1).not.toContain('cpf-ohos-aceharness-1.0.0-beta.90.tgz');
    execFileSync('bash', ['-n', script]);
  });
});
