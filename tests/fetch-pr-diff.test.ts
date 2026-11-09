import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { looksLikeDiff, pullDiffApiPath, unifiedDiffFromPullFiles } from '../skills/gitcode-pr-review/scripts/fetch-pr-diff.mjs';

const source = readFileSync(fileURLToPath(new URL('../skills/gitcode-pr-review/scripts/fetch-pr-diff.mjs', import.meta.url)), 'utf8');

describe('GitCode PR diff', () => {
  test('请求 /pulls/{number}/diff，不把 1581.diff 拼进 API 路径', () => {
    expect(pullDiffApiPath('CPF-Flutter', 'flutter_engine', '1581'))
      .toBe('/repos/CPF-Flutter/flutter_engine/pulls/1581/diff');
    expect(source).not.toContain('/pulls/${encodeURIComponent(number)}.diff');
  });

  test('files 接口里的 hunk 补成 review.diff', () => {
    const diff = unifiedDiffFromPullFiles([
      { filename: 'shell/PlatformChannel.ets', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+window.Orientation' },
    ]);
    expect(looksLikeDiff(diff)).toBe(true);
    expect(diff).toContain('diff --git a/shell/PlatformChannel.ets b/shell/PlatformChannel.ets');
    expect(diff).toContain('+window.Orientation');
  });

  test('GitCode files.json 的逐行内容也能合成 diff', () => {
    const diff = unifiedDiffFromPullFiles({
      diffs: [{
        statistic: { path: 'Plugin.ets', old_path: 'Plugin.ets', new_path: 'Plugin.ets' },
        content: { text: [
          { line_content: 'old', type: 'old', old_line: { line_num: '4' } },
          { line_content: 'new', type: 'new', new_line: { line_num: '4' } },
        ] },
      }],
    });
    expect(diff).toContain('diff --git a/Plugin.ets b/Plugin.ets');
    expect(diff).toContain('@@ -4,1 +4,1 @@');
    expect(diff).toContain('-old');
    expect(diff).toContain('+new');
  });
});
