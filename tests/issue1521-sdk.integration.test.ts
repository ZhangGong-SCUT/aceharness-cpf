import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { prepareIssueSdkOverlay } from '@/lib/workflow/align-issue-sdk';
import { removeSdkOverlaySnapshot } from '@/lib/workflow/sdk-overlay';
import { verifyAlignedArtifacts } from '@/lib/workflow/version-align';

/** 真实 #1521 SDK 对齐；ACE_ISSUE1521_SDK_IT=1 时执行真实 precache。 */
const SDK = '/Users/flutter/Documents/flutter/flutter3.35.8-ohos';
const BASELINE = '3107696e8ae429e95292d00d038e26ab7ca379c3';
const RUN = process.env.ACE_ISSUE1521_SDK_IT === '1' && existsSync(join(SDK, 'bin', 'flutter'));

describe.skipIf(!RUN)('#1521 真实历史 SDK', () => {
  test('固定基线、隔离缓存、校验引擎、保留共享 SDK', async () => {
    const overlayDir = join(mkdtempSync(join(tmpdir(), 'issue1521-sdk-')), 'sdk-overlay');
    const git = (...args: string[]) => execFileSync('git', ['-C', SDK, ...args], { encoding: 'utf8' }).trim();
    const headBefore = git('rev-parse', 'HEAD');
    const dirtyBefore = git('status', '--porcelain');
    try {
      const pin = await prepareIssueSdkOverlay({
        resolved: { matched: true, branch: 'oh-3.35.7-dev', versionHint: '3.35.7', sdkId: '3.35.7-ohos',
          sdkRoot: SDK, flutterBin: join(SDK, 'bin', 'flutter'), dailySdk: null, inventory: [], reason: '真实 #1521 测试' },
        overlayDir,
        target: { collectorCommit: BASELINE, issueCreatedAt: '2026-02-01T14:01:19+08:00', branch: 'oh-3.35.7-dev' },
      });
      expect(pin.versionAlign).toMatchObject({ aligned: true, artifactVerified: true, targetCommit: BASELINE,
        expectedEngine: '035316565ad77281a75305515e4682e6c4c6f7ca',
        expectedOhosEngine: 'b15356702b41d3bd6a857d588ab21e85e54c174a' });
      expect(execFileSync('git', ['-C', pin.sdkRoot!, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(BASELINE);
      expect(pin.flutterBin).toContain(overlayDir);
      expect(pin.sdkRoot).not.toBe(SDK);
      expect((await verifyAlignedArtifacts(pin.sourceSdkRoot!)).artifactVerified).toBe(true);
      expect(git('rev-parse', 'HEAD')).toBe(headBefore);
      expect(git('status', '--porcelain')).toBe(dirtyBefore);
      const version = execFileSync(pin.flutterBin!, ['--version', '--no-version-check'], { encoding: 'utf8', timeout: 120000 });
      expect(version).toContain(BASELINE.slice(0, 10));
      await writeFile(join(overlayDir, 'real-verification.json'), JSON.stringify({ issue: 1521, pin, version }, null, 2));
      console.log(JSON.stringify({ ok: true, overlayDir, target: BASELINE, engine: pin.versionAlign?.expectedOhosEngine,
        sourceSdkRoot: pin.sourceSdkRoot, sharedHeadUnchanged: git('rev-parse', 'HEAD') === headBefore }));
    } finally {
      // ACE_ISSUE1521_SDK_KEEP=1 保留真实构建环境供后续 Demo 构建；默认清理 worktree。
      if (process.env.ACE_ISSUE1521_SDK_KEEP !== '1') await removeSdkOverlaySnapshot(overlayDir);
    }
  }, 15 * 60 * 1000);
});
