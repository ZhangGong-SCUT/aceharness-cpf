import { describe, expect, test } from 'vitest';
import {
  compactStepConclusion,
  extractLastWorkflowVerdictJson,
  parseVerdictFromConclusion,
  parseWorkflowVerdict,
  pickCircuitBreakerEscape,
  applySupervisorTransitionVeto,
  modelHasNativeVision,
  buildVisionCapabilityPrompt,
  extractLastNextState,
  extractLastIssuesArray,
  enforceFixVerificationGoldenFlag,
  resolveOutputField,
  matchTransitionFieldConditions,
  hasTransitionFieldCondition,
  describeTransitionFieldCondition,
  shouldFinalizeDiagnosisAsCompleted,
} from '@/lib/state-machine/utils';

describe('parseWorkflowVerdict', () => {
  test('empty output is fail', () => {
    expect(parseWorkflowVerdict('')).toBe('fail');
    expect(parseWorkflowVerdict('   ')).toBe('fail');
  });

  test('reads fenced JSON verdict', () => {
    expect(parseWorkflowVerdict('```json\n{"verdict": "pass"}\n```')).toBe('pass');
    expect(parseWorkflowVerdict('```json\n{"verdict": "fail"}\n```')).toBe('fail');
    expect(parseWorkflowVerdict('```json\n{"verdict": "conditional_pass"}\n```')).toBe('conditional_pass');
  });

  test('ignores leading tool-call JSON and uses the later verdict', () => {
    const output = [
      '<ace-process>{"toolName":"read file","title":"read file","input":{},"kind":"tool-call","body":""}</ace-process>',
      '<ace-process>{"toolName":"read file","kind":"tool-result","output":"skill template clone_result success|skipped|failed"}</ace-process>',
      '##裁决结论 verdict: **conditional_pass** 故不 fail。',
      '```json',
      '{ "verdict": "conditional_pass", "remaining_issues": 4, "summary": "回退 defender" }',
      '```',
      '<step-conclusion>',
      '{"verdict":"conditional_pass","summary":"方向正确但证据不足，回退根因分析"}',
      '</step-conclusion>',
    ].join('\n');

    expect(parseWorkflowVerdict(output)).toBe('conditional_pass');
    expect(extractLastWorkflowVerdictJson(output)?.verdict).toBe('conditional_pass');
  });

  test('last structured verdict wins over an earlier pass', () => {
    const output = [
      '{"verdict":"pass","summary":"defender 过关"}',
      '<step-conclusion>{"verdict":"conditional_pass","summary":"judge 要求回退"}</step-conclusion>',
    ].join('\n');
    expect(parseWorkflowVerdict(output)).toBe('conditional_pass');
  });

  test('quoted JSON in step-conclusion is recognized', () => {
    expect(parseVerdictFromConclusion('{"verdict":"conditional_pass","summary":"回退"}')).toBe('conditional_pass');
    expect(parseWorkflowVerdict('<step-conclusion>{"verdict":"fail","summary":"钉死不了"}</step-conclusion>')).toBe('fail');
  });

  test('markdown bold verdict in step-conclusion is recognized', () => {
    const conclusion = '##结果 /裁决- verdict: **conditional_pass**（回退「根因分析」）。未达 fail。';
    expect(parseVerdictFromConclusion(conclusion)).toBe('conditional_pass');
    expect(parseWorkflowVerdict(`<step-conclusion>\n${conclusion}\n</step-conclusion>`)).toBe('conditional_pass');
  });

  test('negated fail phrases do not force fail when no structured verdict exists', () => {
    expect(parseWorkflowVerdict('ruling_reason：方向正确，故不 fail。')).toBe('conditional_pass');
    expect(parseWorkflowVerdict('非3轮且置信度远高于0.3，故不 fail。')).toBe('conditional_pass');
  });

  test('plain fail keyword still works as fallback', () => {
    expect(parseWorkflowVerdict('This is a fail result')).toBe('fail');
  });

  test('plain pass keyword still works as fallback', () => {
    expect(parseWorkflowVerdict('All checks pass')).toBe('pass');
  });

  test('step-conclusion markdown fail still parses', () => {
    expect(parseWorkflowVerdict('<step-conclusion>\n## 结果 / 裁决\n- 当前状态最终裁定为 fail。\n</step-conclusion>')).toBe('fail');
  });
});

