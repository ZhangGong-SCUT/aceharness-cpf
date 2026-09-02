import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { compactRuntimeOutputPreview } from '@/lib/run/output-compaction';
import { stateMachineWorkflowSchema } from '@/lib/core/schemas';
import {
  applySupervisorTransitionVeto,
  buildVisionCapabilityPrompt,
  parseWorkflowVerdict,
  pickCircuitBreakerEscape,
} from '@/lib/state-machine/utils';

const repoRoot = resolve(__dirname, '..');

function loadYaml(relativePath: string): any {
  return parse(readFileSync(resolve(repoRoot, relativePath), 'utf-8'));
}

describe('cpf-ohos-diagnosis.yaml', () => {
  const config = loadYaml('configs/cpf-ohos-diagnosis.yaml');
  const parsed = stateMachineWorkflowSchema.safeParse(config);

  test('schema accepts the diagnosis workflow', () => {
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
  });

  test('supervisor reviews before transition and root-cause cpass stays in-stage', () => {
    expect(config.workflow.supervisor.stageReviewAsync).toBe(false);
    const rootCause = config.workflow.states.find((state: any) => state.name === '根因分析');
    expect(rootCause.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: '方案设计', condition: { verdict: 'pass' } }),
      expect.objectContaining({ to: '根因分析', condition: { verdict: 'conditional_pass' } }),
      expect.objectContaining({ to: '报告沉淀', condition: { verdict: 'fail' } }),
    ]));
  });

  test('tasks do not force Qwen when the main model can see images', () => {
    const tasks = config.workflow.states.flatMap((state: any) => state.steps || []).map((step: any) => String(step.task || ''));
    expect(tasks.some((task: string) => /主模型不能看图/.test(task))).toBe(false);
    expect(tasks.some((task: string) => /必须按[\s\S]*look_at_image（Qwen/.test(task))).toBe(false);
    expect(tasks.some((task: string) => /能看图就/.test(task) && /Read/.test(task))).toBe(true);
  });

  test('circuit breaker on exhausted cpass goes to 报告沉淀, not 方案设计', () => {
    const rootCause = config.workflow.states.find((state: any) => state.name === '根因分析');
    expect(pickCircuitBreakerEscape(rootCause.transitions, '根因分析', 'conditional_pass')?.to).toBe('报告沉淀');
  });

  test('verify-fix can roll back to 方案设计, not only 代码修复', () => {
    const verify = config.workflow.states.find((state: any) => state.name === '修复验证');
    const targets = (verify?.transitions || []).map((item: any) => item.to);
    expect(targets).toEqual(expect.arrayContaining(['报告沉淀', '代码修复', '方案设计', '根因分析']));
  });

  test('collect and fix steps forbid official PR leak and git apply of official commits', () => {
    const collect = config.workflow.states
      .find((state: any) => state.name === '信息采集')
      ?.steps?.find((step: any) => step.id === 'collect-issue-info');
    const modify = config.workflow.states
      .find((state: any) => state.name === '代码修复')
      ?.steps?.find((step: any) => step.id === 'modify-code');
    expect(String(collect?.task || '')).toMatch(/禁止写出 PR 号/);
    expect(String(collect?.task || '')).toMatch(/对照该 PR/);
    expect(String(modify?.task || '')).toMatch(/git apply/);
    expect(String(modify?.task || '')).toMatch(/cherry-pick/);

    const flutter = loadYaml('configs/flutter-ohos-diagnosis.yaml');
    const flutterCollect = flutter.workflow.states
      .find((state: any) => state.name === '信息采集')
      ?.steps?.find((step: any) => step.id === 'collect-issue-info');
    const flutterModify = flutter.workflow.states
      .find((state: any) => state.name === '代码修复')
      ?.steps?.find((step: any) => step.id === 'modify-code');
    expect(String(flutterCollect?.task || '')).toMatch(/禁止写出 PR 号/);
    expect(String(flutterModify?.task || '')).toMatch(/git apply/);
  });

  test('verify-fix forbids rewriting the Issue golden flag', () => {
    const verify = config.workflow.states
      .find((state: any) => state.name === '修复验证')
      ?.steps?.find((step: any) => step.id === 'verify-fix');
    expect(String(verify?.task || '')).toMatch(/禁止修订/);
    expect(String(verify?.task || '')).toMatch(/issue_golden_flag_met/);
  });

  test('workflow default uses OpenCode volcano glm-5.3 without native vision', () => {
    expect(config.context.executionPolicy.defaultEngine).toBe('opencode');
    expect(config.context.executionPolicy.defaultModel).toBe('火山AI网关/glm-5.3');
    expect(buildVisionCapabilityPrompt(config.context.executionPolicy.defaultModel)).toContain('必须调用 look_at_image');
  });
});

