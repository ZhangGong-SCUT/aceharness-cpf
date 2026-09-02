import { describe, expect, test } from 'vitest';
import {
  DEFAULT_FLUTTER_OHOS_REPO,
  classifyDiagnosisInput,
  formatDiagnosisInputPrompt,
} from '@/lib/workflow/diagnosis-input';

describe('classifyDiagnosisInput', () => {
  test('treats GitCode issue URL as issue mode', () => {
    const input = classifyDiagnosisInput(
      '请诊断 https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2349 小艺输入法',
    );
    expect(input.mode).toBe('issue');
    expect(input.issueNumber).toBe('2349');
    expect(input.issueUrl).toContain('/issues/2349');
  });

  test('treats title-only 问题 #1 without URL as freeform', () => {
    const input = classifyDiagnosisInput('问题 #1 —— forward delete + delta 模型方向错误\nP1');
    expect(input.mode).toBe('freeform');
    expect(input.issueUrl).toBeNull();
  });

  test('does not treat pull URL as issue', () => {
    const input = classifyDiagnosisInput(
      '对照 https://gitcode.com/CPF-Flutter/flutter_flutter/pull/1732 和一段文字描述',
    );
    expect(input.mode).toBe('freeform');
  });

  test('empty text is empty mode', () => {
    expect(classifyDiagnosisInput('   ').mode).toBe('empty');
  });
});

describe('formatDiagnosisInputPrompt', () => {
  test('freeform forbids issue API and leftover issues', () => {
    const prompt = formatDiagnosisInputPrompt('forward delete + delta，ListenableEditingState.ets');
    expect(prompt).toContain('mode=freeform');
    expect(prompt).toContain('禁止 curl Issue/comments API');
    expect(prompt).toContain('skipped_no_issue_date');
    expect(prompt).toContain(DEFAULT_FLUTTER_OHOS_REPO);
    expect(prompt).toContain('#2490');
  });

  test('issue mode keeps the URL', () => {
    const prompt = formatDiagnosisInputPrompt(
      'https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2116',
    );
    expect(prompt).toContain('mode=issue');
    expect(prompt).toContain('/issues/2116');
    expect(prompt).not.toContain('freeform_text');
  });
});