describe('enforceFixVerificationGoldenFlag', () => {
  const verifyCtx = { stateName: '修复验证', stepId: 'verify-fix', stepName: '修复方案对抗验证' };

  test('does not touch fail or non-verify steps', () => {
    expect(enforceFixVerificationGoldenFlag('{"verdict":"fail"}', 'fail', verifyCtx)).toBe('fail');
    expect(enforceFixVerificationGoldenFlag('{"verdict":"pass"}', 'pass', { stateName: '根因分析' })).toBe('pass');
  });

  test('keeps pass only when issue_golden_flag_met and engine_aligned are true', () => {
    const output = '{"verdict":"pass","run_verification":{"issue_golden_flag_met":true,"engine_aligned":true,"bug_fixed":true}}';
    expect(enforceFixVerificationGoldenFlag(output, 'pass', verifyCtx)).toBe('pass');
  });

  test('downgrades pass when engine is not aligned', () => {
    const output = '{"verdict":"pass","run_verification":{"issue_golden_flag_met":true,"engine_aligned":false}}';
    expect(enforceFixVerificationGoldenFlag(output, 'pass', verifyCtx)).toBe('conditional_pass');
  });

  test('downgrades pass when inventory did not match the repo branch', () => {
    const output = '{"verdict":"pass","run_verification":{"issue_golden_flag_met":true,"engine_aligned":true}}';
    expect(enforceFixVerificationGoldenFlag(output, 'pass', { ...verifyCtx, sdkMatched: false })).toBe('conditional_pass');
  });

  test('downgrades pass when golden flag field is missing or false', () => {
    expect(enforceFixVerificationGoldenFlag('{"verdict":"pass","bug_fixed":true}', 'pass', verifyCtx)).toBe('conditional_pass');
    expect(enforceFixVerificationGoldenFlag(
      '{"verdict":"pass","run_verification":{"issue_golden_flag_met":false}}',
      'pass',
      verifyCtx,
    )).toBe('conditional_pass');
  });

  test('downgrades pass that rewrites the Issue golden flag', () => {
    const output = [
      '**verdict: pass**（按修订后黄金标志）',
      '{"verdict":"pass","issue_golden_flag_met":true,"bug_fixed":true}',
    ].join('\n');
    expect(enforceFixVerificationGoldenFlag(output, 'pass', verifyCtx)).toBe('conditional_pass');
  });
});

describe('resolveOutputField', () => {
  test('resolves top-level field from the last non-tool JSON', () => {
    const outputs = [
      '<ace-process>{"toolName":"read","kind":"tool-call","input":{}}</ace-process>',
      '{"verdict":"fail","feedback_to_target":"方案设计","summary":"分支 B，需回退方案设计"}',
    ];
    expect(resolveOutputField(outputs, 'feedback_to_target')).toEqual({ found: true, value: '方案设计' });
  });

  test('resolves dot path into nested objects', () => {
    const outputs = ['{"run_verification":{"engine_aligned":false}}'];
    expect(resolveOutputField(outputs, 'run_verification.engine_aligned')).toEqual({ found: true, value: false });
  });

  test('pipe candidates resolve the first existing path', () => {
    const outputs = ['{"run_verification":{"engine_aligned":true}}'];
    expect(resolveOutputField(outputs, 'engine_aligned|run_verification.engine_aligned'))
      .toEqual({ found: true, value: true });
    const outputs2 = ['{"engine_aligned":"true"}'];
    expect(resolveOutputField(outputs2, 'engine_aligned|run_verification.engine_aligned'))
      .toEqual({ found: true, value: 'true' });
  });

  test('missing field returns found=false', () => {
    expect(resolveOutputField(['{"verdict":"pass"}'], 'feedback_to_target')).toEqual({ found: false, value: undefined });
    expect(resolveOutputField([], 'feedback_to_target').found).toBe(false);
  });

  test('later JSON wins over earlier one', () => {
    const outputs = [
      '{"feedback_to_target":"代码修复"}',
      '{"feedback_to_target":"根因分析"}',
    ];
    expect(resolveOutputField(outputs, 'feedback_to_target').value).toBe('根因分析');
  });
});

