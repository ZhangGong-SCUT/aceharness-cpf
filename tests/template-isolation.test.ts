import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertReviewOutputDir } from '../skills/gitcode-pr-review/scripts/fetch-ai-review.mjs';
import { reviewArtifactMatchesPr } from '../aiweb/Server/prReview/review-match.js';
import { isSharedWorkflowTemplate, shouldCopyWorkflowTemplateEntry } from '@/lib/workflow/template-isolation';

describe('template isolation', () => {
  it('不把模板 outputs 拷进新 run', () => {
    const root = mkdtempSync(join(tmpdir(), 'ace-template-'));
    mkdirSync(join(root, 'outputs'), { recursive: true });
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'outputs', 'ai-review-comments.json'), '{"number":2279}');
    writeFileSync(join(root, 'skills', 'SKILL.md'), '# skill');
    expect(shouldCopyWorkflowTemplateEntry(root, join(root, 'outputs'))).toBe(false);
    expect(shouldCopyWorkflowTemplateEntry(root, join(root, 'outputs', 'ai-review-comments.json'))).toBe(false);
    expect(shouldCopyWorkflowTemplateEntry(root, join(root, 'skills', 'SKILL.md'))).toBe(true);
    expect(isSharedWorkflowTemplate('/home/flutter/.aceharness/_template')).toBe(true);
    expect(isSharedWorkflowTemplate(join(root, 'run-2109'))).toBe(false);
  });

  it('检视脚本拒绝把产物写进 _template', () => {
    expect(() => assertReviewOutputDir('/home/flutter/.aceharness/_template/outputs')).toThrow(/_template/);
    expect(() => assertReviewOutputDir('/tmp/run-2109/outputs')).not.toThrow();
  });

  it('面板丢弃编号不属于当前 PR 的检视意见', () => {
    const leaked = { owner: 'CPF-Flutter', repo: 'flutter_flutter', number: 2279, comments: [{ body: 'old' }] };
    expect(reviewArtifactMatchesPr(leaked, { owner: 'CPF-Flutter', repo: 'flutter_flutter', number: '2109' })).toBe(false);
    expect(reviewArtifactMatchesPr(leaked, { owner: 'CPF-Flutter', repo: 'flutter_flutter', number: '2279' })).toBe(true);
  });
});
