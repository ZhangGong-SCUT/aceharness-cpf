import { describe, expect, test } from 'vitest';
import { redactOfficialFixLeak, shouldRedactOfficialFixForStep } from '@/lib/workflow/official-fix-redact';

describe('redactOfficialFixLeak', () => {
  test('redacts #2012-style collection leak but keeps issue number and reset hash', () => {
    const input = [
      'Issue #2012 前置摄像头 PixelMap 采集完成。',
      'reset_target_merge_commit: 36aa4630c5e',
      '维护者已在 PR #1392 修复：https://gitcode.com/CPF-Flutter/flutter_flutter/pull/1392',
      '对照该 PR 修法即可。git apply 官方 commit 5a8db03a7cf',
    ].join('\n');
    const result = redactOfficialFixLeak(input);
    expect(result.redacted).toBe(true);
    expect(result.text).toContain('Issue #2012');
    expect(result.text).toContain('36aa4630c5e');
    expect(result.text).not.toMatch(/PR\s*#?\s*1392/i);
    expect(result.text).not.toContain('gitcode.com/CPF-Flutter/flutter_flutter/pull/1392');
    expect(result.text).not.toMatch(/对照该 PR/);
    expect(result.text).not.toMatch(/git apply/);
  });

  test('redacts #2322-style merged-PR comments', () => {
    const input = 'Issue #2322 Scaffold。评论：代码已合入 PR #1701，另见 PR 1732。';
    const result = redactOfficialFixLeak(input);
    expect(result.redacted).toBe(true);
    expect(result.text).toContain('Issue #2322');
    expect(result.text).not.toMatch(/PR\s*#?\s*1701/i);
    expect(result.text).not.toMatch(/PR\s*#?\s*1732/i);
    expect(result.text).not.toMatch(/已合入/);
  });

  test('does not redact a clean collection summary', () => {
    const input = 'Issue #2490 空文件名 File.create。reset_target_merge_commit: abcdef1234567。维护者称后续有修复。';
    const result = redactOfficialFixLeak(input);
    expect(result.redacted).toBe(false);
    expect(result.text).toBe(input);
  });
});

describe('shouldRedactOfficialFixForStep', () => {
  test('only redacts collection steps', () => {
    expect(shouldRedactOfficialFixForStep('信息采集', 'Issue信息采集')).toBe(true);
    expect(shouldRedactOfficialFixForStep('代码修复', '代码修改实施')).toBe(false);
    expect(shouldRedactOfficialFixForStep('修复验证', '修复方案对抗验证')).toBe(false);
  });
});