describe('matchTransitionFieldConditions', () => {
  test('fieldEquals requires exact stringified equality', () => {
    const outputs = ['{"feedback_to_target":"方案设计"}'];
    expect(matchTransitionFieldConditions(outputs, { fieldEquals: { feedback_to_target: '方案设计' } })).toBe(true);
    expect(matchTransitionFieldConditions(outputs, { fieldEquals: { feedback_to_target: '代码修复' } })).toBe(false);
    expect(matchTransitionFieldConditions(outputs, { fieldEquals: { missing_field: 'x' } })).toBe(false);
  });

  test('fieldEquals compares booleans via string coercion', () => {
    const outputs = ['{"engine_aligned":true}'];
    expect(matchTransitionFieldConditions(outputs, { fieldEquals: { engine_aligned: 'true' } })).toBe(true);
    expect(matchTransitionFieldConditions(outputs, { fieldEquals: { engine_aligned: true } })).toBe(true);
    expect(matchTransitionFieldConditions(outputs, { fieldEquals: { engine_aligned: 'false' } })).toBe(false);
  });

  test('fieldNotEquals passes when field is missing or different', () => {
    expect(matchTransitionFieldConditions(['{"verdict":"fail"}'], {
      fieldNotEquals: { 'run_verification.engine_aligned|engine_aligned': 'true' },
    })).toBe(true);
    expect(matchTransitionFieldConditions(['{"run_verification":{"engine_aligned":false}}'], {
      fieldNotEquals: { 'run_verification.engine_aligned|engine_aligned': 'true' },
    })).toBe(true);
    expect(matchTransitionFieldConditions(['{"engine_aligned":true}'], {
      fieldNotEquals: { 'run_verification.engine_aligned|engine_aligned': 'true' },
    })).toBe(false);
  });

  test('fieldMatch requires field presence and regex match (no full-text fallback)', () => {
    const outputs = ['结论：需回退到方案设计重新设计（无 JSON 字段）'];
    expect(matchTransitionFieldConditions(outputs, { fieldMatch: { feedback_to_target: '方案' } })).toBe(false);
    expect(matchTransitionFieldConditions(['{"feedback_to_target":"回方案设计"}'], {
      fieldMatch: { feedback_to_target: '方案' },
    })).toBe(true);
  });

  test('fieldAbsent blocks when structured field exists', () => {
    const withField = ['{"feedback_to_target":"代码修复"}'];
    const proseOnly = ['结论：Demo 本身构造有误，需回到问题复现重新构造'];
    expect(matchTransitionFieldConditions(withField, {
      fieldAbsent: ['feedback_to_target|next_state'],
      outputMatch: '回到问题复现',
    })).toBe(false);
    expect(matchTransitionFieldConditions(proseOnly, {
      fieldAbsent: ['feedback_to_target|next_state'],
      outputMatch: '回到问题复现',
    })).toBe(true);
  });

  test('outputMatch tests the joined raw output', () => {
    expect(matchTransitionFieldConditions(['abc', 'def'], { outputMatch: 'bcd' })).toBe(false);
    expect(matchTransitionFieldConditions(['abc', 'def'], { outputMatch: 'abc\\ndef' })).toBe(true);
  });

  test('invalid regex fails the condition instead of crashing', () => {
    expect(matchTransitionFieldConditions(['{"feedback_to_target":"x"}'], {
      fieldMatch: { feedback_to_target: '([unclosed' },
    })).toBe(false);
    expect(matchTransitionFieldConditions(['text'], { outputMatch: '([unclosed' })).toBe(false);
  });

  test('hasTransitionFieldCondition and describe helper', () => {
    expect(hasTransitionFieldCondition(null)).toBe(false);
    expect(hasTransitionFieldCondition({})).toBe(false);
    expect(hasTransitionFieldCondition({ fieldAbsent: ['a'] })).toBe(true);
    expect(describeTransitionFieldCondition({
      fieldEquals: { stage: 'complete' },
      fieldMatch: { feedback_to_target: '方案' },
      fieldAbsent: ['next_state'],
      outputMatch: '回到根因分析',
    })).toBe('stage=complete, feedback_to_target~/方案/, !next_state, output~/回到根因分析/');
  });
});

