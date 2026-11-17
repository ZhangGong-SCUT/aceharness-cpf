/**
 * 真实 git 仓上的精确版本对齐集成实测。
 *
 * 默认跳过。设置 ACE_VERSION_ALIGN_IT=1 且本机存在
 * /Users/flutter/Documents/flutter/flutter3.41-ohos 时才运行。
 * - plan：只读探测真实仓的 tag / 当前版本，断言判定正确。
 * - worktree：在临时目录真实派生 canary1 副本并校验 HEAD，结束清理。
 *   不跑完整 precache（耗时数分钟下载）；precache 路径由单测 mock 覆盖。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, test } from 'vitest';
import { alignVersionToTag, extractPreciseVersionTag, planVersionAlign, readAlignedEngineOhosVersion } from '@/lib/workflow/version-align';

const exec = promisify(execFile);
const REAL_SDK = '/Users/flutter/Documents/flutter/flutter3.41-ohos';
const CANARY = '3.41.10-ohos-0.0.1-canary1';
const RUN = process.env.ACE_VERSION_ALIGN_IT === '1' && existsSync(join(REAL_SDK, 'bin', 'flutter'));
const created: string[] = [];

afterAll(async () => {
  // 清理真实仓里残留的 worktree 登记，避免污染日常 SDK
  for (const dir of created) {
    await exec('git', ['-C', REAL_SDK, 'worktree', 'remove', '--force', dir]).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  await exec('git', ['-C', REAL_SDK, 'worktree', 'prune']).catch(() => {});
});

describe.skipIf(!RUN)('version-align 真实仓集成', () => {
  test('从真实 Issue 文本提取精确 tag', () => {
    expect(extractPreciseVersionTag('环境：Flutter 3.41.10-ohos-0.0.1-canary1，Mate X5 白屏')).toBe(CANARY);
  });

  test('planVersionAlign 在真实 beta2 仓上判定需要对齐到 canary1', async () => {
    const plan = await planVersionAlign({ sdkRoot: REAL_SDK, preciseTag: CANARY });
    expect(plan.tagExists).toBe(true);
    expect(plan.sameMajor).toBe(true);
    expect(plan.currentTag).toContain('0.0.2-beta');
    expect(plan.needed).toBe(true);
  }, 20000);

  test('planVersionAlign 对当前已对齐 tag 判定无需对齐', async () => {
    const { stdout } = await exec('git', ['-C', REAL_SDK, 'describe', '--tags']);
    const current = stdout.trim();
    const plan = await planVersionAlign({ sdkRoot: REAL_SDK, preciseTag: current });
    expect(plan.needed).toBe(false);
    expect(plan.reason).toContain('已处于');
  }, 20000);

  test('alignVersionToTag 真实派生 canary1 worktree，HEAD 与 engine.ohos.version 正确', async () => {
    const overlay = await mkdtemp(join(tmpdir(), 'valign-it-'));
    created.push(join(overlay, 'aligned-sdk'));
    // precache:false —— 完整二进制下载由单测 mock 与人工实测覆盖，这里只验证真实 git 派生。
    const result = await alignVersionToTag({ sdkRoot: REAL_SDK, targetTag: CANARY, overlayDir: overlay, precache: false });
    expect(result.aligned).toBe(true);
    expect(result.alignedSdkRoot).toBeTruthy();
    const wt = result.alignedSdkRoot!;
    // 真实校验：worktree HEAD 描述为 canary1
    const { stdout: desc } = await exec('git', ['-C', wt, 'describe', '--tags']);
    expect(desc.trim()).toBe(CANARY);
    // engine.ohos.version 是 canary1 的 437f5210...
    expect(await readAlignedEngineOhosVersion(wt)).toBe('437f52104c5cc79b13c70aaacdf115c8f9116d47');
    // 共享 SDK 的 HEAD 未被改动（仍是 beta2 系）
    const { stdout: sharedDesc } = await exec('git', ['-C', REAL_SDK, 'describe', '--tags']);
    expect(sharedDesc.trim()).toContain('0.0.2-beta');
  }, 60000);
});
