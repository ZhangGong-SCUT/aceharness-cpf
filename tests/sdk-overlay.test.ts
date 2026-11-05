import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { createSdkOverlay, overlayFlutterBinForRun } from '../src/lib/workflow/sdk-overlay';

function makeSdkTree() {
  const root = mkdtempSync(join(tmpdir(), 'sdk-src-'));
  mkdirSync(join(root, 'bin', 'cache', 'artifacts', 'engine'), { recursive: true });
  mkdirSync(join(root, 'packages', 'flutter'), { recursive: true });
  writeFileSync(join(root, 'bin', 'flutter'), '#!/bin/sh\necho flutter\n');
  chmodSync(join(root, 'bin', 'flutter'), 0o755);
  writeFileSync(join(root, 'bin', 'cache', 'dart-sdk.version'), '3.7.0\n');
  writeFileSync(join(root, 'bin', 'cache', 'artifacts', 'engine', 'fixture'), 'placeholder');
  writeFileSync(join(root, 'packages', 'flutter', 'pubspec.yaml'), 'name: flutter\n');
  return root;
}

describe('createSdkOverlay（R08：run 级 SDK overlay）', () => {
  it('完整 SDK 独立复制，入口、packages 和 cache 均不触碰共享 SDK', () => {
    const src = makeSdkTree();
    const overlayDir = mkdtempSync(join(tmpdir(), 'sdk-overlay-'));
    const result = createSdkOverlay(src, overlayDir);

    // 包目录和启动器必须独立
    expect(lstatSync(join(result.sdkLink, 'packages')).isSymbolicLink()).toBe(false);
    expect(lstatSync(result.flutterBin!).isSymbolicLink()).toBe(false);
    writeFileSync(join(result.sdkLink, 'packages', 'flutter', 'pubspec.yaml'), 'changed');
    expect(readFileSync(join(src, 'packages', 'flutter', 'pubspec.yaml'), 'utf8')).toBe('name: flutter\n');
    // bin/cache 是真实目录
    expect(lstatSync(join(result.sdkLink, 'bin', 'cache')).isDirectory()).toBe(true);
    expect(lstatSync(join(result.sdkLink, 'bin', 'cache')).isSymbolicLink()).toBe(false);
    // cache 内文件落成实体副本（可原地改写而不影响共享）
    const copied = readFileSync(join(result.sdkLink, 'bin', 'cache', 'dart-sdk.version'), 'utf-8');
    expect(copied).toBe('3.7.0\n');
    // flutter 入口解析自 overlay
    expect(result.flutterBin).toBe(join(result.sdkLink, 'bin', 'flutter'));

    // 在 overlay 的 cache 里写入新文件 → 共享 SDK 无此文件
    writeFileSync(join(result.sdkLink, 'bin', 'cache', 'run-only.stamp'), 'x');
    expect(existsSync(join(src, 'bin', 'cache', 'run-only.stamp'))).toBe(false);
    // 修改 overlay 内 cache 副本 → 共享原文件不变
    writeFileSync(join(result.sdkLink, 'bin', 'cache', 'dart-sdk.version'), '9.9.9\n');
    expect(readFileSync(join(src, 'bin', 'cache', 'dart-sdk.version'), 'utf-8')).toBe('3.7.0\n');

    // 幂等：重复创建复用既有 overlay
    const again = createSdkOverlay(src, overlayDir);
    expect(again.sdkLink).toBe(result.sdkLink);
    expect(readFileSync(join(again.sdkLink, 'bin', 'cache', 'dart-sdk.version'), 'utf-8')).toBe('9.9.9\n');

    expect(overlayFlutterBinForRun(overlayDir)).toBe(result.flutterBin);
    rmSync(src, { recursive: true, force: true });
    rmSync(overlayDir, { recursive: true, force: true });
  });

  it('SDK 根目录不存在时抛错', () => {
    expect(() => createSdkOverlay('/no/such/sdk', mkdtempSync(join(tmpdir(), 'ov-')))).toThrow('不存在');
  });

  it('跳过指向 SDK 外面的 .agent-skills 链接，Flutter 自己的越界链接仍然拒绝', () => {
    const src = makeSdkTree();
    const skill = join(dirname(src), `harness-${basename(src)}`, 'cpf-ohos-issue-analysis');
    const linkDir = join(src, '.agent-skills', 'private');
    mkdirSync(skill, { recursive: true });
    mkdirSync(linkDir, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), 'skill');
    symlinkSync(relative(linkDir, skill), join(linkDir, 'cpf-ohos-issue-analysis'));
    const overlayDir = mkdtempSync(join(tmpdir(), 'sdk-overlay-skills-'));
    const result = createSdkOverlay(src, overlayDir);
    expect(result.flutterBin).toBe(join(result.sdkLink, 'bin', 'flutter'));
    expect(existsSync(join(result.sdkLink, '.agent-skills'))).toBe(false);
    expect(existsSync(join(linkDir, 'cpf-ohos-issue-analysis'))).toBe(true);

    symlinkSync(skill, join(src, 'bin', 'outside-skill'));
    const badOverlay = mkdtempSync(join(tmpdir(), 'sdk-overlay-bad-'));
    expect(() => createSdkOverlay(src, badOverlay)).toThrow('越出');
    rmSync(src, { recursive: true, force: true });
    rmSync(overlayDir, { recursive: true, force: true });
    rmSync(badOverlay, { recursive: true, force: true });
    rmSync(dirname(skill), { recursive: true, force: true });
  });

  it('跳过越界的 AGENTS.md 和 Xcode 预编译链接，其他越界链接仍然拒绝', () => {
    const src = makeSdkTree();
    const outside = dirname(src);
    const guidance = join(outside, `guidance-${basename(src)}`, 'AGENTS.md');
    const xcodeSdk = join(outside, `xcode-${basename(src)}`, 'Xcode.app', 'Contents', 'Developer', 'Platforms', 'MacOSX.platform');
    const stray = join(outside, `stray-${basename(src)}`);
    mkdirSync(dirname(guidance), { recursive: true });
    mkdirSync(xcodeSdk, { recursive: true });
    mkdirSync(stray, { recursive: true });
    writeFileSync(guidance, 'guidance');
    writeFileSync(join(xcodeSdk, 'SDKSettings.json'), '{}');
    writeFileSync(join(stray, 'lib'), 'x');
    writeFileSync(join(src, 'packages', 'flutter', 'AGENTS.md'), 'flutter-own\n');

    const ci = join(src, 'ci');
    const prebuilts = join(src, 'engine', 'src', 'flutter', 'prebuilts', 'SDKs');
    mkdirSync(ci, { recursive: true });
    mkdirSync(prebuilts, { recursive: true });
    symlinkSync(relative(ci, guidance), join(ci, 'AGENTS.md'));
    symlinkSync(xcodeSdk, join(prebuilts, 'MacOSX.sdk'));

    const overlayDir = mkdtempSync(join(tmpdir(), 'sdk-overlay-agents-'));
    const result = createSdkOverlay(src, overlayDir);
    expect(result.flutterBin).toBe(join(result.sdkLink, 'bin', 'flutter'));
    expect(existsSync(join(result.sdkLink, 'ci', 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(result.sdkLink, 'engine', 'src', 'flutter', 'prebuilts', 'SDKs', 'MacOSX.sdk'))).toBe(false);
    expect(readFileSync(join(result.sdkLink, 'packages', 'flutter', 'AGENTS.md'), 'utf8')).toBe('flutter-own\n');
    expect(existsSync(join(ci, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(prebuilts, 'MacOSX.sdk'))).toBe(true);

    symlinkSync(stray, join(prebuilts, 'not-xcode'));
    const badOverlay = mkdtempSync(join(tmpdir(), 'sdk-overlay-prebuilt-bad-'));
    expect(() => createSdkOverlay(src, badOverlay)).toThrow('越出');

    rmSync(src, { recursive: true, force: true });
    rmSync(overlayDir, { recursive: true, force: true });
    rmSync(badOverlay, { recursive: true, force: true });
    rmSync(dirname(guidance), { recursive: true, force: true });
    rmSync(join(outside, `xcode-${basename(src)}`), { recursive: true, force: true });
    rmSync(stray, { recursive: true, force: true });
  });
});

describe('ohos-har-install 门禁脚本（R08）', () => {
  const SCRIPT = join(__dirname, '..', 'scripts', 'ohos-har-install.mjs');

  function makeHar(dir: string, name: string, profile: string): string {
    mkdirSync(join(dir, 'package'), { recursive: true });
    writeFileSync(join(dir, 'package', 'BuildProfile.ets'), profile);
    execFileSync('tar', ['-czf', join(dir, name), '-C', dir, 'package/BuildProfile.ets']);
    return join(dir, name);
  }
  const RELEASE_PROFILE = "export const BUILD_MODE_NAME = 'release';\nexport const DEBUG = false;\nexport const TARGET_NAME = 'default';\n";
  const DEBUG_PROFILE = "export const BUILD_MODE_NAME = 'debug';\nexport const DEBUG = true;\nexport const TARGET_NAME = 'default';\n";

  it('release HAR + expected release → gate passed（check-only 不安装）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'har-fixture-'));
    const har = makeHar(dir, 'app.har', RELEASE_PROFILE);
    const recordPath = join(dir, 'record.json');
    const out = execFileSync(process.execPath, [SCRIPT, '--har', har, '--expected-mode', 'release',
      '--expect-path-prefix', dir, '--check-only', '--record', recordPath], { encoding: 'utf-8' });
    const record = JSON.parse(out);
    expect(record.gate).toBe('passed');
    expect(record.build_mode).toBe('release');
    expect(record.installed).toBe(false);
    // 记录文件落盘
    expect(JSON.parse(readFileSync(recordPath, 'utf-8')).gate).toBe('passed');
    rmSync(dir, { recursive: true, force: true });
  });

  it('debug HAR + expected release → 拒绝（exit 2，不写安装）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'har-fixture-'));
    const har = makeHar(dir, 'app.har', DEBUG_PROFILE);
    let code = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [SCRIPT, '--har', har, '--expected-mode', 'release', '--check-only'], { encoding: 'utf-8' });
    } catch (e: any) {
      code = e.status;
      stderr = String(e.stderr || '');
    }
    expect(code).toBe(2);
    expect(stderr).toContain('构建模式不符');
    rmSync(dir, { recursive: true, force: true });
  });

  it('HAR 不在预期产物目录内 → 拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'har-fixture-'));
    const har = makeHar(dir, 'app.har', RELEASE_PROFILE);
    let code = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [SCRIPT, '--har', har, '--expected-mode', 'release',
        '--expect-path-prefix', join(dir, 'other'), '--check-only'], { encoding: 'utf-8' });
    } catch (e: any) {
      code = e.status;
      stderr = String(e.stderr || '');
    }
    expect(code).toBe(2);
    expect(stderr).toContain('预期产物目录');
    rmSync(dir, { recursive: true, force: true });
  });

  it('缺失 BuildProfile 的 HAR → 拒绝而不是放行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'har-fixture-'));
    writeFileSync(join(dir, 'dummy.txt'), 'x');
    execFileSync('tar', ['-czf', join(dir, 'bad.har'), '-C', dir, 'dummy.txt']);
    let code = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [SCRIPT, '--har', join(dir, 'bad.har'), '--expected-mode', 'release', '--check-only'], { encoding: 'utf-8' });
    } catch (e: any) {
      code = e.status;
      stderr = String(e.stderr || '');
    }
    expect(code).toBe(2);
    expect(stderr).toContain('无法解析 BuildProfile');
    rmSync(dir, { recursive: true, force: true });
  });
});
