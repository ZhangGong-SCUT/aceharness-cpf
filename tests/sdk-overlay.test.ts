import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import {
  createSdkOverlay, overlayFlutterBinForRun, preserveSnapshotLink, removeSdkOverlaySnapshot,
  SDK_OVERLAY_SHARED_LINKS, sweepEndedRunSdkOverlays,
} from '../src/lib/workflow/sdk-overlay';

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
    const prebuilts = join(src, 'dev', 'prebuilts', 'SDKs');
    mkdirSync(ci, { recursive: true });
    mkdirSync(prebuilts, { recursive: true });
    symlinkSync(relative(ci, guidance), join(ci, 'AGENTS.md'));
    symlinkSync(xcodeSdk, join(prebuilts, 'MacOSX.sdk'));

    const overlayDir = mkdtempSync(join(tmpdir(), 'sdk-overlay-agents-'));
    const result = createSdkOverlay(src, overlayDir);
    expect(result.flutterBin).toBe(join(result.sdkLink, 'bin', 'flutter'));
    expect(existsSync(join(result.sdkLink, 'ci', 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(result.sdkLink, 'dev', 'prebuilts', 'SDKs', 'MacOSX.sdk'))).toBe(false);
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

  it('保留 SDK 内部的相对断链，越出根目录的断链仍然拒绝', () => {
    const src = makeSdkTree();
    const dir = join(src, 'dev', 'third_party', 'libcxx_ohos', 'test', 'std');
    mkdirSync(dir, { recursive: true });
    symlinkSync('../../../pstl/test/std', join(dir, 'pstl'));
    const overlayDir = mkdtempSync(join(tmpdir(), 'sdk-overlay-dangling-'));
    const result = createSdkOverlay(src, overlayDir);
    const copied = join(result.sdkLink, 'dev', 'third_party', 'libcxx_ohos', 'test', 'std', 'pstl');
    expect(lstatSync(copied).isSymbolicLink()).toBe(true);
    expect(readlinkSync(copied)).toBe('../../../pstl/test/std');

    symlinkSync('../../../../../../missing-outside', join(src, 'bin', 'escape'));
    const badOverlay = mkdtempSync(join(tmpdir(), 'sdk-overlay-dangling-bad-'));
    expect(() => createSdkOverlay(src, badOverlay)).toThrow('越出');

    rmSync(src, { recursive: true, force: true });
    rmSync(overlayDir, { recursive: true, force: true });
    rmSync(badOverlay, { recursive: true, force: true });
  });

  it('P9：包缓存路径内的越界断链（@ohos/flutter_ohos）被跳过，不阻断 overlay', () => {
    const src = makeSdkTree();
    // 模拟 ohpm 写进 SDK 树、指向已清理工作区的 @ohos/flutter_ohos 断链。
    const linkDir = join(src, 'packages', 'integration_test', 'ohos', 'oh_modules', '@ohos');
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(
      '../../../../../../../../.aceharness/run-workspaces/run-dead/demo/ohos/oh_modules/.ohpm/@ohos+flutter_ohos@x/oh_modules/@ohos/flutter_ohos',
      join(linkDir, 'flutter_ohos'),
    );
    const overlayDir = mkdtempSync(join(tmpdir(), 'sdk-overlay-pkgcache-'));
    // 越界断链位于 oh_modules 包缓存路径内 → 跳过，overlay 成功，不抛「越出」。
    const result = createSdkOverlay(src, overlayDir);
    expect(existsSync(join(result.sdkLink, 'bin', 'flutter'))).toBe(true);
    // 该断链未被复制进副本。
    expect(existsSync(join(result.sdkLink, 'packages', 'integration_test', 'ohos', 'oh_modules', '@ohos', 'flutter_ohos'))).toBe(false);
    rmSync(src, { recursive: true, force: true });
    rmSync(overlayDir, { recursive: true, force: true });
  });

  it('P9：包缓存路径外的越界断链仍抛错（保护边界）', () => {
    const src = makeSdkTree();
    // 同样的越界断链，但放在 lib/ 而非 oh_modules 内 → 仍视为非法越界。
    mkdirSync(join(src, 'lib'), { recursive: true });
    symlinkSync('../../../../../../missing-outside', join(src, 'lib', 'escape'));
    const overlayDir = mkdtempSync(join(tmpdir(), 'sdk-overlay-noncache-'));
    expect(() => createSdkOverlay(src, overlayDir)).toThrow('越出');
    rmSync(src, { recursive: true, force: true });
    rmSync(overlayDir, { recursive: true, force: true });
  });
});

