import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  diffSharedSdkFingerprints,
  executeDiagnosisScript,
  runSdkOverlayDir,
} from '../src/lib/workflow/diagnosis-script-step';

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
