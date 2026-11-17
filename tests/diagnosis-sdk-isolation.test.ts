import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  diffSdkWorktrees,
  diffSharedSdkFingerprints,
  executeDiagnosisScript,
  listSharedSdkHars,
  runSdkOverlayDir,
  snapshotSdkWorktree,
  snapshotSharedSdkWorktrees,
} from '../src/lib/workflow/diagnosis-script-step';
import { createSdkOverlay, removeSdkOverlaySnapshot } from '../src/lib/workflow/sdk-overlay';
import * as versionAlign from '../src/lib/workflow/version-align';
import * as sdkOverlay from '../src/lib/workflow/sdk-overlay';
import { prepareIssueSdkOverlay } from '../src/lib/workflow/align-issue-sdk';
import { StateMachineWorkflowManager } from '../src/lib/state-machine/workflow-manager';

const tmpRoots: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diag-sdk-iso-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(async () => { await Promise.all(tmpRoots.map((d) => rm(d, { recursive: true, force: true }))); });

function parseConclusion(output: string): any {
  const m = /<step-conclusion>([\s\S]*?)<\/step-conclusion>/.exec(output);
  expect(m).toBeTruthy();
  return JSON.parse(m![1]);
}

describe('diffSharedSdkFingerprints（F11）', () => {
  const before = [
    { path: '/sdk/a/bin/cache/artifacts/engine/ohos-arm64/flutter_embedding_release.har', sha256: 'aa' },
    { path: '/sdk/a/bin/cache/artifacts/engine/ohos-arm64/flutter_embedding_debug.har', sha256: 'bb' },
  ];
  it('识别 modified / added / removed', () => {
    const diff = diffSharedSdkFingerprints(before, [
      { path: before[0].path, sha256: 'cc' },           // modified
      { path: '/sdk/a/bin/cache/artifacts/engine/ohos-arm64/flutter.har', sha256: 'dd' }, // added
    ]);
    expect(diff.modified).toEqual([before[0].path]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toEqual([before[1].path]);
  });
  it('无变化为全空', () => {
    const diff = diffSharedSdkFingerprints(before, before.map((e) => ({ ...e })));
    expect(diff).toEqual({ modified: [], added: [], removed: [] });
  });
});

describe('listSharedSdkHars', () => {
  it('只列出 ohos 引擎目录里的 HAR，使用静态 readdir', async () => {
    const root = makeTmp();
    const engine = join(root, 'bin', 'cache', 'artifacts', 'engine');
    mkdirSync(join(engine, 'ohos-arm64'), { recursive: true });
    mkdirSync(join(engine, 'android-arm64'), { recursive: true });
    writeFileSync(join(engine, 'ohos-arm64', 'flutter.har'), 'a');
    writeFileSync(join(engine, 'android-arm64', 'skip.har'), 'b');
    await expect(listSharedSdkHars(root)).resolves.toEqual([
      join(engine, 'ohos-arm64', 'flutter.har'),
    ]);
  });
});

function makeGitSdk(): string {
  const root = makeTmp();
  const sdk = join(root, 'flutter-sdk');
  mkdirSync(join(sdk, 'bin', 'cache', 'artifacts', 'engine', 'ohos-arm64'), { recursive: true });
  mkdirSync(join(sdk, 'engine', 'src'), { recursive: true });
  writeFileSync(join(sdk, 'bin', 'flutter'), '#!/bin/sh\n');
  writeFileSync(join(sdk, 'engine', 'src', 'shell.cc'), 'v1');
  writeFileSync(join(sdk, 'engine', 'src', 'dirty.cc'), 'v1');
  writeFileSync(join(sdk, '.gitignore'), 'bin/cache/\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', sdk, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'init');
  // 共享 SDK 运行前就带着改动（真实 3.35.8 SDK 就是这样），不能算本 run 改的
  writeFileSync(join(sdk, 'engine', 'src', 'dirty.cc'), 'local edit');
  const inventory = join(root, 'sdks.yaml');
  writeFileSync(inventory, `sdks:\n  - id: test\n    version: 3.41.9\n    path: ${sdk}\n`);
  process.env.ACE_OHOS_FLUTTER_SDKS = inventory;
  return sdk;
}

describe('共享 SDK 工作区比对', () => {
  const previous = process.env.ACE_OHOS_FLUTTER_SDKS;
  afterEach(() => {
    if (previous === undefined) delete process.env.ACE_OHOS_FLUTTER_SDKS;
    else process.env.ACE_OHOS_FLUTTER_SDKS = previous;
  });

  it('只和基线比：原有改动不报，运行期间的修改、再改、新增都报', async () => {
    const sdk = makeGitSdk();
    const before = await snapshotSharedSdkWorktrees();
    expect(before).toHaveLength(1);
    expect(before[0].entries?.map((e) => e.path)).toEqual(['engine/src/dirty.cc']);
    expect(diffSdkWorktrees(before, await snapshotSharedSdkWorktrees()).changed).toEqual([]);

    writeFileSync(join(sdk, 'engine', 'src', 'shell.cc'), 'run edit');
    writeFileSync(join(sdk, 'engine', 'src', 'dirty.cc'), 'run edit on top');
    writeFileSync(join(sdk, 'engine', 'src', 'new.cc'), 'new');
    writeFileSync(join(sdk, 'bin', 'cache', 'ignored.stamp'), 'x');
    const diff = diffSdkWorktrees(before, await snapshotSharedSdkWorktrees());
    expect(diff.changed).toEqual(['dirty.cc', 'new.cc', 'shell.cc'].map((f) => join(sdk, 'engine', 'src', f)));
    expect(diff.unchecked).toEqual([]);
  });

  it('git 不可用的 SDK 记为未比对，不当成干净', async () => {
    const root = makeTmp();
    const snap = await snapshotSdkWorktree(root);
    expect(snap.entries).toBeNull();
    expect(diffSdkWorktrees([snap], [snap])).toEqual({ changed: [], unchecked: [root] });
  });

  it('finish 发现经 SDK 副本 engine/ 链接写回共享 SDK 时告警', async () => {
    const sdk = makeGitSdk();
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    await executeDiagnosisScript({ operation: 'preflight', workingDirectory: workDir, runDirectory: runDir, globalContext: '自由文本问题描述。' });
    const overlay = createSdkOverlay(sdk, runSdkOverlayDir(runDir));
    writeFileSync(join(overlay.sdkLink, 'engine', 'src', 'shell.cc'), 'agent wrote here');
    writeFileSync(join(overlay.sdkLink, 'bin', 'cache', 'artifacts', 'engine', 'ohos-arm64', 'run.har'), 'isolated');
    const finishOutput = await executeDiagnosisScript({ operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '' });
    const context = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-context.json'), 'utf8'));
    expect(context.shared_sdk_integrity.worktree_checked).toBe(true);
    expect(context.shared_sdk_integrity.worktree_changes).toEqual([join(sdk, 'engine', 'src', 'shell.cc')]);
    expect(context.shared_sdk_integrity.added).toEqual([]);
    expect(context.shared_sdk_integrity.clean).toBe(false);
    expect((parseConclusion(finishOutput).consistency_warnings || []).map((w: any) => w.code)).toContain('shared_sdk_worktree_modified');
  });
});

describe('preflight 建立 run 级隔离区（F11）', () => {
  it('创建 sdk-overlay 子目录（路径含 runId）并记录指纹基线', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run-1799999999999-ia-testiso');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const output = await executeDiagnosisScript({
      operation: 'preflight', workingDirectory: workDir, runDirectory: runDir,
      globalContext: '随便一段自由文本问题描述，用于触发 freeform 输入。',
    });
    const result = parseConclusion(output);
    const overlay = result.sdk_overlay;
    expect(overlay).toBe(runSdkOverlayDir(runDir));
    expect(overlay).toContain('run-1799999999999-ia-testiso'); // F11：路径含 runId
    for (const sub of ['har-cache', 'package-config', 'test-workspace']) {
      expect(existsSync(join(overlay, sub)), sub).toBe(true);
    }
    const preflight = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-preflight.json'), 'utf8'));
    expect(Array.isArray(preflight.shared_sdk_fingerprints)).toBe(true);
  });

  it('清理副本后从 pin 的原始 SDK 路径恢复，不跟随残留链接删除共享 SDK', async () => {
    const sdk = makeGitSdk();
    const root = makeTmp();
    const runId = 'run-1799999999999-ia-revive';
    const overlayDir = join(root, runId, 'sdk-overlay');
    const first = createSdkOverlay(sdk, overlayDir);
    await removeSdkOverlaySnapshot(overlayDir);
    symlinkSync(sdk, join(overlayDir, 'sdk'));
    const pin = { matched: true, sourceSdkRoot: sdk, sdkRoot: first.sdkLink, flutterBin: first.flutterBin };
    const manager = Object.create(StateMachineWorkflowManager.prototype) as any;
    manager.currentRunId = runId;
    manager.runSdkOverlayDir = () => overlayDir;
    manager.logRunDiagnostic = () => {};
    // 测试仅覆盖私有恢复函数的真实文件行为，不启动模型、工作流或服务。
    const revived = manager.reviveSdkOverlay(pin);
    expect(existsSync(revived.flutterBin)).toBe(true);
    expect(lstatSync(join(overlayDir, 'sdk')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(sdk, 'bin', 'flutter'))).toBe(true);
  });

  it('finish 复核：共享 SDK 未被改动时 shared_sdk_integrity.clean=true', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    await executeDiagnosisScript({
      operation: 'preflight', workingDirectory: workDir, runDirectory: runDir,
      globalContext: '自由文本问题描述。',
    });
    const finishOutput = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const context = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-context.json'), 'utf8'));
    expect(context.shared_sdk_integrity.checked).toBe(true);
    expect(context.shared_sdk_integrity.clean).toBe(true);
    expect(context.shared_sdk_integrity.modified).toEqual([]);
    const conclusion = parseConclusion(finishOutput);
    expect((conclusion.consistency_warnings || []).map((w: any) => w.code)).not.toContain('shared_sdk_modified');
  });
});

