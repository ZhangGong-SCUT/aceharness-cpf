import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { executeDiagnosisScript, expandOutputRefShorthand, extractOutputRefs, sanitizeGitRemote } from '../src/lib/workflow/diagnosis-script-step';

const tmpRoots: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diag-finish-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(async () => { await Promise.all(tmpRoots.map((d) => rm(d, { recursive: true, force: true }))); });

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** 构造带本地路径 origin 的仓库（F01 崩溃现场复现） */
function makeRepoWithLocalOrigin(workDir: string, mirrorDir: string): string {
  const repo = join(workDir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'baseline']);
  git(repo, ['remote', 'add', 'origin', mirrorDir]); // 本地路径 origin
  // 制造未提交修改，形成 diff
  writeFileSync(join(repo, 'fix.ts'), 'export const fix = true;\n');
  git(repo, ['add', 'fix.ts']);
  return repo;
}

function parseConclusion(output: string): any {
  const m = /<step-conclusion>([\s\S]*?)<\/step-conclusion>/.exec(output);
  expect(m).toBeTruthy();
  return JSON.parse(m![1]);
}

// R7 真实风格的散文步骤输出（无 <result>、无 JSON）
const R7_STYLE_VERIFICATION = `## 结果 / 裁决
- 修复验证 **pass**。GOLDEN 回归测试通过。issue_golden_flag_met=true，engine_aligned=true，bug_fixed=true。
`;

describe('sanitizeGitRemote（F01）', () => {
  it('https 剥离凭据/query', () => {
    expect(sanitizeGitRemote('https://oauth2:secret@gitcode.com/a/b.git?x=1#f')).toEqual({
      kind: 'https', url: 'https://gitcode.com/a/b.git',
    });
  });
  it('scp 风格与本地路径不抛异常', () => {
    expect(sanitizeGitRemote('git@gitcode.com:a/b.git').kind).toBe('ssh');
    expect(sanitizeGitRemote('/home/flutter/.aceharness/repo-cache/x.git')).toEqual({
      kind: 'local', url: '/home/flutter/.aceharness/repo-cache/x.git',
    });
    expect(sanitizeGitRemote('')).toEqual({ kind: 'unknown', url: '' });
  });
});

