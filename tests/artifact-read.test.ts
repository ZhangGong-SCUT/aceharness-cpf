import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunArtifact } from '../aiweb/Server/issueAnalysis/artifacts.js';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readRunArtifact', () => {
  it('能读归档产物，并按 run 记录的工作目录读 work 产物', () => {
    const runId = `run-artifact-test-${Date.now()}`;
    const arch = join(homedir(), '.aceharness', 'runs', runId);
    const work = mkdtempSync(join(tmpdir(), 'ace-artifact-work-'));
    created.push(arch, work);
    mkdirSync(join(arch, 'outputs'), { recursive: true });
    mkdirSync(join(work, 'outputs'), { recursive: true });
    writeFileSync(join(arch, 'state.yaml'), `workingDirectory: ${work}\n`);
    writeFileSync(join(arch, 'outputs', 'note.md'), 'arch-ok\n');
    writeFileSync(join(work, 'outputs', 'fix.patch'), 'diff --git a/a b/a\n');
    writeFileSync(join(work, 'outputs', 'shot.jpeg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const archFile = readRunArtifact(runId, 'arch/note.md');
    const patch = readRunArtifact(runId, 'work/fix.patch');
    const shot = readRunArtifact(runId, 'work/shot.jpeg');
    expect(archFile.buffer.toString()).toContain('arch-ok');
    expect(patch.buffer.toString()).toContain('diff --git');
    expect(shot.kind).toBe('image');
    expect(shot.contentType).toBe('image/jpeg');
    expect(shot.buffer[0]).toBe(0xff);
  });

  it('运行时根在家目录外时仍能读取归档产物', () => {
    const outside = mkdtempSync(join(realpathSync(tmpdir()), 'ace-home-'));
    created.push(outside);
    expect(outside.startsWith(homedir())).toBe(false);
    const previousHome = process.env.ACE_HOME;
    const previousTrust = process.env.ISSUEANALYSIS_TRUST_ROOT;
    process.env.ACE_HOME = outside;
    process.env.ISSUEANALYSIS_TRUST_ROOT = homedir();
    try {
      const runId = 'run-1794196948113-ia-586278c1';
      const outputs = join(outside, 'runs', runId, 'outputs');
      mkdirSync(join(outputs, 'step-logs'), { recursive: true });
      writeFileSync(join(outputs, '终止-终止记录.md'), 'stopped\n');
      writeFileSync(join(outputs, 'step-logs', '终止-终止记录-098e2acf-b65d-4b3f-a094-b91919d4fe03.md'), 'step-log\n');
      expect(readRunArtifact(runId, 'arch/终止-终止记录.md').buffer.toString()).toContain('stopped');
      expect(readRunArtifact(runId, 'arch/step-logs/终止-终止记录-098e2acf-b65d-4b3f-a094-b91919d4fe03.md').buffer.toString()).toContain('step-log');
    } finally {
      restoreEnv('ACE_HOME', previousHome);
      restoreEnv('ISSUEANALYSIS_TRUST_ROOT', previousTrust);
    }
  });

  it('运行时根里的符号链接不能把外部目录变成可信产物', () => {
    const outside = mkdtempSync(join(realpathSync(tmpdir()), 'ace-outside-'));
    const runtime = mkdtempSync(join(realpathSync(tmpdir()), 'ace-runtime-'));
    created.push(outside, runtime);
    const previousHome = process.env.ACE_HOME;
    process.env.ACE_HOME = runtime;
    try {
      const runId = 'run-linked';
      mkdirSync(join(outside, runId, 'outputs'), { recursive: true });
      writeFileSync(join(outside, runId, 'outputs', 'note.md'), 'secret\n');
      symlinkSync(outside, join(runtime, 'runs'));
      expect(() => readRunArtifact(runId, 'arch/note.md')).toThrow('路径不合法：产物目录不在可信根内');
    } finally {
      restoreEnv('ACE_HOME', previousHome);
    }
  });
});

function restoreEnv(key: 'ACE_HOME' | 'ISSUEANALYSIS_TRUST_ROOT', value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('产物可信根的路径比较', () => {
  it('Windows 跨盘和 POSIX 家目录外都会被 relative 判到根外', () => {
    const windowsRel = win32.relative('C:\\Users\\20367', 'D:\\aceharness-data\\runs\\run\\outputs');
    expect(windowsRel.startsWith('..') || win32.isAbsolute(windowsRel)).toBe(true);
    const windowsFixed = win32.relative('D:\\aceharness-data', 'D:\\aceharness-data\\runs\\run\\outputs');
    expect(windowsFixed.startsWith('..') || win32.isAbsolute(windowsFixed)).toBe(false);

    const posixRel = posix.relative('/home/20367', '/data/aceharness/runs/run/outputs');
    expect(posixRel.startsWith('..') || posix.isAbsolute(posixRel)).toBe(true);
    const posixFixed = posix.relative('/data/aceharness', '/data/aceharness/runs/run/outputs');
    expect(posixFixed.startsWith('..') || posix.isAbsolute(posixFixed)).toBe(false);
  });
});
