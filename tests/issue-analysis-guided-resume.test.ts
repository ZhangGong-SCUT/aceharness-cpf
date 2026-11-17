import { beforeEach, expect, test, vi } from 'vitest';
import { MockEngine } from './helpers/mock-engine';
import { stringify } from 'yaml';

const persistence = vi.hoisted(() => ({
  state: null as any,
  saves: [] as any[],
  loadRunState: vi.fn(async () => persistence.state),  saveRunState: vi.fn(async (state: any) => { persistence.saves.push(state); }),
}));

vi.mock('@/lib/run/state-persistence', () => ({
  loadRunState: persistence.loadRunState,
  saveRunState: persistence.saveRunState,
  saveProcessOutput: vi.fn().mockResolvedValue(undefined),
  saveStreamContent: vi.fn().mockResolvedValue(undefined),
  appendStreamContent: vi.fn().mockResolvedValue(undefined),
  appendFeedbackToStream: vi.fn().mockResolvedValue(undefined),
  loadStepOutputs: vi.fn().mockResolvedValue({}),
  externalizeStepLogOutput: vi.fn(async (_runId: string, log: unknown) => log),
}));
vi.mock('@/lib/run/store', () => ({ createRun: vi.fn(), updateRun: vi.fn() }));
vi.mock('@/lib/workflow/diagnosis-script-step', () => ({ executeDiagnosisScript: vi.fn() }));
vi.mock('@/lib/workflow/pr-script-step', () => ({ executePrScript: vi.fn() }));
vi.mock('@/lib/workflow/registry', () => ({ workflowRegistry: {
  getManagerForRun: vi.fn(), getManagerByRunId: vi.fn(), getRunningManagers: vi.fn().mockReturnValue([]),
} }));
vi.mock('@/lib/core/process-manager', () => ({ processManager: {
  registerExternalProcess: vi.fn().mockReturnValue({ status: 'running', streamContent: '' }),
  getProcess: vi.fn().mockReturnValue(null), getProcessRaw: vi.fn().mockReturnValue(null),
  getAllProcesses: vi.fn().mockReturnValue([]), killProcess: vi.fn().mockReturnValue(false),
  setProcessOutput: vi.fn(), setProcessError: vi.fn(), appendStreamContent: vi.fn(),
  on: vi.fn(), off: vi.fn(), emit: vi.fn(),
} }));
vi.mock('@/lib/engines', () => ({
  createEngine: vi.fn(), getConfiguredEngine: vi.fn().mockResolvedValue('mock-engine'),
  getLogicalEngineId: vi.fn(() => 'mock-engine'), resolveRequestedEngineType: vi.fn(() => 'mock-engine'),
}));
vi.mock('@/lib/engines/engine-config', () => ({ getEngineSkillsSubdir: vi.fn().mockReturnValue('skills') }));
vi.mock('@/lib/workflow/manager', () => ({
  resolveAgentEngineSelection: vi.fn().mockReturnValue({ engine: 'mock-engine', model: 'test-model' }),
  resolveAgentModel: vi.fn().mockReturnValue('test-model'),
}));
vi.mock('@/lib/run/runtime-configs', () => ({
  getRuntimeAgentsDirPath: vi.fn().mockReturnValue('/tmp/agents'),
  getRuntimeWorkflowConfigPath: vi.fn().mockImplementation(async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'ace-guided-resume-'));
    const file = join(directory, 'config.yaml');
    await writeFile(file, stringify(config()));
    return file;
  }),
}));
vi.mock('@/lib/run/runtime-skills', () => ({ getRuntimeSkillsDirPath: vi.fn().mockResolvedValue('/tmp/skills') }));

function config() {
  return {
    workflow: { name: 'Recovery test', mode: 'state-machine', maxTransitions: 10,
      supervisor: { enabled: false },
      states: [{ name: '执行', isInitial: true, steps: [
        { id: 'first', name: '成功步骤', agent: 'developer', task: '已经成功，不应重跑', role: 'judge' },
        { id: 'second', name: '失败步骤', agent: 'developer', task: '补充缺失证据', role: 'judge' },
        { id: 'third', name: '后续步骤', agent: 'developer', task: '继续后续验证', role: 'judge' },
      ], transitions: [{ condition: { verdict: 'pass' }, to: '完成', priority: 1 }] },
      { name: '完成', isFinal: true, steps: [], transitions: [] }] },
    context: { engine: 'mock-engine', projectRoot: '/tmp/project', gitBaselineEnabled: false },
    roles: [{ name: 'developer', systemPrompt: '你是测试步骤执行器', engine: 'mock-engine', model: 'test-model' }],
  } as any;
}