function makeGitSdkTree() {
  const root = makeSdkTree();
  mkdirSync(join(root, 'engine', 'src', 'out'), { recursive: true });
  writeFileSync(join(root, 'engine', 'src', 'out', 'libflutter.so'), 'engine-build');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(root, 'bin', 'internal'));
  writeFileSync(join(root, 'bin', 'internal', 'engine.version'), 'abc\n');
  mkdirSync(join(root, 'packages', 'flutter_tools', '.dart_tool'), { recursive: true });
  writeFileSync(join(root, 'packages', 'flutter_tools', 'pubspec.lock'), 'lock\n');
  writeFileSync(join(root, 'packages', 'flutter_tools', '.dart_tool', 'package_config.json'), '{}');
  const har = join(root, 'bin', 'cache', 'artifacts', 'engine', 'ohos-arm64', 'flutter_embedding_release.har');
  mkdirSync(dirname(har), { recursive: true });
  writeFileSync(har, 'stock-har');
  writeFileSync(join(root, 'version'), '3.41.9\n');
  return { root, har };
}

const runOverlay = (prefix: string) => join(mkdtempSync(join(tmpdir(), prefix)), 'run-x', 'sdk-overlay');

describe('createSdkOverlay v3：只链接 .git 和 engine/', () => {
  it('.git、engine/ 链回共享 SDK，其余全部是独立副本', () => {
    const { root } = makeGitSdkTree();
    const overlayDir = runOverlay('sdk-v3-');
    const result = createSdkOverlay(root, overlayDir);
    for (const name of SDK_OVERLAY_SHARED_LINKS) {
      expect(lstatSync(join(result.sdkLink, name)).isSymbolicLink(), name).toBe(true);
      expect(realpathSync(join(result.sdkLink, name))).toBe(realpathSync(join(root, name)));
    }
    expect(readFileSync(join(result.sdkLink, 'engine', 'src', 'out', 'libflutter.so'), 'utf8')).toBe('engine-build');
    for (const rel of ['bin', 'bin/cache', 'bin/internal', 'packages', 'packages/flutter', 'packages/flutter_tools/.dart_tool']) {
      expect(lstatSync(join(result.sdkLink, rel)).isSymbolicLink(), rel).toBe(false);
    }
    for (const rel of ['version', 'packages/flutter_tools/pubspec.lock', 'bin/internal/engine.version']) {
      writeFileSync(join(result.sdkLink, rel), 'run-write');
      expect(readFileSync(join(root, rel), 'utf8'), rel).not.toBe('run-write');
    }
    const manifest = JSON.parse(readFileSync(join(overlayDir, 'overlay-manifest.json'), 'utf8'));
    expect(manifest.version).toBe(3);
    expect(manifest.linkedReadOnly.sort()).toEqual(['.git', 'engine']);
    expect(manifest.copyMethod).toBe(process.platform === 'darwin' ? 'clonefile' : 'copy');
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(dirname(overlayDir)), { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('bin/flutter 按自身真实路径推出的 FLUTTER_ROOT 落在本 run 副本', () => {
    const { root } = makeGitSdkTree();
    writeFileSync(join(root, 'bin', 'flutter'), '#!/bin/sh\ncd "$(dirname "$0")/.." && pwd -P\n');
    chmodSync(join(root, 'bin', 'flutter'), 0o755);
    const overlayDir = runOverlay('sdk-root-');
    const result = createSdkOverlay(root, overlayDir);
    expect(execFileSync(result.flutterBin!, { encoding: 'utf8' }).trim()).toBe(realpathSync(result.sdkLink));
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(dirname(overlayDir)), { recursive: true, force: true });
  });

  it('两个 run 各自盖 HAR，共享 SDK 和对方都不变', () => {
    const { root, har } = makeGitSdkTree();
    const relHar = relative(root, har);
    const a = createSdkOverlay(root, runOverlay('sdk-har-a-'));
    const b = createSdkOverlay(root, runOverlay('sdk-har-b-'));
    writeFileSync(join(a.sdkLink, relHar), 'fixed-har-a');
    expect(readFileSync(har, 'utf8')).toBe('stock-har');
    expect(readFileSync(join(b.sdkLink, relHar), 'utf8')).toBe('stock-har');
    writeFileSync(join(a.sdkLink, 'packages', 'flutter', 'pubspec.yaml'), 'patched framework');
    expect(readFileSync(join(b.sdkLink, 'packages', 'flutter', 'pubspec.yaml'), 'utf8')).toBe('name: flutter\n');
    rmSync(root, { recursive: true, force: true });
    for (const r of [a, b]) rmSync(dirname(dirname(r.overlayDir)), { recursive: true, force: true });
  });

  it('Windows 用 junction 链接目录；链接失败时退回复制并记入清单', () => {
    const { root } = makeGitSdkTree();
    const calls: Array<[string, string | undefined]> = [];
    const junction = ((target: string, path: string, type?: string) => {
      calls.push([basename(path), type]);
      symlinkSync(target, path);
    }) as typeof symlinkSync;
    const ok = createSdkOverlay(root, runOverlay('sdk-win-'), { platform: 'win32', clone: false, link: junction });
    expect(calls.sort()).toEqual([['.git', 'junction'], ['engine', 'junction']]);
    expect(realpathSync(join(ok.sdkLink, 'engine'))).toBe(realpathSync(join(root, 'engine')));

    const refused = (() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }) as typeof symlinkSync;
    const copied = createSdkOverlay(root, runOverlay('sdk-win-fallback-'), { platform: 'win32', clone: false, link: refused });
    expect(lstatSync(join(copied.sdkLink, 'engine')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(copied.sdkLink, 'engine', 'src', 'out', 'libflutter.so'), 'utf8')).toBe('engine-build');
    const manifest = JSON.parse(readFileSync(join(copied.overlayDir, 'overlay-manifest.json'), 'utf8'));
    expect(manifest.linkFallbackCopies.sort()).toEqual(['.git', 'engine']);
    rmSync(root, { recursive: true, force: true });
    for (const r of [ok, copied]) rmSync(dirname(dirname(r.overlayDir)), { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'darwin')('macOS 克隆后仍重写内部绝对链接、去掉 Agent 挂载、拒绝越界链接', () => {
    const { root } = makeGitSdkTree();
    symlinkSync(join(root, 'packages', 'flutter', 'pubspec.yaml'), join(root, 'packages', 'abs-link'));
    mkdirSync(join(root, 'packages', 'flutter', '.agents'), { recursive: true });
    writeFileSync(join(root, 'packages', 'flutter', '.agents', 'x'), 'skill');
    const overlayDir = runOverlay('sdk-clone-');
    const result = createSdkOverlay(root, overlayDir, { clone: true });
    expect(realpathSync(join(result.sdkLink, 'packages', 'abs-link')))
      .toBe(join(realpathSync(result.sdkLink), 'packages', 'flutter', 'pubspec.yaml'));
    expect(existsSync(join(result.sdkLink, 'packages', 'flutter', '.agents'))).toBe(false);

    const outside = mkdtempSync(join(tmpdir(), 'sdk-outside-'));
    symlinkSync(outside, join(root, 'packages', 'escape'));
    const bad = runOverlay('sdk-clone-bad-');
    expect(() => createSdkOverlay(root, bad, { clone: true })).toThrow('越出');
    expect(existsSync(join(bad, 'sdk'))).toBe(false);
    for (const dir of [root, outside, dirname(dirname(overlayDir)), dirname(dirname(bad))]) rmSync(dir, { recursive: true, force: true });
  });

  it('磁盘不够时拒绝创建，不留半成品', () => {
    const { root } = makeGitSdkTree();
    const overlayDir = runOverlay('sdk-disk-');
    expect(() => createSdkOverlay(root, overlayDir, { clone: false, freeBytes: () => 0, minFreeBytes: 0 })).toThrow('磁盘剩余');
    expect(existsSync(join(overlayDir, 'sdk'))).toBe(false);
    expect(existsSync(join(overlayDir, 'overlay-manifest.json'))).toBe(false);
    expect(createSdkOverlay(root, overlayDir, { clone: false, freeBytes: () => 1024 ** 4, minFreeBytes: 0 }).flutterBin).toBeTruthy();
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(dirname(overlayDir)), { recursive: true, force: true });
  });

  it('沿用 v2 整份复制的旧副本', () => {
    const src = makeSdkTree();
    const overlayDir = runOverlay('sdk-v2-');
    mkdirSync(join(overlayDir, 'sdk', 'bin'), { recursive: true });
    writeFileSync(join(overlayDir, 'sdk', 'bin', 'flutter'), 'old');
    writeFileSync(join(overlayDir, 'overlay-manifest.json'), JSON.stringify({ version: 2, sdkRoot: realpathSync(src), entries: 1 }));
    expect(createSdkOverlay(src, overlayDir).flutterBin).toBe(join(overlayDir, 'sdk', 'bin', 'flutter'));
    rmSync(src, { recursive: true, force: true });
    rmSync(dirname(dirname(overlayDir)), { recursive: true, force: true });
  });
});

describe('清理 SDK 副本', () => {
  it('只删 sdk/、清单和半成品，不跟进链接删共享 SDK；删后可在原路径重建', async () => {
    const { root } = makeGitSdkTree();
    const overlayDir = runOverlay('sdk-rm-');
    mkdirSync(join(overlayDir, 'har-cache'), { recursive: true });
    writeFileSync(join(overlayDir, 'har-cache', 'built.har'), 'keep');
    mkdirSync(join(overlayDir, '.snapshot-left'));
    const first = createSdkOverlay(root, overlayDir);
    expect(await removeSdkOverlaySnapshot(overlayDir)).toBe(true);
    expect(existsSync(join(overlayDir, 'sdk'))).toBe(false);
    expect(existsSync(join(overlayDir, 'overlay-manifest.json'))).toBe(false);
    expect(existsSync(join(overlayDir, '.snapshot-left'))).toBe(false);
    expect(readFileSync(join(overlayDir, 'har-cache', 'built.har'), 'utf8')).toBe('keep');
    expect(readFileSync(join(root, 'engine', 'src', 'out', 'libflutter.so'), 'utf8')).toBe('engine-build');
    expect(readFileSync(join(root, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
    expect(await removeSdkOverlaySnapshot(overlayDir)).toBe(false);
    expect(createSdkOverlay(root, overlayDir).flutterBin).toBe(first.flutterBin);
    unlinkSync(join(overlayDir, 'overlay-manifest.json'));
    expect(createSdkOverlay(root, overlayDir).flutterBin).toBe(first.flutterBin);
    expect(readFileSync(join(overlayDir, 'overlay-manifest.json'), 'utf8')).toContain(realpathSync(root));
    await expect(removeSdkOverlaySnapshot(root)).rejects.toThrow('sdk-overlay');
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(dirname(overlayDir)), { recursive: true, force: true });
  });

  it('启动清扫只处理已结束的 run', async () => {
    const { root } = makeGitSdkTree();
    const runsDir = mkdtempSync(join(tmpdir(), 'sdk-sweep-'));
    const status: Record<string, string | null> = {
      'run-done': 'completed', 'run-failed': 'failed', 'run-stopped': 'stopped', 'run-crashed': 'crashed',
      'run-live': 'running', 'run-unknown': null,
    };
    for (const id of Object.keys(status)) createSdkOverlay(root, join(runsDir, id, 'sdk-overlay'));
    mkdirSync(join(runsDir, 'run-no-overlay'));
    const removed = await sweepEndedRunSdkOverlays(runsDir, async (id) => status[id] ?? null);
    expect(removed.sort()).toEqual(['run-crashed', 'run-done', 'run-failed', 'run-stopped']);
    expect(existsSync(join(runsDir, 'run-live', 'sdk-overlay', 'sdk', 'bin', 'flutter'))).toBe(true);
    expect(existsSync(join(runsDir, 'run-unknown', 'sdk-overlay', 'sdk', 'bin', 'flutter'))).toBe(true);
    expect(existsSync(join(root, 'engine', 'src', 'out', 'libflutter.so'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('同时清理精确版本对齐副本 aligned-sdk（含 worktree 指针），保留 har-cache', async () => {
    const { root } = makeGitSdkTree();
    const overlayDir = runOverlay('sdk-aligned-rm-');
    mkdirSync(join(overlayDir, 'har-cache'), { recursive: true });
    writeFileSync(join(overlayDir, 'har-cache', 'built.har'), 'keep');
    createSdkOverlay(root, overlayDir);
    // 模拟对齐副本：独立目录 + .git 指针文件（指向共享仓 worktrees 登记）。
    const aligned = join(overlayDir, 'aligned-sdk');
    mkdirSync(join(aligned, 'bin', 'cache'), { recursive: true });
    writeFileSync(join(aligned, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'aligned-sdk')}\n`);
    writeFileSync(join(aligned, 'bin', 'cache', 'marker'), 'aligned');
    expect(existsSync(aligned)).toBe(true);
    // 删除应连 aligned-sdk 一起清掉
    expect(await removeSdkOverlaySnapshot(overlayDir)).toBe(true);
    expect(existsSync(join(overlayDir, 'sdk'))).toBe(false);
    expect(existsSync(aligned)).toBe(false);
    expect(readFileSync(join(overlayDir, 'har-cache', 'built.har'), 'utf8')).toBe('keep');
    // 共享 SDK 本体不受影响
    expect(readFileSync(join(root, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(dirname(overlayDir)), { recursive: true, force: true });
  });
});

describe('preserveSnapshotLink', () => {
  it('符号链接被拒绝时复制成实体文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-link-fallback-'));
    const source = join(dir, 'origin.txt');
    const destination = join(dir, 'copy.txt');
    writeFileSync(source, 'payload');
    preserveSnapshotLink(destination, 'origin.txt', source, () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    expect(lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(readFileSync(destination, 'utf8')).toBe('payload');
    rmSync(dir, { recursive: true, force: true });
  });

  it('没有可复制目标时继续抛出原错误', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-link-fail-'));
    expect(() => preserveSnapshotLink(join(dir, 'missing'), 'gone', undefined, () => {
      throw new Error('拒绝链接');
    })).toThrow('拒绝链接');
    rmSync(dir, { recursive: true, force: true });
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
