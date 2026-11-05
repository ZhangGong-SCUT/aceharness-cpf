import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'vitest';
import {
  extractBaseBranch,
  extractRepoBranch,
  extractVersionHint,
  parseOhosFlutterSdkInventory,
  readRepoBranchFromDisk,
  resolveOhosFlutterSdk,
} from '@/lib/workflow/ohos-flutter-sdk';
import { enforceFixVerificationGoldenFlag } from '@/lib/state-machine/utils';

function fakeSdk(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `ohos-sdk-${name}-`));
  mkdirSync(join(root, 'bin', 'cache', 'artifacts', 'engine', 'ohos-arm64'), { recursive: true });
  writeFileSync(join(root, 'bin', 'flutter.bat'), '@echo off\n');
  writeFileSync(join(root, 'bin', 'cache', 'artifacts', 'engine', 'ohos-arm64', 'libflutter.so'), '');
  return root;
}

describe('ohos flutter sdk inventory', () => {
  test('extracts branch from collector JSON and markdown', () => {
    expect(extractRepoBranch('{"branch":"oh-3.35.7-release","commit":"abc"}')).toBe('oh-3.35.7-release');
    expect(extractRepoBranch('branch: `oh-3.41.9-dev`')).toBe('oh-3.41.9-dev');
    expect(extractRepoBranch('{"branch":"missing"}')).toBeNull();
    expect(extractVersionHint('oh-3.35.7-release')).toBe('3.35.7');
  });

  test('extracts branch from Chinese prose conclusion (issue #2721 regression)', () => {
    // step-conclusion 散文格式：「- 分支 dev（branch_source=default_branch，Issue 无版本号）」
    expect(extractRepoBranch('- 分支 dev（branch_source=default_branch，Issue 无版本号）；framework HEAD=6d56736')).toBe('dev');
    expect(extractRepoBranch('- 分支：oh-3.41.9-dev')).toBe('oh-3.41.9-dev');
    // 行中非行首的「分支」不误报
    expect(extractRepoBranch('### 优先级 3：使用默认分支 dev（团队日常开发分支）')).toBeNull();
    expect(extractRepoBranch('engine 仓分支与 framework 同名，无同名分支回退 dev')).toBeNull();
  });

  test('reads attached HEAD from repo/.git', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ohos-repo-'));
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/oh-3.35.7-release\n');
    expect(readRepoBranchFromDisk(repo)).toBe('oh-3.35.7-release');
  });

  test('matches branch alias to a usable SDK and never falls back to daily', () => {
    const sdk335 = fakeSdk('335');
    const daily = fakeSdk('327');
    const inventory = parseOhosFlutterSdkInventory(`
dailySdk: ${daily.replace(/\\/g, '/')}
sdks:
  - id: 3.27.5-ohos
    version: 3.27.5
    aliases: [oh-3.27]
    path: ${daily.replace(/\\/g, '/')}
  - id: 3.35.7-ohos
    version: 3.35.7
    aliases: [oh-3.35.7-release, oh-3.35.7]
    path: ${sdk335.replace(/\\/g, '/')}
`);
    const resolved = resolveOhosFlutterSdk({
      branch: 'oh-3.35.7-release',
      inventory,
    });
    expect(resolved.matched).toBe(true);
    expect(resolved.sdkId).toBe('3.35.7-ohos');
    expect(resolved.flutterBin).toContain('flutter');
    expect(resolved.dailySdk).toBeTruthy();
    expect(resolved.sdkRoot).not.toBe(resolved.dailySdk);
  });

  test('unmatched branch stays unmatched instead of using daily SDK', () => {
    const daily = fakeSdk('327');
    const inventory = parseOhosFlutterSdkInventory(`
dailySdk: ${daily.replace(/\\/g, '/')}
sdks:
  - id: 3.27.5-ohos
    version: 3.27.5
    aliases: [oh-3.27]
    path: ${daily.replace(/\\/g, '/')}
`);
    const resolved = resolveOhosFlutterSdk({
      branch: 'oh-3.41.9-dev',
      inventory,
    });
    expect(resolved.matched).toBe(false);
    expect(resolved.flutterBin).toBeNull();
    expect(resolved.reason).toContain('禁止改用日常 SDK');
  });

  test('extracts base_ref from collector JSON and markdown', () => {
    expect(extractBaseBranch('{"base_ref":"oh-3.35.7-dev"}')).toBe('oh-3.35.7-dev');
    expect(extractBaseBranch('base_ref: `oh-3.44.9-dev`')).toBe('oh-3.44.9-dev');
    expect(extractBaseBranch('branch: oh-3.35.7-dev')).toBeNull();
  });

  test('feature branch without version hint falls back to base branch (pixelmapPurgeableFinal)', () => {
    const sdk335 = fakeSdk('335');
    const inventory = parseOhosFlutterSdkInventory(`
sdks:
  - id: 3.35.7-ohos
    version: 3.35.7
    aliases: [oh-3.35.7-dev, oh-3.35.7]
    path: ${sdk335.replace(/\\/g, '/')}
`);
    const resolved = resolveOhosFlutterSdk({
      branch: 'pixelmapPurgeableFinal',
      fallbackBranch: 'oh-3.35.7-dev',
      inventory,
    });
    expect(resolved.matched).toBe(true);
    expect(resolved.sdkId).toBe('3.35.7-ohos');
    expect(resolved.reason).toContain('base 分支');
  });

  test('primary branch match takes precedence over fallback', () => {
    const sdk335 = fakeSdk('335');
    const sdk344 = fakeSdk('344');
    const inventory = parseOhosFlutterSdkInventory(`
sdks:
  - id: 3.35.7-ohos
    version: 3.35.7
    aliases: [oh-3.35.7-dev]
    path: ${sdk335.replace(/\\/g, '/')}
  - id: 3.44.9-ohos
    version: 3.44.9
    aliases: [oh-3.44.9-dev]
    path: ${sdk344.replace(/\\/g, '/')}
`);
    const resolved = resolveOhosFlutterSdk({
      branch: 'plugin_restore_3.44',
      fallbackBranch: 'oh-3.35.7-dev',
      inventory,
    });
    expect(resolved.matched).toBe(true);
    expect(resolved.sdkId).toBe('3.44.9-ohos');
    expect(resolved.reason).not.toContain('base 分支');
  });

  test('no hint and no matching fallback stays unmatched', () => {
    const sdk335 = fakeSdk('335');
    const inventory = parseOhosFlutterSdkInventory(`
sdks:
  - id: 3.35.7-ohos
    version: 3.35.7
    aliases: [oh-3.35.7-dev]
    path: ${sdk335.replace(/\\/g, '/')}
`);
    const resolved = resolveOhosFlutterSdk({
      branch: 'pixelmapPurgeableFinal',
      fallbackBranch: 'some-random-base',
      inventory,
    });
    expect(resolved.matched).toBe(false);
    expect(resolved.reason).toContain('禁止改用日常 SDK');
  });

  test('fix verification cannot pass when inventory did not match', () => {
    const output = '{"verdict":"pass","run_verification":{"issue_golden_flag_met":true,"engine_aligned":true}}';
    const ctx = { stateName: '修复验证', stepId: 'verify-fix', sdkMatched: false };
    expect(enforceFixVerificationGoldenFlag(output, 'pass', ctx)).toBe('conditional_pass');
  });
});