describe('extractOutputRefs：只认任务自己的 outputs/', () => {
  const work = '/Users/flutter/.aceharness/run-workspaces/run-x';
  const run = '/Users/flutter/.aceharness/runs/run-x';

  it('构建目录里的 build/.../outputs/ 不算证据', () => {
    const text = [
      '- HAP：demo/ohos/entry/build/default/outputs/default/entry-default-signed.hap（sha256 399864f4...）',
      'APK 在 build/app/outputs/flutter-apk/app-debug.apk',
      '引擎 HAR：repo/engine/.../flutter/build/default/outputs/default/flutter.har',
    ].join('\n');
    expect(extractOutputRefs(text, [work, run])).toEqual([]);
  });

  it('相对 outputs/、./outputs/、参数里的 outputs/ 和任务目录绝对路径都保留', () => {
    const text = [
      '日志 outputs/ohos-hilog-after-fix.txt',
      '截图 ./outputs/pv01_ohos_after_fix.jpeg',
      '--manifest outputs/hap-build-manifest.json --record=outputs/har-install-record.json',
      `证据 ${work}/outputs/device-snapshot.json`,
      `归档 ${run}/outputs/step-logs/a.md`,
    ].join('\n');
    expect(extractOutputRefs(text, [work, run]).sort()).toEqual([
      'device-snapshot.json', 'hap-build-manifest.json', 'har-install-record.json',
      'ohos-hilog-after-fix.txt', 'pv01_ohos_after_fix.jpeg', 'step-logs/a.md',
    ]);
  });

  it('范围简写、花括号和逗号并列展开成逐个文件，跨度过大保持原样', () => {
    expect(expandOutputRefShorthand('fixverify-run1~4-hilog.txt')).toEqual([
      'fixverify-run1-hilog.txt', 'fixverify-run2-hilog.txt', 'fixverify-run3-hilog.txt', 'fixverify-run4-hilog.txt',
    ]);
    expect(expandOutputRefShorthand('fixverify-run1~fixverify-run3-hilog.txt')).toEqual([
      'fixverify-run1-hilog.txt', 'fixverify-run2-hilog.txt', 'fixverify-run3-hilog.txt',
    ]);
    expect(expandOutputRefShorthand('shot{1..3}.png')).toEqual(['shot1.png', 'shot2.png', 'shot3.png']);
    expect(expandOutputRefShorthand('shot{1,3}.png')).toEqual(['shot1.png', 'shot3.png']);
    expect(expandOutputRefShorthand('a.png,b.png')).toEqual(['a.png', 'b.png']);
    expect(expandOutputRefShorthand('run01~03.txt')).toEqual(['run01.txt', 'run02.txt', 'run03.txt']);
    expect(expandOutputRefShorthand('run1~40.txt')).toEqual(['run1~40.txt']);
    expect(expandOutputRefShorthand('：fix.patch')).toEqual(['fix.patch']);
    expect(expandOutputRefShorthand('har/flutter_embedding_{debug,release}.har')).toEqual([
      'har/flutter_embedding_debug.har', 'har/flutter_embedding_release.har',
    ]);
    expect(expandOutputRefShorthand('ohos-hilog-fix-raw/r2/r3.txt')).toEqual([
      'ohos-hilog-fix-raw.txt', 'ohos-hilog-fix-r2.txt', 'ohos-hilog-fix-r3.txt',
    ]);
    expect(extractOutputRefs('证据 outputs/fixverify-run1~4-hilog.txt、outputs/a.png,b.png outputs/shot{1..2}.png', [work, run]).sort())
      .toEqual(['a.png', 'b.png', 'fixverify-run1-hilog.txt', 'fixverify-run2-hilog.txt', 'fixverify-run3-hilog.txt', 'fixverify-run4-hilog.txt', 'shot1.png', 'shot2.png']);
  });

  it('磁盘上真有带波浪号的文件时不展开', () => {
    const root = makeTmp();
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    writeFileSync(join(workDir, 'outputs', 'keep1~2.txt'), 'literal');
    expect(extractOutputRefs('outputs/keep1~2.txt', [workDir])).toEqual(['keep1~2.txt']);
  });

  it('冒号、文字花括号和斜杠简写按真实文件归档（#2913 #2758 #2781）', () => {
    const root = makeTmp();
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs', 'har'), { recursive: true });
    writeFileSync(join(workDir, 'outputs', 'fix.patch'), 'patch');
    writeFileSync(join(workDir, 'outputs', 'har', 'flutter_embedding_debug.har'), 'd');
    writeFileSync(join(workDir, 'outputs', 'har', 'flutter_embedding_release.har'), 'r');
    writeFileSync(join(workDir, 'outputs', 'ohos-hilog-fix-raw.txt'), 'raw');
    writeFileSync(join(workDir, 'outputs', 'ohos-hilog-fix-r2.txt'), 'r2');
    writeFileSync(join(workDir, 'outputs', 'ohos-hilog-fix-r3.txt'), 'r3');
    const text = [
      '补丁 outputs/：fix.patch',
      '包 outputs/har/flutter_embedding_{debug,release}.har',
      '日志 outputs/ohos-hilog-fix-raw/r2/r3.txt',
    ].join('\n');
    expect(extractOutputRefs(text, [workDir]).sort()).toEqual([
      'fix.patch',
      'har/flutter_embedding_debug.har',
      'har/flutter_embedding_release.har',
      'ohos-hilog-fix-r2.txt',
      'ohos-hilog-fix-r3.txt',
      'ohos-hilog-fix-raw.txt',
    ]);
  });

  it('通配符和粘在开头的花括号对上真实文件，对不上的通配不留下缺失名', () => {
    const root = makeTmp();
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    writeFileSync(join(workDir, 'outputs', 'fv-hilog-s1.txt'), 'a');
    writeFileSync(join(workDir, 'outputs', 'fv-hilog-s1-final.txt'), 'b');
    writeFileSync(join(workDir, 'outputs', 'fix.patch'), 'patch');
    writeFileSync(join(workDir, 'outputs', 'ohos-hilog-fix.txt'), 'log');
    const text = '日志 outputs/fv-hilog-s1*.txt，补丁 outputs/{fix.patch 和 outputs/{ohos-hilog-fix.txt。';
    expect(extractOutputRefs(text, [workDir]).sort()).toEqual([
      'fix.patch', 'fv-hilog-s1-final.txt', 'fv-hilog-s1.txt', 'ohos-hilog-fix.txt',
    ]);
    expect(extractOutputRefs('没有这个文件 outputs/no-such-*.txt', [workDir])).toEqual([]);
    expect(extractOutputRefs('截图 outputs/missing-shot.png', [workDir])).toEqual(['missing-shot.png']);
  });

  it('别的任务、别的目录、名字里带 outputs 的路径都不算', () => {
    const text = [
      '/Users/flutter/.aceharness/run-workspaces/run-other/outputs/x.json',
      '/tmp/outputs/y.json',
      'build_outputs/z.json',
    ].join('\n');
    expect(extractOutputRefs(text, [work, run])).toEqual([]);
  });
});