describe('shouldFinalizeDiagnosisAsCompleted', () => {
  test('keeps completed when golden flag and engine alignment passed', () => {
    expect(shouldFinalizeDiagnosisAsCompleted({
      hasFixVerificationState: true,
      lastFixVerificationVerdict: 'pass',
      finalStateName: '完成',
    })).toEqual({ complete: true, reason: '' });
  });

  test('refuses completed when engine is not aligned', () => {
    const gate = shouldFinalizeDiagnosisAsCompleted({
      hasFixVerificationState: true,
      lastFixVerificationVerdict: 'conditional_pass',
      finalStateName: '完成',
    });
    expect(gate.complete).toBe(false);
    expect(gate.reason).toMatch(/conditional_pass/);
  });

  test('refuses completed when verification never ran but workflow reached 完成', () => {
    const gate = shouldFinalizeDiagnosisAsCompleted({
      hasFixVerificationState: true,
      lastFixVerificationVerdict: null,
      finalStateName: '完成',
    });
    expect(gate.complete).toBe(false);
    expect(gate.reason).toMatch(/未完成修复验证/);
  });

  test('completes designed fallback exits that never entered 修复验证', () => {
    const gate = shouldFinalizeDiagnosisAsCompleted({
      hasFixVerificationState: true,
      lastFixVerificationVerdict: null,
      finalStateName: '完成',
      fixVerificationReached: false,
    });
    expect(gate.complete).toBe(true);
    expect(gate.reason).toMatch(/兜底|建议出口/);
  });

  test('does not change 终止 or non-diagnosis workflows', () => {
    expect(shouldFinalizeDiagnosisAsCompleted({
      hasFixVerificationState: true,
      lastFixVerificationVerdict: null,
      finalStateName: '终止',
    }).complete).toBe(true);
    expect(shouldFinalizeDiagnosisAsCompleted({
      hasFixVerificationState: false,
      lastFixVerificationVerdict: null,
      finalStateName: '完成',
    }).complete).toBe(true);
  });
});

describe('compactStepConclusion', () => {
  test('uses the last step-conclusion when several exist', () => {
    const raw = [
      '<step-conclusion>{"verdict":"pass"}</step-conclusion>',
      '<step-conclusion>{"verdict":"conditional_pass","summary":"最终裁决"}</step-conclusion>',
    ].join('\n');
    expect(compactStepConclusion(raw)).toContain('conditional_pass');
  });

  test('unclosed skill tag in tool output does not swallow the later real conclusion', () => {
    const raw = [
      '<ace-process>{"kind":"tool-result","toolName":"read","output":"在 <step-conclusion> 标签内输出 JSON pigeon flutter_packages Number.isInteger"}</ace-process>',
      '## 汇总',
      '<step-conclusion>',
      '## 结果 / 裁决',
      '- Issue #2376 采集完成，clone flutter_flutter',
      '</step-conclusion>',
    ].join('\n');
    const got = compactStepConclusion(raw);
    expect(got).toContain('Issue #2376');
    expect(got).toContain('flutter_flutter');
    expect(got).not.toContain('pigeon');
    expect(got).not.toContain('flutter_packages');
    expect(got).not.toContain('Number.isInteger');
  });

  test('unclosed skill tag outside ace-process still prefers the last real pair', () => {
    const raw = [
      '请在 <step-conclusion> 标签内输出模板 {"repo_url":"CPF-Flutter/flutter_packages"}',
      '<step-conclusion>',
      'Issue #2376 underline',
      '</step-conclusion>',
    ].join('\n');
    const got = compactStepConclusion(raw);
    expect(got).toContain('Issue #2376 underline');
    expect(got).not.toContain('flutter_packages');
  });
});