describe('Issue 历史 SDK 接入', () => {
  afterEach(() => vi.restoreAllMocks());

  it('从已归档的采集输入保留成功回退 commit，不被无 commit 的阶段输出覆盖', async () => {
    const commit = '3107696e8ae429e95292d00d038e26ab7ca379c3';
    const root = makeTmp();
    const workingDirectory = join(root, 'work');
    mkdirSync(join(workingDirectory, 'outputs'), { recursive: true });
    writeFileSync(join(workingDirectory, 'outputs', 'diagnosis-input.json'), JSON.stringify({
      issue_created_at: '2026-02-01T14:01:19+08:00',
      reset_status: 'success', reset_target_merge_commit: commit,
    }));
    const manager = Object.create(StateMachineWorkflowManager.prototype) as any;
    manager.currentRunId = 'run-issue-history';
    manager.globalContext = 'Flutter 3.35.7-ohos-0.0.1';
    manager.stepLogs = [];
    manager.currentProjectRoot = root;
    manager.isolatedDir = workingDirectory;
    manager.readWorkspaceRepoBranch = () => 'oh-3.35.7-dev';
    manager.persistOhosFlutterSdkPin = vi.fn(async () => {});
    const input = manager.readIssueAlignmentInput();
    expect(input.collectorCommit).toBe(commit);
    await manager.refreshOhosFlutterSdkPin('问题复现', '采集结论已保存');
    expect(manager.persistOhosFlutterSdkPin).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ collectorCommit: commit, issueCreatedAt: input.issueCreatedAt }));
  });

  it('HEAD 已是目标 commit 时也必须在独立 worktree 校验引擎', async () => {
    const commit = 'a'.repeat(40);
    const sdk = makeGitSdk();
    const alignedSdkRoot = join(makeTmp(), 'aligned-sdk');
    vi.spyOn(versionAlign, 'planVersionAlign').mockResolvedValue({
      needed: false, targetTag: null, targetCommit: commit, source: 'collector_commit',
      currentTag: '3.35.8-ohos-0.0.2', currentCommit: commit, tagExists: false, sameMajor: false,
      reason: 'SDK 已处于 Issue 历史 commit',
    });
    const align = vi.spyOn(versionAlign, 'alignVersionToTag').mockResolvedValue({
      aligned: true, alignedSdkRoot, targetTag: null, targetCommit: commit, precacheOk: true,
      artifactVerified: true, expectedEngine: 'e1', expectedOhosEngine: 'o1',
      actualEngine: 'e1', actualOhosEngine: 'o1', reason: '历史引擎已校验',
    });
    vi.spyOn(sdkOverlay, 'createSdkOverlay').mockReturnValue({
      overlayDir: '/overlay', sdkLink: '/overlay/sdk', flutterBin: '/overlay/sdk/bin/flutter',
      writableDirs: ['.'], entries: 1,
    });
    const pin = await prepareIssueSdkOverlay({
      resolved: { matched: true, branch: 'dev', versionHint: '3.35.8', sdkId: 'test', sdkRoot: sdk,
        flutterBin: join(sdk, 'bin/flutter'), dailySdk: null, inventory: [], reason: 'test' },
      overlayDir: join(makeTmp(), 'sdk-overlay'), target: { collectorCommit: commit },
    });
    expect(align).toHaveBeenCalledWith(expect.objectContaining({ sdkRoot: sdk, targetCommit: commit, precache: true }));
    expect(pin).toMatchObject({ sdkRoot: '/overlay/sdk', sourceSdkRoot: alignedSdkRoot,
      versionAlign: { targetCommit: commit, artifactVerified: true } });
  });

  it('无法解析历史 SDK 时阻断，不创建共享 HEAD 的副本', async () => {
    const sdk = makeGitSdk();
    vi.spyOn(versionAlign, 'planVersionAlign').mockResolvedValue({
      needed: false, targetTag: null, targetCommit: null, source: 'issue_created_at',
      currentTag: '3.35.8-ohos-0.0.3', currentCommit: 'b'.repeat(40), tagExists: false, sameMajor: false,
      reason: '分支缺少历史',
    });
    const overlay = vi.spyOn(sdkOverlay, 'createSdkOverlay');
    await expect(prepareIssueSdkOverlay({
      resolved: { matched: true, branch: 'dev', versionHint: '3.35.8', sdkId: 'test', sdkRoot: sdk,
        flutterBin: join(sdk, 'bin/flutter'), dailySdk: null, inventory: [], reason: 'test' },
      overlayDir: join(makeTmp(), 'sdk-overlay'), target: { issueCreatedAt: '2026-02-01T14:01:19+08:00', branch: 'dev' },
    })).rejects.toThrow('禁止以共享 SDK 当前 HEAD');
    expect(overlay).not.toHaveBeenCalled();
  });
});
