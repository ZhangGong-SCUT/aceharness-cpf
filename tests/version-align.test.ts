import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  alignVersionToTag,
  extractPreciseVersionTag,
  majorTripleOfTag,
  planVersionAlign,
  historicalCommitFromCollection,
  normalizeIssueCreatedAt,
  sdkSeriesOf,
  verifyAlignedArtifacts,
  readAlignedEngineOhosVersion,
} from '@/lib/workflow/version-align';

function fakeSdk(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `valign-${name}-`));
  mkdirSync(join(root, 'bin', 'cache', 'artifacts', 'engine', 'ohos-arm64'), { recursive: true });
  mkdirSync(join(root, 'bin', 'internal'), { recursive: true });
  writeFileSync(join(root, 'bin', 'flutter'), '#!/bin/sh\n');
  writeFileSync(join(root, 'bin', 'internal', 'engine.ohos.version'), 'abc123\n');
  return root;
}

describe('extractPreciseVersionTag', () => {
  test('extracts full minor-version tag', () => {
    expect(extractPreciseVersionTag('Flutter 3.41.10-ohos-0.0.1-canary1 出现异常')).toBe('3.41.10-ohos-0.0.1-canary1');
    expect(extractPreciseVersionTag('版本 3.41.10-ohos-0.0.2-beta')).toBe('3.41.10-ohos-0.0.2-beta');
    expect(extractPreciseVersionTag('3.7.12-ohos-1.0.0')).toBe('3.7.12-ohos-1.0.0');
  });
  test('ignores bare major version and branch names', () => {
    expect(extractPreciseVersionTag('Flutter 3.41.10')).toBeNull();
    expect(extractPreciseVersionTag('oh-3.41.9-dev')).toBeNull();
    expect(extractPreciseVersionTag('3.44.9-ohos-0.0.1-beta')).toBe('3.44.9-ohos-0.0.1-beta');
    expect(extractPreciseVersionTag('没有版本号')).toBeNull();
  });
});

describe('majorTripleOfTag', () => {
  test('returns major triple', () => {
    expect(majorTripleOfTag('3.41.10-ohos-0.0.1-canary1')).toBe('3.41.10');
    expect(majorTripleOfTag('3.7.12-ohos-1.0.0')).toBe('3.7.12');
  });
  test('null for non-tag', () => {
    expect(majorTripleOfTag('3.41.10')).toBeNull();
    expect(majorTripleOfTag('dev')).toBeNull();
  });
});