describe('pickCircuitBreakerEscape', () => {
  const rootCauseTransitions = [
    { condition: { verdict: 'pass' }, to: '方案设计' },
    { condition: { verdict: 'conditional_pass' }, to: '根因分析' },
    { condition: { verdict: 'fail' }, to: '报告沉淀' },
  ];

  test('escapes a conditional_pass self-loop to fail, not the first pass edge', () => {
    expect(pickCircuitBreakerEscape(rootCauseTransitions, '根因分析', 'conditional_pass')?.to).toBe('报告沉淀');
  });

  test('self-loop exhaustion escapes via fail even when a cpass reroute edge exists', () => {
    const transitions = [
      ...rootCauseTransitions,
      { condition: { verdict: 'conditional_pass' }, to: '问题复现' },
    ];
    expect(pickCircuitBreakerEscape(transitions, '根因分析', 'conditional_pass')?.to).toBe('报告沉淀');
  });

  test('still prefers a matching non-self exit when fail is absent', () => {
    const transitions = [
      { condition: { verdict: 'pass' }, to: '实施' },
      { condition: { verdict: 'conditional_pass' }, to: '复核' },
    ];
    expect(pickCircuitBreakerEscape(transitions, '设计', 'conditional_pass')?.to).toBe('复核');
  });

  test('unmatched conditional_pass does not bounce backward via fail', () => {
    const transitions = [
      { condition: { verdict: 'pass' }, to: '完成' },
      { condition: { verdict: 'fail' }, to: '设计' },
    ];
    expect(pickCircuitBreakerEscape(transitions, '实施', 'conditional_pass')?.to).toBe('完成');
  });
});

describe('applySupervisorTransitionVeto', () => {
  const rootCauseTransitions = [
    { condition: { verdict: 'pass' }, to: '方案设计' },
    { condition: { verdict: 'conditional_pass' }, to: '根因分析' },
    { condition: { verdict: 'fail' }, to: '报告沉淀' },
  ];

  test('does not let supervisor turn conditional_pass into the fail sink', () => {
    expect(applySupervisorTransitionVeto({
      engineVerdict: 'conditional_pass',
      proposedNextState: '根因分析',
      currentState: '根因分析',
      supervisorNextState: '报告沉淀',
      supervisorVerdict: 'fail',
      transitions: rootCauseTransitions,
    })).toBe('根因分析');
  });

  test('lets supervisor keep iterating when engine fail was a misread of conditional_pass', () => {
    expect(applySupervisorTransitionVeto({
      engineVerdict: 'fail',
      proposedNextState: '报告沉淀',
      currentState: '根因分析',
      supervisorNextState: '根因分析',
      supervisorVerdict: 'conditional_pass',
      transitions: rootCauseTransitions,
    })).toBe('根因分析');
  });
});

describe('modelHasNativeVision', () => {
  test('treats grok / gpt-4o as native vision', () => {
    expect(modelHasNativeVision('grok-4.6[effort=medium,fast=true]')).toBe(true);
    expect(modelHasNativeVision('gpt-4o')).toBe(true);
    expect(buildVisionCapabilityPrompt('grok-4.6')).toContain('可以直接看图');
    expect(buildVisionCapabilityPrompt('grok-4.6')).toContain('不要一上来就调 Qwen');
  });

  test('treats glm-5.2 as no native vision', () => {
    expect(modelHasNativeVision('glm-5.2')).toBe(false);
    expect(buildVisionCapabilityPrompt('glm-5.2')).toContain('必须调用 look_at_image');
  });

  test('treats volcano glm-5.3 as no native vision', () => {
    expect(modelHasNativeVision('火山AI网关/glm-5.3')).toBe(false);
    expect(buildVisionCapabilityPrompt('火山AI网关/glm-5.3')).toContain('必须调用 look_at_image');
  });
});

describe('extractLastNextState / extractLastIssuesArray', () => {
  const sample = [
    '{"toolName":"read file","kind":"tool-call","input":{}}',
    '{"issues":[{"description":"旧问题","severity":"minor"}]}',
    '{"verdict":"conditional_pass","next_state":"根因分析","issues":[{"description":"证据不足","severity":"major"}]}',
  ].join('\n');

  test('skips tool envelopes and uses the last next_state', () => {
    expect(extractLastNextState(sample, ['根因分析', '报告沉淀'])).toBe('根因分析');
  });

  test('uses the last issues array, not the first JSON', () => {
    expect(extractLastIssuesArray(sample).map((item) => item.description)).toEqual(['证据不足']);
  });
});
