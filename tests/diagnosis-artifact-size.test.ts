import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { compactLogBuffer, compactOutputLogs, pruneDiagnosisScratch } from '../scripts/diagnosis-artifact-size.mjs';

const roots: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diag-size-'));
  roots.push(dir);
  return dir;
}
afterAll(async () => { await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('诊断产物瘦身', () => {
  it('超大日志只留开头和结尾', () => {
    const source = Buffer.concat([Buffer.from('HEAD'), Buffer.alloc(4000, 65), Buffer.from('TAIL')]);
    const compact = compactLogBuffer(source, 256);
    expect(compact.length).toBeLessThanOrEqual(256);
    expect(compact.toString()).toContain('HEAD');
    expect(compact.toString()).toContain('TAIL');
    expect(compact.toString()).toContain('已截断');
    expect(compactLogBuffer(Buffer.from('short'), 40).toString()).toBe('short');
  });

  it('删掉 demo 编译缓存，保留 outputs 和 repo 里的 build 目录', async () => {
    const root = makeTmp();
    const outside = join(root, 'outside');
    const workspace = join(root, 'work');
    mkdirSync(join(workspace, 'demo', 'ohos', 'entry', 'build'), { recursive: true });
    mkdirSync(join(workspace, 'demo', '.dart_tool'), { recursive: true });
    mkdirSync(join(workspace, 'demo', 'ohos', 'oh_modules'), { recursive: true });
    mkdirSync(join(workspace, 'outputs', 'build'), { recursive: true });
    mkdirSync(join(workspace, 'repo', 'engine', 'src', 'build'), { recursive: true });
    mkdirSync(join(workspace, '.opencode'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(workspace, 'demo', 'ohos', 'entry', 'build', 'app.hap'), 'hap');
    writeFileSync(join(workspace, 'demo', '.dart_tool', 'package_config.json'), '{}');
    writeFileSync(join(workspace, 'outputs', 'fix.patch'), 'patch');
    writeFileSync(join(workspace, 'outputs', 'build', 'keep.txt'), 'keep');
    writeFileSync(join(workspace, 'repo', 'engine', 'src', 'build', 'keep.cc'), 'cc');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(workspace, 'demo', 'ohos', 'node_modules'));

    const result = await pruneDiagnosisScratch(workspace);
    expect(result.removed).toEqual(expect.arrayContaining([
      'demo/ohos/entry/build', 'demo/.dart_tool', 'demo/ohos/oh_modules', 'demo/ohos/node_modules', '.opencode',
    ]));
    expect(existsSync(join(workspace, 'demo', 'ohos', 'entry', 'build'))).toBe(false);
    expect(existsSync(join(workspace, 'outputs', 'fix.patch'))).toBe(true);
    expect(existsSync(join(workspace, 'outputs', 'build', 'keep.txt'))).toBe(true);
    expect(existsSync(join(workspace, 'repo', 'engine', 'src', 'build', 'keep.cc'))).toBe(true);
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
    expect(existsSync(join(workspace, 'demo', 'ohos', 'node_modules'))).toBe(false);
  });

  it('outputs 里的超大 hilog 被截断', async () => {
    const workspace = join(makeTmp(), 'work');
    mkdirSync(join(workspace, 'outputs'), { recursive: true });
    writeFileSync(join(workspace, 'outputs', 'ohos-hilog.txt'), `HEAD${'x'.repeat(5000)}TAIL`);
    writeFileSync(join(workspace, 'outputs', 'fix.patch'), 'patch');
    const compacted = await compactOutputLogs(join(workspace, 'outputs'), 200);
    expect(compacted).toHaveLength(1);
    const text = readFileSync(join(workspace, 'outputs', 'ohos-hilog.txt'), 'utf8');
    expect(text.startsWith('HEAD')).toBe(true);
    expect(text.endsWith('TAIL')).toBe(true);
    expect(statSync(join(workspace, 'outputs', 'ohos-hilog.txt')).size).toBeLessThanOrEqual(200);
    expect(readFileSync(join(workspace, 'outputs', 'fix.patch'), 'utf8')).toBe('patch');
  });
});
