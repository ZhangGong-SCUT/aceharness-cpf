import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivePrRunArtifacts, snapshotPrArtifact, sha256File } from '@/lib/workflow/pr-artifacts';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pr-archive-'));
  dirs.push(dir);
  const workingDirectory = join(dir, 'work');
  const runDirectory = join(dir, 'run');
  await mkdir(join(workingDirectory, 'outputs', 'sub'), { recursive: true });
  await mkdir(join(runDirectory, 'outputs'), { recursive: true });
  return { workingDirectory, runDirectory };
}

describe('PR 产物归档（R4）', () => {
  test('递归归档工作目录 outputs 全部普通文件（含子目录），记录 hash 并写 manifest', async () => {
    const { workingDirectory, runDirectory } = await fixture();
    await writeFile(join(workingDirectory, 'outputs/fix.patch'), 'diff --git a b\n');
    await writeFile(join(workingDirectory, 'outputs/push-result.json'), JSON.stringify({ commit_sha: 'abc' }));
    await writeFile(join(workingDirectory, 'outputs/sub/ci.log'), 'compile failed\n');

    const result = await archivePrRunArtifacts({ workingDirectory, runDirectory });
    expect(result.artifact_status).toBe('complete');
    expect(result.manifest).toBe('outputs/pr-archive-manifest.json');

    const manifest = JSON.parse(await readFile(join(runDirectory, 'outputs/pr-archive-manifest.json'), 'utf8'));
    const names = manifest.entries.map((e: any) => e.name).sort();
    expect(names).toEqual(['fix.patch', 'push-result.json', 'sub/ci.log']);
    for (const entry of manifest.entries) {
      expect(entry.status).toBe('archived');
      expect(entry.sha256).toBe(await sha256File(join(workingDirectory, 'outputs', entry.name)));
      // 回读：归档文件内容与 hash 一致
      expect(await sha256File(join(runDirectory, 'outputs', entry.name))).toBe(entry.sha256);
    }
  });

  test('清理工作目录后归档仍可独立读回', async () => {
    const { workingDirectory, runDirectory } = await fixture();
    await writeFile(join(workingDirectory, 'outputs/gate-source.json'), JSON.stringify({ pullComments: [1, 2, 3] }));
    await archivePrRunArtifacts({ workingDirectory, runDirectory });
    await rm(workingDirectory, { recursive: true, force: true });
    expect(JSON.parse(await readFile(join(runDirectory, 'outputs/gate-source.json'), 'utf8'))).toEqual({ pullComments: [1, 2, 3] });
  });

  test('分版快照保留每次尝试的 push/gate/patch，不被后续覆盖', async () => {
    const { workingDirectory, runDirectory } = await fixture();
    await writeFile(join(runDirectory, 'outputs/push-result.json'), JSON.stringify({ commit_sha: 'aaa', pushed_at: '2026-10-14T01:00:00Z' }));
    const first = await snapshotPrArtifact({ name: 'push-result.json', tag: '2026-10-14T01:00:00Z-aaa', runDirectory, workingDirectory });
    expect(first?.status).toBe('archived');
    // 第二次 push 覆盖 run outputs 的当前文件，但第一版历史仍在
    await writeFile(join(runDirectory, 'outputs/push-result.json'), JSON.stringify({ commit_sha: 'bbb', pushed_at: '2026-10-14T02:00:00Z' }));
    await snapshotPrArtifact({ name: 'push-result.json', tag: '2026-10-14T02:00:00Z-bbb', runDirectory, workingDirectory });
    const v1 = JSON.parse(await readFile(join(runDirectory, 'outputs/history/2026-10-14T01:00:00Z-aaa/push-result.json'), 'utf8'));
    const v2 = JSON.parse(await readFile(join(runDirectory, 'outputs/history/2026-10-14T02:00:00Z-bbb/push-result.json'), 'utf8'));
    expect(v1.commit_sha).toBe('aaa');
    expect(v2.commit_sha).toBe('bbb');
  });

  test('归档目标包含符号链接时拒收该条目并标 failed', async () => {
    const { workingDirectory, runDirectory } = await fixture();
    const outside = join(workingDirectory, 'outside.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(workingDirectory, 'outputs/leak.txt'));
    const result = await archivePrRunArtifacts({ workingDirectory, runDirectory });
    expect(result.artifact_status).toBe('failed');
    expect(existsSync(join(runDirectory, 'outputs/leak.txt'))).toBe(false);
    const entry = result.entries.find((e) => e.name === 'leak.txt');
    expect(entry?.status).toBe('failed');
  });
});