function failedState() {
  return {
    runId: 'run-guided-resume', configFile: 'test-recovery.yaml', mode: 'state-machine', status: 'failed',
    statusReason: 'Android 对照实验未执行', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:01:00.000Z',
    currentPhase: '执行', currentState: '执行', currentStep: '执行-失败步骤', activeSteps: [],
    completedSteps: ['执行-成功步骤'], failedSteps: ['执行-失败步骤'],
    stepLogs: [
      { id: 'success', stepName: '执行-成功步骤', agent: 'developer', status: 'completed', output: '<result>{"verdict":"pass","summary":"已保存的成功结论"}</result>', error: '', timestamp: '2026-01-01T00:00:20.000Z' },
      { id: 'failure', stepName: '执行-失败步骤', agent: 'developer', status: 'failed', output: '', error: 'Android 对照实验未执行', timestamp: '2026-01-01T00:01:00.000Z' },
    ],
    agents: [], iterationStates: {}, processes: [], requirements: 'Issue 验证', globalContext: '',
    workingDirectory: '/tmp/project',
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  persistence.state = failedState();
  persistence.saves = [];
});

test('real manager resume skips successful step, injects guidance and executes remaining steps', async () => {
  const engine = new MockEngine();
  const calls: string[] = [];
  engine.executeImpl = async options => {
    calls.push(options.prompt);
    return { success: true, output: '<result>{"verdict":"pass","summary":"按真实证据完成"}</result>', session_id: 'session-resumed' };
  };
  const engines = await import('@/lib/engines');
  vi.mocked(engines.createEngine).mockResolvedValue(engine as any);
  const { StateMachineWorkflowManager } = await import('@/lib/state-machine/workflow-manager');
  const manager = new StateMachineWorkflowManager();
  manager.setIterationFeedback('# 失败恢复协调器\n只补做 Android 对照实验；不得伪造验证通过。');
  await manager.resume('run-guided-resume');

  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain('当前任务: 失败步骤');
  expect(calls[0]).not.toContain('当前任务: 成功步骤');
  expect(calls[1]).toContain('当前任务: 后续步骤');
  expect(calls[0]).toContain('补充缺失证据');
  expect(calls[0]).toContain('只补做 Android 对照实验');
  expect(calls[0]).toContain('已保存的成功结论');
  expect(calls[1]).toContain('继续后续验证');
  // WorkflowManager returns to idle after execution; persisted state carries the terminal verdict.
  expect(manager.getStatus().status).toBe('idle');
  expect(persistence.saves.at(-1).status).toBe('completed');
  const finalState = persistence.saves.at(-1);
  expect(finalState.stepLogs.filter((log: any) => log.status === 'completed')).toHaveLength(3);
  expect(finalState.stepLogs[0].id).toBe('success');
  expect(finalState.globalContext).toContain('不得伪造验证通过');
});

test('causal failed step survives propagation into report and completion gate errors', async () => {
  const engine = new MockEngine({ success: true, output: '<result>{"verdict":"pass","summary":"修复隔离后完成验证"}</result>' });
  const engines = await import('@/lib/engines');
  vi.mocked(engines.createEngine).mockResolvedValue(engine as any);
  const { StateMachineWorkflowManager } = await import('@/lib/state-machine/workflow-manager');
  const { diagnoseFailure } = await import('../aiweb/Server/issueAnalysis/failureTriage.js');
  const error = 'SDK 隔离失败，已阻止使用共享 SDK：SDK 隔离目录缺少有效清单';
  const run = {
    ...failedState(),
    stepLogs: [
      failedState().stepLogs[0],
      { ...failedState().stepLogs[1], error },
      { ...failedState().stepLogs[1], stepName: '执行-后续步骤', error },
      { ...failedState().stepLogs[1], stepName: '完成-诊断完成', error },
    ],
    currentState: '执行', currentPhase: '执行', currentStep: '执行-失败步骤',
  };
  expect(diagnoseFailure({ run }).failedStep.stepKey).toBe('执行-失败步骤');
  persistence.state = run;
  const manager = new StateMachineWorkflowManager();
  await manager.resume(run.runId);
  expect(engine.calls[0].options.prompt).toContain('当前任务: 失败步骤');
  expect(manager.getStatus().currentStep).not.toBe('完成-诊断完成');
});


test('Supervisor review is isolated from the failed run and uses its configured role', async () => {
  const engine = new MockEngine({ success: true, output: '{"summary":"需要补充运行时证据","guidance":"补做对照实验"}' });
  const engines = await import('@/lib/engines');
  vi.mocked(engines.createEngine).mockResolvedValue(engine as any);
  const { StateMachineWorkflowManager } = await import('@/lib/state-machine/workflow-manager');
  const manager = new StateMachineWorkflowManager();
  persistence.state = { ...failedState(), supervisorAgent: 'developer' };
  const result = await manager.reviewFailureForRun('run-guided-resume', '只读复核这个失败');
  expect(result).toContain('需要补充运行时证据');
  expect(engine.calls).toHaveLength(1);
  expect(engine.calls[0].options.prompt).toContain('只读复核这个失败');
  expect(persistence.state.status).toBe('failed');
  expect(persistence.saves).toHaveLength(0);
});
