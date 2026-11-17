import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkOverlay } from '../src/lib/workflow/sdk-overlay';
import { executeDiagnosisScript } from '../src/lib/workflow/diagnosis-script-step';
import { enforceFixVerificationGoldenFlag, shouldFinalizeDiagnosisAsCompleted } from '../src/lib/state-machine/utils';
import { makeStepResultRecord, validateStepResultRecord } from '../src/lib/workflow/step-result-record';
import { buildRunSummaryCacheFromState } from '../src/lib/run/summary-cache';
import { createOpenCodeUsageCollector } from '../src/lib/engines/opencode-usage';
vi.mock('@/lib/core/configured-env', () => ({ buildConfiguredProcessEnv: async () => ({ ...process.env }) }));
vi.mock('@/lib/workflow/ohos-flutter-sdk', async original => ({ ...await original(), loadOhosFlutterSdkInventory: () => ({}), listInventoryEntries: () => [] }));
const dirs: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'training-fix-')); dirs.push(path); return path; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = temp(), run = join(root, 'run-test'), work = join(root, 'work');
  mkdirSync(join(run, 'outputs'), { recursive: true }); mkdirSync(join(work, 'outputs'), { recursive: true });
  return { root, run, work };
}
const finish = async (f: ReturnType<typeof fixture>) => JSON.parse((await executeDiagnosisScript({ operation: 'finish', runDirectory: f.run, workingDirectory: f.work, globalContext: '' })).replace(/^<step-conclusion>|<\/step-conclusion>$/g, ''));
const passed = '<step-conclusion>{"verdict":"pass","issue_golden_flag_met":true,"engine_aligned":true,"bug_fixed":true}</step-conclusion>';
it.each(['<result>{"verdict":"fail"}</result>', '<step-conclusion>{"verdict":"fail"}</step-conclusion>', '<result>{"bug_fixed":false}</result>'])('conflicting outcomes cannot complete or become verified: %s', async suffix => {
  const f = fixture(), output = passed + suffix;
  writeFileSync(join(f.work, 'outputs/修复验证-修复方案对抗验证.md'), output);
  const result = await finish(f);
  expect(result.verification_status).toBe('evidence_conflict'); expect(result.verdict).toBe('fail');
  expect(result.verification_conflicts.length).toBeGreaterThan(0);
  expect(enforceFixVerificationGoldenFlag(output, 'pass', { stateName: '修复验证' })).toBe('fail');
  expect(shouldFinalizeDiagnosisAsCompleted({ hasFixVerificationState: true, lastFixVerificationVerdict: 'pass', diagnosisVerificationStatus: result.verification_status }).complete).toBe(false);
});
it('nested files, HAP/APK, source and lock evidence survive loss of work directory', async () => {
  const f = fixture(), names = ['fixed.hap', 'fixed.apk', 'logs/build.log', 'tests/main.dart', 'deps/package.lock'];
  for (const name of names) { const path = join(f.work, 'outputs', name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, name); }
  writeFileSync(join(f.work, 'outputs/修复验证-修复方案对抗验证.md'), `<step-conclusion>${JSON.stringify({ verdict: 'pass', evidenceRefs: names.map(path => ({ path })) })}</step-conclusion>`);
  await finish(f); rmSync(f.work, { recursive: true });
  for (const name of names) expect(readFileSync(join(f.run, 'outputs', name), 'utf8')).toBe(name);
  const manifest = JSON.parse(readFileSync(join(f.run, 'outputs/diagnosis-archive-manifest.json'), 'utf8'));
  expect(names.every(name => manifest.entries.some((e: any) => e.name === name && e.sha256?.length === 64))).toBe(true);
});
it.each(['outputs/missing.hap', 'outputs/../private.txt'])('missing/escaping required references block completion: %s', async ref => {
  const f = fixture(); writeFileSync(join(f.run, 'outputs/报告沉淀-生成诊断报告.md'), ref);
  const result = await finish(f); expect(result.verdict).toBe('fail'); expect(result.artifact_status).not.toBe('complete');
});
it('an external evidence symlink is rejected', async () => {
  const f = fixture(); writeFileSync(join(f.root, 'private'), 'secret'); symlinkSync(join(f.root, 'private'), join(f.work, 'outputs/secret.txt'));
  expect((await finish(f)).artifact_status).toBe('failed'); expect(existsSync(join(f.run, 'outputs/secret.txt'))).toBe(false);
});
it('SDK launch path and writes are independent across runs, including internal absolute links', () => {
  const root = temp(), sdk = join(root, 'shared'); mkdirSync(join(sdk, 'bin/cache'), { recursive: true }); mkdirSync(join(sdk, 'packages'));
  writeFileSync(join(sdk, 'bin/flutter'), '#!/bin/sh\nreadlink -f "$0"\n'); chmodSync(join(sdk, 'bin/flutter'), 0o755);
  writeFileSync(join(sdk, 'packages/source.dart'), 'old'); symlinkSync(join(sdk, 'packages/source.dart'), join(sdk, 'source-link'));
  const a = createSdkOverlay(sdk, join(root, 'a')), b = createSdkOverlay(sdk, join(root, 'b'));
  expect(execFileSync(a.flutterBin!, { encoding: 'utf8' }).trim()).toBe(realpathSync(a.flutterBin!));
  writeFileSync(join(a.sdkLink, 'source-link'), 'changed');
  expect(readFileSync(join(sdk, 'packages/source.dart'), 'utf8')).toBe('old'); expect(readFileSync(join(b.sdkLink, 'source-link'), 'utf8')).toBe('old');
  rmSync(a.overlayDir, { recursive: true }); expect(realpathSync(b.flutterBin!)).toBe(join(realpathSync(b.sdkLink), 'bin/flutter'));
});
it('unsafe SDK copy fails cleanly and can retry after fixing the source', () => {
  const root = temp(), sdk = join(root, 'shared'), out = join(root, 'overlay'); mkdirSync(join(sdk, 'bin'), { recursive: true });
  writeFileSync(join(sdk, 'bin/flutter'), 'ok'); writeFileSync(join(root, 'external'), 'outside'); symlinkSync(join(root, 'external'), join(sdk, 'bad'));
  expect(() => createSdkOverlay(sdk, out)).toThrow('越出'); expect(existsSync(join(out, 'sdk'))).toBe(false);
  rmSync(join(sdk, 'bad')); expect(createSdkOverlay(sdk, out).flutterBin).toBeTruthy();
});
it('canonical result is bound to the attempt and full output', () => {
  const record = makeStepResultRecord('run', 'attempt1', 'verify', passed);
  expect(validateStepResultRecord(record, 'run', 'attempt1', passed)).toBe(true);
  expect(validateStepResultRecord(record, 'run', 'attempt2', passed)).toBe(false);
  expect(validateStepResultRecord(record, 'run', 'attempt1', passed + 'changed')).toBe(false);
  expect(validateStepResultRecord({ ...record, verdict: 'fail' }, 'run', 'attempt1', passed)).toBe(false);
});
it('usage replaces duplicate message updates, excludes history and preserves unknown cost', () => {
  const updates: any[] = [], collect = createOpenCodeUsageCollector(v => updates.push(v), new Set(['old']));
  collect({ id: 'old', role: 'assistant', tokens: { input: 999, output: 999 }, cost: 5 });
  const info = { id: 'a', role: 'assistant', tokens: { input: 12, output: 4, cache: { read: 3, write: 1 } }, cost: .2 };
  collect(info); collect(info); collect({ ...info, tokens: { input: 12, output: 8 } });
  expect(updates.at(-1).usage.output_tokens).toBe(8); expect(updates.at(-1).cost_usd).toBe(.2);
  collect({ id: 'b', role: 'assistant', tokens: { input: 5, output: 2 } });
  expect(updates.at(-1).usage.input_tokens).toBe(17); expect(updates.at(-1).cost_source).toBe('unavailable'); expect(updates.at(-1).cost_usd).toBeUndefined();
});
it('blind_eval is blocked without executor isolation, before model or network work', async () => {
  const f = fixture(); const output = await executeDiagnosisScript({ operation: 'preflight', workingDirectory: f.work, runDirectory: f.run, globalContext: 'evaluation-mode: blind_eval\nissue-url: https://gitcode.com/o/r/issues/1' });
  expect(output).toContain('blind_eval 暂不可用'); expect(output).toContain('"verdict":"fail"');
});
function installFixture() {
  const root = temp(), project = join(root, 'demo'), bin = join(root, 'bin'), pkg = join(root, 'package');
  mkdirSync(join(project, 'ohos/oh_modules/.ohpm'), { recursive: true }); mkdirSync(bin); mkdirSync(pkg);
  writeFileSync(join(pkg, 'BuildProfile.ets'), 'export const BUILD_MODE_NAME = "release";\nexport const DEBUG = false;\nexport const TARGET_NAME = "default";');
  const har = join(root, 'embedding.har'), hap = join(root, 'app.hap'), manifest = join(root, 'build.json'), calls = join(root, 'hdc-args');
  execFileSync('tar', ['-czf', har, '-C', root, 'package/BuildProfile.ets']);
  writeFileSync(join(project, 'ohos/oh_modules/.ohpm/lock.json5'), JSON.stringify({ overrides: { '@ohos/flutter_ohos': `file:${har}` } }));
  writeFileSync(join(bin, 'flutter'), '#!/bin/sh\nprintf fresh-hap > "$TEST_HAP"\n'); chmodSync(join(bin, 'flutter'), 0o755);
  writeFileSync(join(bin, 'hdc'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_HDC_ARGS"\necho "install bundle successfully"\n'); chmodSync(join(bin, 'hdc'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_HAP: hap, TEST_HDC_ARGS: calls };
  const buildArgs = ['scripts/ohos-hap-build.mjs', '--project', project, '--flutter', join(bin, 'flutter'), '--har', har, '--hap', hap, '--expected-mode', 'release', '--manifest', manifest];
  const installArgs = ['scripts/ohos-har-install.mjs', '--har', har, '--hap', hap, '--build-manifest', manifest, '--expected-mode', 'release', '--expect-path-prefix', root, '--record', join(root, 'install.json')];
  return { root, project, har, hap, manifest, calls, env, buildArgs, installArgs };
}
it('build binds actual HAR to fresh HAP; installer sends only HAP to hdc', () => {
  const f = installFixture(); writeFileSync(f.hap, 'old-hap');
  execFileSync(process.execPath, f.buildArgs, { env: f.env });
  const result = JSON.parse(execFileSync(process.execPath, f.installArgs, { env: f.env, encoding: 'utf8' }));
  expect(result.installed).toBe(true); expect(result.hap_sha256).toHaveLength(64); expect(result.application_started).toBeNull();
  expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toEqual(['install', f.hap]);
  expect(readFileSync(f.hap, 'utf8')).toBe('fresh-hap');
});
it.each(['hap', 'har', 'lock'])('changed %s after build cannot be installed', kind => {
  const f = installFixture(); execFileSync(process.execPath, f.buildArgs, { env: f.env });
  const file = kind === 'hap' ? f.hap : kind === 'har' ? f.har : join(f.project, 'ohos/oh_modules/.ohpm/lock.json5');
  writeFileSync(file, 'tampered'); expect(() => execFileSync(process.execPath, f.installArgs, { env: f.env, stdio: 'pipe' })).toThrow();
  expect(existsSync(f.calls)).toBe(false); expect(JSON.parse(readFileSync(join(f.root, 'install.json'), 'utf8')).gate).toBe('failed');
});
it('HAR alone is refused; an external symlink cannot pass source validation', () => {
  const f = installFixture();
  expect(() => execFileSync(process.execPath, ['scripts/ohos-har-install.mjs', '--har', f.har, '--expected-mode', 'release'], { env: f.env, stdio: 'pipe' })).toThrow(); expect(existsSync(f.calls)).toBe(false);
  const allowed = join(f.root, 'allowed'); mkdirSync(allowed); symlinkSync(f.har, join(allowed, 'linked.har'));
  expect(() => execFileSync(process.execPath, ['scripts/ohos-har-install.mjs', '--har', join(allowed, 'linked.har'), '--expected-mode', 'release', '--check-only', '--expect-path-prefix', allowed], { stdio: 'pipe' })).toThrow();
});

it('summary distinguishes reported zero usage from unknown and excludes script-only steps', () => {
  const state: any = { runId: 'run-test', configFile: 'test.yaml', stepLogs: [
    { costUsd: 0, tokenUsage: { inputTokens: 0, outputTokens: 0, source: 'reported', costSource: 'reported' } },
    { costUsd: 0, tokenUsage: { inputTokens: 0, outputTokens: 0, source: 'not_applicable', costSource: 'not_applicable' } },
  ] };
  expect(buildRunSummaryCacheFromState(state)).toMatchObject({ tokenUsageSource: 'reported', tokenUsageCoverage: 1, costSource: 'reported', reportedCost: 0 });
  state.stepLogs[0].tokenUsage = { inputTokens: 0, outputTokens: 0, source: 'unavailable', costSource: 'unavailable' };
  expect(buildRunSummaryCacheFromState(state)).toMatchObject({ tokenUsageSource: 'unavailable', reportedCost: null });
});
