import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  evalInputsDir,
  executeDiagnosisScript,
  readIssueSnapshot,
} from '../src/lib/workflow/diagnosis-script-step';

const SNAPSHOT_BODY = `# 盲测快照标题

## 症状
某 API 在特定时序下表现异常。此为受控回放输入，不含任何修复线索。
`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const tmpRoots: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diag-snapshot-'));
  tmpRoots.push(dir);
  return dir;
}
const writtenSnapshots: string[] = [];
function writeSnapshot(body: string): { path: string; hash: string } {
  mkdirSync(evalInputsDir(), { recursive: true });
  const hash = sha256(body);
  const path = join(evalInputsDir(), `${hash}.md`);
  writeFileSync(path, body);
  writtenSnapshots.push(path);
  return { path, hash };
}
afterAll(async () => {
  await Promise.all([
    ...tmpRoots.map((d) => rm(d, { recursive: true, force: true })),
    ...writtenSnapshots.map((f) => rm(f, { force: true })),
  ]);
});

function parseConclusion(output: string): any {
  const m = /<step-conclusion>([\s\S]*?)<\/step-conclusion>/.exec(output);
  expect(m).toBeTruthy();
  return JSON.parse(m![1]);
}

describe('readIssueSnapshot（F03 路径与完整性约束）', () => {
  it('拒绝目录外路径与错误命名', async () => {
    await expect(readIssueSnapshot('/etc/hostname', '')).rejects.toThrow(/快照路径无效/);
    await expect(readIssueSnapshot(join(evalInputsDir(), '..', 'eval-inputs', 'x.md'), '')).rejects.toThrow(/快照路径无效/);
    await expect(readIssueSnapshot(join(evalInputsDir(), 'notahash.md'), '')).rejects.toThrow(/快照路径无效/);
  });
  it('哈希不一致拒绝使用', async () => {
    const snap = writeSnapshot(SNAPSHOT_BODY);
    await expect(readIssueSnapshot(snap.path, '0'.repeat(64))).rejects.toThrow(/哈希与登记值不一致/);
    const ok = await readIssueSnapshot(snap.path, snap.hash);
    expect(ok.title).toBe('盲测快照标题');
    expect(ok.body).toBe(SNAPSHOT_BODY);
  });
});

describe('preflight 快照通道（F03）', () => {
  it('登记快照时：正文来自快照、不访问线上 API、记录哈希与评估模式', async () => {
    const snap = writeSnapshot(SNAPSHOT_BODY);
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const globalContext = [
      // 故意使用不可达仓库：若代码错误地回退到线上采集，本用例会失败
      'issue-url: https://gitcode.com/no-such-owner-zz/no-such-repo-zz/issues/999999',
      `issue-snapshot-path: ${snap.path}`,
      `issue-snapshot-sha256: ${snap.hash}`,
      'evaluation-mode: guided_replay',
    ].join('\n');
    const output = await executeDiagnosisScript({ operation: 'preflight', workingDirectory: workDir, runDirectory: runDir, globalContext });
    const result = parseConclusion(output);
    expect(result.verdict).toBe('pass');
    expect(result.input_source).toBe('provided_snapshot');
    expect(result.evaluation_mode).toBe('guided_replay');
    expect(result.snapshot_sha256).toBe(snap.hash);

    const saved = JSON.parse(readFileSync(join(runDir, 'outputs', 'diagnosis-input.json'), 'utf8'));
    expect(saved.body).toBe(SNAPSHOT_BODY);
    expect(saved.owner).toBe('no-such-owner-zz');
    expect(saved.repo).toBe('no-such-repo-zz');
    expect(saved.number).toBe('999999');
    expect(saved.snapshot_sha256).toBe(snap.hash);
    expect(basename(snap.path)).toBe(`${snap.hash}.md`);
  });

  it('哈希被篡改时 preflight 失败（不误用输入）', async () => {
    const snap = writeSnapshot(SNAPSHOT_BODY + '\n（篡改内容：附加修复线索）');
    const root = makeTmp();
    const runDir = join(root, 'run');
    const workDir = join(root, 'work');
    mkdirSync(join(workDir, 'outputs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const globalContext = [
      'issue-url: https://gitcode.com/owner/repo/issues/1',
      `issue-snapshot-path: ${snap.path}`,
      `issue-snapshot-sha256: ${'0'.repeat(64)}`,
    ].join('\n');
    const output = await executeDiagnosisScript({ operation: 'preflight', workingDirectory: workDir, runDirectory: runDir, globalContext });
    const result = parseConclusion(output);
    expect(result.verdict).toBe('fail');
    expect(result.summary).toMatch(/哈希与登记值不一致/);
  });
});