describe('#2376 engine regressions', () => {
  test('tool-call JSON plus 故不 fail does not become fail', () => {
    const output = [
      '<ace-process>{"toolName":"read file","title":"read file","input":{},"kind":"tool-call","body":""}</ace-process>',
      '##裁决结论 verdict: **conditional_pass** 故不 fail。',
      '<step-conclusion>{"verdict":"conditional_pass","summary":"回退 defender"}</step-conclusion>',
    ].join('\n');
    expect(parseWorkflowVerdict(output)).toBe('conditional_pass');
    const compacted = compactRuntimeOutputPreview(`${'noise '.repeat(2000)}${output}`, 200);
    expect(compacted.output).toContain('conditional_pass');
  });

  test('supervisor cannot send a real cpass to 报告沉淀', () => {
    expect(applySupervisorTransitionVeto({
      engineVerdict: 'conditional_pass',
      proposedNextState: '根因分析',
      currentState: '根因分析',
      supervisorNextState: '报告沉淀',
      supervisorVerdict: 'fail',
      transitions: [
        { condition: { verdict: 'pass' }, to: '方案设计' },
        { condition: { verdict: 'conditional_pass' }, to: '根因分析' },
        { condition: { verdict: 'fail' }, to: '报告沉淀' },
      ],
    })).toBe('根因分析');
  });
});

describe('diagnosis agent prompts', () => {
  const agentFiles = [
    'configs/agents/diagnosis-issue-collector.yaml',
    'configs/agents/diagnosis-reproducer.yaml',
    'configs/agents/diagnosis-reproduction-verifier.yaml',
    'configs/agents/diagnosis-root-cause-analyzer.yaml',
    'configs/agents/diagnosis-challenger.yaml',
    'configs/agents/diagnosis-judge.yaml',
    'configs/agents/diagnosis-fix-advisor.yaml',
    'configs/agents/diagnosis-fix-verifier-advisor.yaml',
    'configs/agents/diagnosis-fix-modifier.yaml',
  ];

  test('collector, reproducer and modifier forbid using official PRs as the answer', () => {
    const collector = readFileSync(resolve(repoRoot, 'configs/agents/diagnosis-issue-collector.yaml'), 'utf-8');
    const reproducer = readFileSync(resolve(repoRoot, 'configs/agents/diagnosis-reproducer.yaml'), 'utf-8');
    const modifier = readFileSync(resolve(repoRoot, 'configs/agents/diagnosis-fix-modifier.yaml'), 'utf-8');
    expect(collector).toMatch(/禁止在输出中写出 PR 号/);
    expect(reproducer).toMatch(/禁止对照官方修复 PR/);
    expect(modifier).toMatch(/禁止 git apply \/ cherry-pick 官方修复/);
  });

  test('no agent still says the main model cannot see images', () => {
    for (const file of agentFiles) {
      const text = readFileSync(resolve(repoRoot, file), 'utf-8');
      expect(text, file).not.toMatch(/主模型不能看图/);
    }
  });

  test('vision-capable agents keep vision-look only as fallback', () => {
    for (const file of [
      'configs/agents/diagnosis-root-cause-analyzer.yaml',
      'configs/agents/diagnosis-challenger.yaml',
      'configs/agents/diagnosis-judge.yaml',
      'configs/agents/diagnosis-fix-advisor.yaml',
    ]) {
      const agent = loadYaml(file);
      expect(agent.mcpServers, file).toContain('vision-look');
    }
  });
});
