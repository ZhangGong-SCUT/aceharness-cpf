import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunArtifact } from '../aiweb/Server/issueAnalysis/artifacts.js';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readRunArtifact', () => {
  it('在 Linux 上能读归档产物，并按 run 记录的工作目录读 work 产物', () => {
    const runId = `run-artifact-test-${Date.now()}`;
    const arch = join(homedir(), '.aceharness', 'runs', runId);
    const work = mkdtempSync(join(tmpdir(), 'ace-artifact-work-'));
    created.push(arch, work);
    mkdirSync(join(arch, 'outputs'), { recursive: true });
    mkdirSync(join(work, 'outputs'), { recursive: true });
    writeFileSync(join(arch, 'state.yaml'), `workingDirectory: ${work}\n`);
    writeFileSync(join(arch, 'outputs', 'note.md'), 'arch-ok\n');
    writeFileSync(join(work, 'outputs', 'fix.patch'), 'diff --git a/a b/a\n');

    const archFile = readRunArtifact(runId, 'arch/note.md');
    const patch = readRunArtifact(runId, 'work/fix.patch');
    expect(archFile.buffer.toString()).toContain('arch-ok');
    expect(patch.buffer.toString()).toContain('diff --git');
  });
});