describe('finish 收尾（F01+F02+F05 集成）', () => {
  it('修复验证写了构建目录里的 HAP 路径时，归档仍 complete（#2914 现场）', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(join(workDir, 'demo', 'ohos', 'entry', 'build', 'default', 'outputs', 'default'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(workDir, 'demo', 'ohos', 'entry', 'build', 'default', 'outputs', 'default', 'entry-default-signed.hap'), 'hap');
    writeFileSync(join(workDir, 'outputs', 'hap-build-manifest.json'), '{"producer":"ohos-hap-build"}');
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'), [
      R7_STYLE_VERIFICATION,
      '- HAP：demo/ohos/entry/build/default/outputs/default/entry-default-signed.hap（sha256 399864f4...）。',
      `- 构建清单：${workDir}/outputs/hap-build-manifest.json`,
    ].join('\n'));

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    expect(result.artifact_status).toBe('complete');
    expect(result.verdict).toBe('pass');
    const manifest = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-archive-manifest.json'), 'utf8'));
    expect(manifest.entries.some((entry: any) => entry.name === 'default/entry-default-signed.hap')).toBe(false);
    expect(manifest.entries.find((entry: any) => entry.name === 'hap-build-manifest.json').status).toBe('archived');
  });

  it('结论 evidenceRefs 指向构建目录、仓库源码时不当缺失证据，outputs 里的照常归档', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(join(workDir, 'repo'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(workDir, 'repo', 'fix.cc'), 'fixed');
    writeFileSync(join(workDir, 'outputs', 'after.png'), 'png');
    writeFileSync(join(workDir, 'outputs', 'hilog.txt'), 'log');
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'), [
      '```json',
      JSON.stringify({ verdict: 'pass', evidenceRefs: [
        'demo/ohos/entry/build/default/outputs/default/entry-default-signed.hap',
        'repo/fix.cc',
        `${workDir}/outputs/after.png`,
        { path: 'outputs/hilog.txt' },
      ] }),
      '```',
      'issue_golden_flag_met=true，engine_aligned=true，bug_fixed=true。',
    ].join('\n'));

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    expect(result.artifact_status).toBe('complete');
    const manifest = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-archive-manifest.json'), 'utf8'));
    const names = manifest.entries.map((entry: any) => entry.name);
    expect(names).not.toContain('demo/ohos/entry/build/default/outputs/default/entry-default-signed.hap');
    expect(names).not.toContain('default/entry-default-signed.hap');
    expect(names).not.toContain('repo/fix.cc');
    expect(manifest.entries.find((entry: any) => entry.name === 'after.png').status).toBe('archived');
    expect(manifest.entries.find((entry: any) => entry.name === 'hilog.txt').status).toBe('archived');
  });

  it('结论 evidenceRefs 里的 outputs 证据真缺失时，仍判 partial', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'), [
      '```json',
      JSON.stringify({ verdict: 'pass', evidenceRefs: ['gone.png'] }),
      '```',
      'issue_golden_flag_met=true，engine_aligned=true，bug_fixed=true。',
    ].join('\n'));

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    expect(result.artifact_status).toBe('partial');
    const manifest = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-archive-manifest.json'), 'utf8'));
    expect(manifest.entries.find((entry: any) => entry.name === 'gone.png').status).toBe('missing');
  });

  it('报告用 run1~4 简写日志时，按逐个文件归档（#2592 现场）', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    for (const name of ['fixverify-run1-hilog.txt', 'fixverify-run2-hilog.txt', 'fixverify-run3-hilog.txt', 'fixverify-run4-hilog.txt']) {
      writeFileSync(join(workDir, 'outputs', name), name);
    }
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'), [
      R7_STYLE_VERIFICATION,
      '真机证据 outputs/fixverify-run1~4-hilog.txt。',
      '报告摘要 outputs/fixverify-run1~3-hilog.txt。',
    ].join('\n'));
    writeFileSync(join(workDir, 'outputs', '报告沉淀-生成诊断报告.md'), 'outputs/fixverify-run{1,2,4}-hilog.txt');

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    expect(result.artifact_status).toBe('complete');
    expect(result.verdict).toBe('pass');
    const manifest = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-archive-manifest.json'), 'utf8'));
    expect(manifest.entries.some((entry: any) => String(entry.name).includes('~') || String(entry.name).includes('{'))).toBe(false);
    for (const name of ['fixverify-run1-hilog.txt', 'fixverify-run2-hilog.txt', 'fixverify-run3-hilog.txt', 'fixverify-run4-hilog.txt']) {
      expect(['archived', 'already_present']).toContain(manifest.entries.find((entry: any) => entry.name === name).status);
    }
  });

  it('任务目录绝对路径引用的证据真缺失时，仍判 partial', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'), [
      R7_STYLE_VERIFICATION,
      `- 截图：${workDir}/outputs/fix-shot.jpeg`,
    ].join('\n'));

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    expect(result.artifact_status).toBe('partial');
    const manifest = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-archive-manifest.json'), 'utf8'));
    expect(manifest.entries.find((entry: any) => entry.name === 'fix-shot.jpeg').status).toBe('missing');
  });

  it('本地路径 origin 不再崩溃；R7 散文字段完整迁移；归档清单含哈希', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    const mirror = join(root, 'mirror.git');
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    git(root, ['init', '-q', '--bare', mirror]);
    makeRepoWithLocalOrigin(workDir, mirror);
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'), R7_STYLE_VERIFICATION);

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir,
      globalContext: 'evaluation-mode: blind_eval',
    });
    const result = parseConclusion(output);
    expect(result.verdict).toBe('pass');
    expect(result.artifact_status).toBe('complete');
    expect(result.evaluation_mode).toBe('blind_eval');
    // F02：散文字段迁移后应判定 verified，而非一律 needs_runtime_validation
    expect(result.verification_status).toBe('verified');

    const context = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-context.json'), 'utf8'));
    expect(context.repositories).toHaveLength(1);
    expect(context.repositories[0].remote_kind).toBe('local');
    expect(context.repositories[0].url).toBe(mirror);
    expect(context.verification_flags).toEqual({
      issue_golden_flag_met: 'true', engine_aligned: 'true', bug_fixed: 'true',
    });
    expect(context.extraction.fix_verification.issue_golden_flag_met).toBe('inline-fields');

    const manifest = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-archive-manifest.json'), 'utf8'));
    const patchEntry = manifest.entries.find((e: any) => e.name === 'fix.patch');
    expect(patchEntry.status).toBe('archived');
    expect(patchEntry.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(patchEntry.bytes).toBeGreaterThan(0);
    expect(existsSync(join(runDir, 'outputs', 'fix.patch'))).toBe(true);
  });

  it('归档目录不可写时：verdict=fail + error_code + artifact_status=failed（F01 不再静默）', async () => {
    const root = makeTmp();
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    // runDirectory 是一个文件，mkdir/write 必失败
    const runDirFile = join(root, 'run-as-file');
    writeFileSync(runDirFile, 'not a dir');

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDirFile, globalContext: '',
    });
    const result = parseConclusion(output);
    expect(result.verdict).toBe('fail');
    expect(result.artifact_status).toBe('failed');
    expect(typeof result.error_code).toBe('string');
    expect(result.error_code.length).toBeGreaterThan(0);
  });

  it('只改 repo-engine 时，空的 fix.patch 记 not_applicable，摘要里的「两仓干净」标过期', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    const mirror = join(root, 'mirror.git');
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    git(root, ['init', '-q', '--bare', mirror]);
    for (const name of ['repo', 'repo-engine']) {
      const repo = join(workDir, name);
      mkdirSync(repo, { recursive: true });
      git(repo, ['init', '-q']);
      git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'baseline']);
      git(repo, ['remote', 'add', 'origin', mirror]);
    }
    writeFileSync(join(workDir, 'repo-engine', 'LocalizationPlugin.ets'), 'export const fixed = true;\n');
    git(join(workDir, 'repo-engine'), ['add', 'LocalizationPlugin.ets']);
    writeFileSync(join(workDir, 'outputs', '根因分析-根因定位.md'), [
      '```json',
      '{"problem_ownership":"framework_library","root_cause_summary":"未动 repo/ 与 repo-engine/（两仓干净）"}',
      '```',
    ].join('\n'));
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'), R7_STYLE_VERIFICATION);

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    expect(result.verdict).toBe('pass');
    expect(result.artifact_status).toBe('complete');
    const manifest = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-archive-manifest.json'), 'utf8'));
    expect(manifest.entries.find((entry: any) => entry.name === 'fix.patch').status).toBe('not_applicable');
    expect(manifest.entries.find((entry: any) => entry.name === 'fix-engine.patch').status).toBe('archived');
    const context = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-context.json'), 'utf8'));
    expect(context.consistency_warnings.map((warning: any) => warning.code)).toContain('repo_state_stale');
    expect(context.evaluation_integrity).toBe('not_independent');
  });

  it('明确空 patch 交付说明且验证通过时，无需伪造源码 diff（#3071）', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(join(workDir, 'repo'), { recursive: true });
    git(root, ['init', '-q', '--bare', join(root, 'mirror.git')]);
    git(join(workDir, 'repo'), ['init', '-q']);
    git(join(workDir, 'repo'), ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'baseline']);
    git(join(workDir, 'repo'), ['remote', 'add', 'origin', join(root, 'mirror.git')]);
    writeFileSync(join(workDir, 'outputs', 'fix-patch-空patch结论说明.md'),
      'outputs/fix.patch 为 0 字节空文件，这是本步骤的预期交付物，不是生成失败。无需修改本仓源码。');
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'), R7_STYLE_VERIFICATION);

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    expect(result).toMatchObject({ artifact_status: 'complete', verdict: 'pass', artifact_failures: [] });
    const manifest = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-archive-manifest.json'), 'utf8'));
    expect(result.verdict).toBe('pass');
    expect(manifest.entries.filter((entry: any) => /^fix(?:-engine)?\.patch$/.test(entry.name))
      .every((entry: any) => entry.status === 'not_applicable')).toBe(true);
  });

  it('报告用通配符和粘连花括号引用已有文件时，归档按真实文件完成', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(join(workDir, 'demo', 'ohos', 'entry', 'build'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(workDir, 'demo', 'ohos', 'entry', 'build', 'app.hap'), 'hap');
    writeFileSync(join(workDir, 'outputs', 'fv-hilog-s1.txt'), 'a');
    writeFileSync(join(workDir, 'outputs', 'fv-hilog-s1-final.txt'), 'b');
    writeFileSync(join(workDir, 'outputs', 'fix.patch'), 'patch');
    writeFileSync(join(workDir, 'outputs', '报告沉淀-生成诊断报告.md'), [
      '# 诊断报告',
      '日志 outputs/fv-hilog-s1*.txt，补丁 outputs/{fix.patch。',
    ].join('\n'));
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'), R7_STYLE_VERIFICATION);

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    const manifest = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-archive-manifest.json'), 'utf8'));
    expect(result.artifact_status).toBe('complete');
    expect(manifest.entries.some((entry: any) => entry.status === 'missing')).toBe(false);
    expect(manifest.entries.find((entry: any) => entry.name === 'fv-hilog-s1.txt').status).toBe('archived');
    expect(manifest.entries.find((entry: any) => entry.name === 'fix.patch').status).toBe('archived');
    expect(existsSync(join(workDir, 'demo', 'ohos', 'entry', 'build'))).toBe(false);
    expect(existsSync(join(workDir, 'outputs', 'fix.patch'))).toBe(true);
  });

  it('报告引用的时间戳步骤总结缺失时不阻断完成，其他缺失证据仍然阻断', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(workDir, 'outputs', '报告沉淀-生成诊断报告.md'), [
      '# 诊断报告',
      'report_path 指向 outputs/2026-11-06T03-33-48-报告沉淀-生成诊断报告.md。',
      '截图见 outputs/missing-shot.png。',
    ].join('\n'));
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'), R7_STYLE_VERIFICATION);

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    const manifest = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-archive-manifest.json'), 'utf8'));
    const summary = manifest.entries.find((entry: any) => entry.name === '2026-11-06T03-33-48-报告沉淀-生成诊断报告.md');
    const shot = manifest.entries.find((entry: any) => entry.name === 'missing-shot.png');
    expect(summary.status).toBe('not_applicable');
    expect(shot.status).toBe('missing');
    expect(result.artifact_status).toBe('partial');
    expect(result.verdict).toBe('fail');
  });

  it('只有时间戳步骤总结缺失时，归档仍 complete', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(workDir, 'outputs', '报告沉淀-生成诊断报告.md'),
      '报告正文。{"report_path":"outputs/2026-11-06T03-33-48-报告沉淀-生成诊断报告.md"}');
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'), R7_STYLE_VERIFICATION);

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    const manifest = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-archive-manifest.json'), 'utf8'));
    expect(manifest.entries.find((entry: any) => entry.name === '2026-11-06T03-33-48-报告沉淀-生成诊断报告.md').status)
      .toBe('not_applicable');
    expect(result.artifact_status).toBe('complete');
    expect(result.verdict).toBe('pass');
  });

  it('修复验证用顿号并列三个标志时，收尾仍判定 verified', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(workDir, 'outputs', '报告沉淀-生成诊断报告.md'), '报告正文。');
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'), [
      '```json',
      '{"verdict":"pass","remaining_issues":0,"summary":"修复后真机黄金标志通过"}',
      '```',
      'engine_aligned=true、issue_golden_flag_met=true、bug_fixed=true、issue_resolved=yes、root_cause_coverage=covered、regression_risk=低。',
    ].join('\n'));

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    expect(result.verification_status).toBe('verified');
    expect(result.verification_flags.bug_fixed).toBe('true');
    expect(result.verification_flags.engine_aligned).toBe('true');
    expect(result.verification_flags.issue_golden_flag_met).toBe('true');
  });

  it('只有无效 L1 OK 时，issue_golden_flag_met 降为 unknown', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'),
      '修复验证 **pass**。L1 OK×2。issue_golden_flag_met=true，engine_aligned=true，bug_fixed=true。');
    writeFileSync(join(workDir, 'outputs', 'ohos-fix-hilog.txt'), [
      'expected MaterialApp locale from native list: null',
      'L1 OK: dispatcher.locales length (5) matches native preferred language list length (0)',
      'L2 OK: MaterialApp resolved en_US',
    ].join('\n'));

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    expect(result.verdict).toBe('pass');
    expect(result.verification_status).toBe('evidence_incomplete');
    expect(result.verification_flags.issue_golden_flag_met).toBe('unknown');
    const context = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-context.json'), 'utf8'));
    expect(context.verification_flag_basis).toBe('unsupported');
    expect(context.locale_judgments.valid_ok).toEqual({ L1: 0, L2: 0 });
    expect(context.consistency_warnings.map((warning: any) => warning.code)).toContain('false_ok_in_log');
  });

  it('无效 OK 后面还有一条有效 OK 时，标志保持 true，并记录 2 与 5 的 deviation', async () => {
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(workDir, 'outputs', 'diagnosis-inherited.json'), JSON.stringify({
      parent_run_id: 'run-parent-example',
      issue_golden_flag: 'L1 BUG REPRODUCED: native has 2 preferred languages but PlatformDispatcher.locales length == 1（修复后判据：与 native 列表同长）',
      root_cause_summary: '证据链已闭环。真机实测 confirmed。',
    }));
    writeFileSync(join(workDir, 'outputs', '修复验证-修复方案对抗验证.md'),
      '修复验证 **pass**。L1 OK×2。issue_golden_flag_met=true，engine_aligned=true，bug_fixed=true。');
    writeFileSync(join(workDir, 'outputs', 'ohos-fix2-hilog.txt'), [
      'expected MaterialApp locale from native list: null',
      'L1 OK: dispatcher.locales length (5) matches native preferred language list length (0)',
      'L2 OK: MaterialApp resolved en_US',
      'expected MaterialApp locale from native list: en_US',
      'L1 OK: dispatcher.locales length (5) matches native preferred language list length (5)',
      'L2 OK: MaterialApp resolved en_US',
    ].join('\n'));
    writeFileSync(join(workDir, 'outputs', 'diagnosis-preflight.json'), JSON.stringify({
      runtime_validation: 'blocked_environment', ohos_device_count: 0, android_device_count: 0,
    }));

    const output = await executeDiagnosisScript({
      operation: 'finish', workingDirectory: workDir, runDirectory: runDir, globalContext: '',
    });
    const result = parseConclusion(output);
    expect(result.verification_status).toBe('verified');
    expect(result.verification_flags.issue_golden_flag_met).toBe('true');
    const context = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-context.json'), 'utf8'));
    expect(context.verification_flag_basis).toBe('measured');
    expect(context.golden_flag_deviation).toMatchObject({ frozen_count: 2, executed_count: 5, compatible_with_pass_rule: true });
    expect(context.root_cause_provenance.inherited).toBe(true);
    expect(context.root_cause_summary.startsWith('[继承自 run run-parent-example')).toBe(true);
    expect(context.consistency_warnings.map((warning: any) => warning.code)).toEqual(
      expect.arrayContaining(['false_ok_in_log', 'env_transition_unexplained']),
    );
  });
});