describe('planVersionAlign', () => {
  test('no precise tag -> not needed', async () => {
    const plan = await planVersionAlign({ sdkRoot: '/x', preciseTag: null });
    expect(plan.needed).toBe(false);
    expect(plan.reason).toContain('未声明');
  });

  test('already on target tag -> not needed', async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (args.includes('describe')) return { stdout: '3.41.10-ohos-0.0.1-canary1\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }) as any;
    const plan = await planVersionAlign({ sdkRoot: '/x', preciseTag: '3.41.10-ohos-0.0.1-canary1', exec });
    expect(plan.needed).toBe(false);
    expect(plan.reason).toContain('已处于');
  });

  test('different minor tag, same series, tag exists -> needed', async () => {
    const sha = 'a'.repeat(40);
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (args.includes('describe')) return { stdout: '3.41.10-ohos-0.0.2-beta-143-gc2adf95b00d\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: `${'b'.repeat(40)}\n`, stderr: '' };
      if (args.includes('rev-parse')) return { stdout: `${sha}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    }) as any;
    const plan = await planVersionAlign({ sdkRoot: '/x', preciseTag: '3.41.10-ohos-0.0.1-canary1', exec });
    expect(plan.needed).toBe(true);
    expect(plan.tagExists).toBe(true);
    expect(plan.sameMajor).toBe(true);
    expect(plan.currentTag).toContain('0.0.2-beta');
  });

  test('3.35.7 and 3.35.8 are the same SDK series', async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (args.includes('describe')) return { stdout: '3.35.8-ohos-0.0.3-139-ged66bcae6bd\n', stderr: '' };
      if (args.includes('HEAD')) return { stdout: `${'d'.repeat(40)}\n`, stderr: '' };
      if (args.includes('rev-parse')) return { stdout: `${'c'.repeat(40)}\n`, stderr: '' };
    }) as any;
    const plan = await planVersionAlign({ sdkRoot: '/x', preciseTag: '3.35.7-ohos-0.0.1', exec });
    expect(plan.sameMajor).toBe(true);
    expect(plan.needed).toBe(true);
  });

  test('tag missing locally -> not needed, needs fetch', async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (args.includes('describe')) return { stdout: '3.41.10-ohos-0.0.2-beta\n', stderr: '' };
      if (args.includes('rev-parse')) throw new Error('unknown revision');
      return { stdout: '', stderr: '' };
    }) as any;
    const plan = await planVersionAlign({ sdkRoot: '/x', preciseTag: '3.41.10-ohos-0.0.1-canary1', exec });
    expect(plan.needed).toBe(false);
    expect(plan.tagExists).toBe(false);
    expect(plan.reason).toContain('不存在');
  });

  test('different major -> not aligned', async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (args.includes('describe')) return { stdout: '3.44.9-ohos-0.0.1-beta\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    }) as any;
    const plan = await planVersionAlign({ sdkRoot: '/x', preciseTag: '3.41.10-ohos-0.0.1-canary1', exec });
    expect(plan.needed).toBe(false);
    expect(plan.sameMajor).toBe(false);
    expect(plan.reason).toContain('不属于同一 Flutter 系列');
  });
});

describe('Issue 历史基线与引擎证据', () => {
  test('只接受 reset 成功的完整采集 commit', () => {
    expect(historicalCommitFromCollection({ reset_status: 'success', reset_target_merge_commit: 'a'.repeat(40) })).toBe('a'.repeat(40));
    expect(historicalCommitFromCollection({ reset_status: 'skipped_no_issue_date', reset_target_merge_commit: 'a'.repeat(40) })).toBeNull();
    expect(historicalCommitFromCollection({ reset_status: 'success', reset_target_merge_commit: 'HEAD' })).toBeNull();
    expect(normalizeIssueCreatedAt('2026-02-01T14:01:19+08:00')).toBe('2026-02-01T06:01:19.000Z');
    expect(normalizeIssueCreatedAt('not-a-date')).toBeNull();
    expect(sdkSeriesOf('3.35.8')).toBe('3.35');
  });

  test('没有 tag 时优先采集器 commit，不重新按时间猜', async () => {
    const target = 'a'.repeat(40);
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('describe')) return { stdout: '3.35.8-ohos-0.0.3-139-ged66bcae6bd', stderr: '' };
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'b'.repeat(40), stderr: '' };
      if (args.includes('rev-list')) throw new Error('采集 commit 存在时不允许重新查时间历史');
      if (args.includes('%cI') || args.includes('show')) return { stdout: '2026-01-31T16:50:51+08:00', stderr: '' };
      return { stdout: target, stderr: '' };
    }) as any;
    const plan = await planVersionAlign({ sdkRoot: '/x', preciseTag: null, collectorCommit: target,
      issueCreatedAt: '2026-02-01T14:01:19+08:00', branch: 'oh-3.35.7-dev', exec });
    expect(plan).toMatchObject({ needed: true, targetCommit: target, source: 'collector_commit' });
  });

  test('浅仓空历史与晚于 Issue 的提交均拒绝，不回退 HEAD', async () => {
    const noHistory = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('describe')) return { stdout: '3.35.8-ohos-0.0.3', stderr: '' };
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'b'.repeat(40), stderr: '' };
      return { stdout: '', stderr: '' };
    }) as any;
    const shallow = await planVersionAlign({ sdkRoot: '/x', preciseTag: null,
      issueCreatedAt: '2026-02-01T14:01:19+08:00', branch: 'oh-3.35.7-dev', exec: noHistory });
    expect(shallow.needed).toBe(false);
    expect(shallow.reason).toContain('禁止用当前 HEAD');

    const late = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('HEAD') && !args.includes('rev-parse')) return { stdout: 'b'.repeat(40), stderr: '' };
      if (args.includes('%cI')) return { stdout: '2026-04-15T00:00:00+08:00', stderr: '' };
      return { stdout: 'a'.repeat(40), stderr: '' };
    }) as any;
    const plan = await planVersionAlign({ sdkRoot: '/x', preciseTag: null, collectorCommit: 'a'.repeat(40),
      issueCreatedAt: '2026-02-01T14:01:19+08:00', exec: late });
    expect(plan.needed).toBe(false);
    expect(plan.reason).toContain('不在 Issue 创建时间');
  });

  test('precache 退出成功也不能掩盖旧引擎 stamp', async () => {
    const root = fakeSdk('stamps');
    writeFileSync(join(root, 'bin', 'internal', 'engine.version'), '035316565ad77281a75305515e4682e6c4c6f7ca\n');
    writeFileSync(join(root, 'bin', 'internal', 'engine.ohos.version'), 'b15356702b41d3bd6a857d588ab21e85e54c174a\n');
    writeFileSync(join(root, 'bin', 'cache', 'engine.stamp'), '035316565ad77281a75305515e4682e6c4c6f7ca\n');
    writeFileSync(join(root, 'bin', 'cache', 'engine.ohos.stamp'), '0977a3517833e1d418ff7c5667c863d7decd6853\n');
    const evidence = await verifyAlignedArtifacts(root);
    expect(evidence.artifactVerified).toBe(false);
    expect(evidence.reason).toContain('engine.ohos.stamp');
    writeFileSync(join(root, 'bin', 'cache', 'engine.ohos.stamp'), 'b15356702b41d3bd6a857d588ab21e85e54c174a\n');
    writeFileSync(join(root, 'bin', 'cache', 'artifacts', 'engine', 'ohos-arm64', 'libflutter.so'), 'engine');
    expect((await verifyAlignedArtifacts(root)).artifactVerified).toBe(true);
  });
});

describe('alignVersionToTag', () => {
  test('worktree + precache success', async () => {
    const sdkRoot = fakeSdk('src');
    const overlay = mkdtempSync(join(tmpdir(), 'valign-overlay-'));
    const calls: string[][] = [];
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { stdout: '', stderr: '' };
    }) as any;
    const result = await alignVersionToTag({
      sdkRoot, targetTag: '3.41.10-ohos-0.0.1-canary1', overlayDir: overlay, exec, flutterBin: '/fake/flutter',
      checkArtifacts: async () => ({ artifactVerified: true, expectedEngine: 'e1', expectedOhosEngine: 'o1', actualEngine: 'e1', actualOhosEngine: 'o1', reason: 'ok' }),
    });
    expect(result.aligned).toBe(true);
    expect(result.precacheOk).toBe(true);
    expect(result.alignedSdkRoot).toContain('aligned-sdk');
    // 校验依次调用了 worktree add 与 precache
    expect(calls.some(c => c.includes('worktree') && c.includes('add'))).toBe(true);
    expect(calls.some(c => c.includes('precache') && c.includes('--ohos'))).toBe(true);
  });

  test('worktree failure -> not aligned, error captured', async () => {
    const sdkRoot = fakeSdk('src2');
    const overlay = mkdtempSync(join(tmpdir(), 'valign-overlay-'));
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (args.includes('add')) { const e: any = new Error('worktree failed'); e.stderr = 'fatal: invalid reference'; throw e; }
      return { stdout: '', stderr: '' };
    }) as any;
    const result = await alignVersionToTag({
      sdkRoot, targetTag: '3.41.10-ohos-0.0.1-canary1', overlayDir: overlay, exec, flutterBin: '/fake/flutter',
    });
    expect(result.aligned).toBe(false);
    expect(result.error).toContain('invalid reference');
  });

  test('precache failure still returns aligned source but precacheOk=false', async () => {
    const sdkRoot = fakeSdk('src3');
    const overlay = mkdtempSync(join(tmpdir(), 'valign-overlay-'));
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (args.includes('precache')) { const e: any = new Error('network'); e.stderr = 'download timeout'; throw e; }
      return { stdout: '', stderr: '' };
    }) as any;
    const result = await alignVersionToTag({
      sdkRoot, targetTag: '3.41.10-ohos-0.0.1-canary1', overlayDir: overlay, exec, flutterBin: '/fake/flutter',
    });
    expect(result.aligned).toBe(true);
    expect(result.precacheOk).toBe(false);
    expect(result.reason).toContain('precache 失败');
  });

  test('precache disabled skips binary download', async () => {
    const sdkRoot = fakeSdk('src4');
    const overlay = mkdtempSync(join(tmpdir(), 'valign-overlay-'));
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' })) as any;
    const result = await alignVersionToTag({
      sdkRoot, targetTag: '3.41.10-ohos-0.0.1-canary1', overlayDir: overlay, precache: false, exec, flutterBin: '/fake/flutter',
    });
    expect(result.aligned).toBe(true);
    expect(result.precacheOk).toBe(false);
    expect(exec).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['precache']));
  });
});

describe('readAlignedEngineOhosVersion', () => {
  test('reads engine.ohos.version from aligned copy', async () => {
    const sdk = fakeSdk('eng');
    expect(await readAlignedEngineOhosVersion(sdk)).toBe('abc123');
  });
  test('null when missing', async () => {
    expect(await readAlignedEngineOhosVersion('/nonexistent')).toBeNull();
  });
});
