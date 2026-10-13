import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { executeDiagnosisScript, sanitizeGitRemote } from '../src/lib/workflow/diagnosis-script-step';

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

describe('finish 收尾（F01+F02+F05 集成）', () => {
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
});
