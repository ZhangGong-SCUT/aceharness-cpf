import { describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createSdkOverlay } from '../src/lib/workflow/sdk-overlay';

// P9 真实数据验证：用真实 3.35 SDK 树（含指向已清理工作区的 @ohos/flutter_ohos 越界断链）。
// 修复前：copyLink 对该断链抛「SDK 链接越出根目录」，overlay 失败。
// 修复后：该断链位于 oh_modules 包缓存路径内 → 跳过，overlay 成功。
describe('P9 真实数据验证（3.35 SDK 越界断链）', () => {
  it('P9 真实数据验证（3.35 SDK 越界断链）', () => {
    const sdk = join(homedir(), 'Documents/flutter/flutter3.35.8-ohos');
    const brokenLink = join(sdk, 'packages/integration_test/ohos/oh_modules/@ohos/flutter_ohos');
    if (!existsSync(sdk) || !lstatSync(brokenLink, { throwIfNoEntry: false })?.isSymbolicLink()) {
      console.log('skip: 真实 3.35 SDK 或断链不存在');
      return;
    }
    const overlayDir = mkdtempSync(join(tmpdir(), 'p9-real-overlay-'));
    try {
      const result = createSdkOverlay(sdk, overlayDir);
      expect(existsSync(result.flutterBin!)).toBe(true);
      // 越界断链不应被复制进副本。
      const copiedLink = join(result.sdkLink, 'packages/integration_test/ohos/oh_modules/@ohos/flutter_ohos');
      expect(lstatSync(copiedLink, { throwIfNoEntry: false })).toBeUndefined();
      console.log('✅ P9 修复生效：真实 3.35 SDK overlay 成功，越界断链已跳过');
    } finally {
      rmSync(overlayDir, { recursive: true, force: true });
    }
  }, 120000);
});
