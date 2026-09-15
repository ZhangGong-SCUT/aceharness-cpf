import { describe, expect, test, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { MockEngine } from './helpers/mock-engine';
import { stateMachineWorkflowSchema } from '@/lib/core/schemas';

const registryMocks = vi.hoisted(() => ({
  getManagerForRun: vi.fn(),
  getManagerByRunId: vi.fn(),
  getRunningManagers: vi.fn().mockReturnValue([]),
}));

// Mock all heavy external dependencies (same set as state-machine-workflow-manager.test.ts)
vi.mock('@/lib/run/store', () => ({
  createRun: vi.fn().mockResolvedValue(undefined),
  updateRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/run/state-persistence', () => ({
  saveRunState: vi.fn().mockResolvedValue(undefined),
  saveProcessOutput: vi.fn().mockResolvedValue(undefined),
  saveStreamContent: vi.fn().mockResolvedValue(undefined),
  appendStreamContent: vi.fn().mockResolvedValue(undefined),
  appendFeedbackToStream: vi.fn().mockResolvedValue(undefined),
  loadRunState: vi.fn().mockResolvedValue(null),
  loadStepOutputs: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/workflow/registry', () => ({
  workflowRegistry: {
    getManagerForRun: registryMocks.getManagerForRun,
    getManagerByRunId: registryMocks.getManagerByRunId,
    getRunningManagers: registryMocks.getRunningManagers,
  },
}));

vi.mock('@/lib/core/process-manager', () => ({
  processManager: {
    registerExternalProcess: vi.fn().mockReturnValue({
      status: 'running',
      sessionId: null,
      streamContent: '',
    }),
    getProcess: vi.fn().mockReturnValue(null),
    getProcessRaw: vi.fn().mockReturnValue(null),
    getAllProcesses: vi.fn().mockReturnValue([]),
    killProcess: vi.fn().mockReturnValue(false),
    setProcessOutput: vi.fn(),
    setProcessError: vi.fn(),
    appendStreamContent: vi.fn().mockReturnValue(''),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  },
}));

vi.mock('@/lib/workflow/workflow-experience-store', () => ({
  appendWorkflowExperience: vi.fn().mockResolvedValue(undefined),
  buildWorkflowExperiencePromptBlock: vi.fn().mockReturnValue(''),
  findRelevantWorkflowExperiences: vi.fn().mockResolvedValue([]),
  saveWorkflowFinalReview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/workflow/workflow-memory-store', () => ({
  appendMemoryEntries: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/agent/agent-relationship-store', () => ({
  upsertRelationshipSignal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/chat/chat-persistence', () => ({
  updateChatSessionCreationBinding: vi.fn(),
  updateChatSessionWorkflowBinding: vi.fn(),
}));

vi.mock('@/lib/core/default-supervisor', () => ({
  DEFAULT_SUPERVISOR_NAME: 'default-supervisor',
  ensureDefaultSupervisorConfig: vi.fn(),
  resolveWorkflowSupervisorAgent: vi.fn().mockReturnValue('default-supervisor'),
}));

vi.mock('@/lib/spec/coding-store', () => ({
  appendSpecCodingRevision: vi.fn(),
  appendSupervisorSpecCodingRevision: vi.fn(),
  cloneSpecCodingForRun: vi.fn(),
  loadCreationSession: vi.fn().mockResolvedValue(null),
  markSpecCodingStateStatus: vi.fn().mockImplementation((doc) => doc),
  normalizeSpecCodingDocument: vi.fn().mockImplementation((doc) => doc),
  updateSpecCodingTaskStatuses: vi.fn(),
}));

vi.mock('@/lib/spec/persistence', () => ({
  ensureSpecDirStructure: vi.fn().mockResolvedValue(undefined),
  getSpecRootDir: vi.fn().mockReturnValue('/tmp/spec'),
  writeDeltaSpec: vi.fn().mockResolvedValue(undefined),
  readDeltaSpec: vi.fn().mockResolvedValue(null),
  readChecklist: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/engines', () => ({
  createEngine: vi.fn(),
  getConfiguredEngine: vi.fn().mockResolvedValue('mock-engine'),
  getLogicalEngineId: vi.fn((engine) => engine === 'mock-engine' ? 'claude-code' : engine),
  resolveRequestedEngineType: vi.fn((engine) => engine || 'mock-engine'),
}));

vi.mock('@/lib/engines/engine-config', () => ({
  getEngineSkillsSubdir: vi.fn().mockReturnValue('skills'),
}));

vi.mock('@/lib/run/runtime-configs', () => ({
  getRuntimeAgentsDirPath: vi.fn().mockReturnValue('/tmp/agents'),
  getRuntimeWorkflowConfigPath: vi.fn().mockResolvedValue('/tmp/config.yaml'),
}));

vi.mock('@/lib/run/runtime-skills', () => ({
  getRuntimeSkillsDirPath: vi.fn().mockResolvedValue('/tmp/skills'),
}));

vi.mock('@/lib/core/app-paths', () => ({
  getInstallPath: vi.fn((...segments: string[]) => ['/tmp/install', ...segments].join('/')),
  getInstallConfigsDir: vi.fn().mockReturnValue('/tmp/install/configs'),
  getInstallConfigPath: vi.fn((...segments: string[]) => ['/tmp/install/configs', ...segments].join('/')),
  getRepoRoot: vi.fn().mockReturnValue('/tmp/install'),
  getWorkspaceCacheFile: vi.fn((...segments: string[]) => ['/tmp/workspace/cache', ...segments].join('/')),
  getWorkspaceConfigFile: vi.fn((...segments: string[]) => ['/tmp/workspace/config', ...segments].join('/')),
  getWorkspaceDataFile: vi.fn((...segments: string[]) => ['/tmp/workspace/data', ...segments].join('/')),
  getWorkspaceLogFile: vi.fn((...segments: string[]) => ['/tmp/workspace/logs', ...segments].join('/')),
  getWorkspaceSkillPath: vi.fn((...segments: string[]) => ['/tmp/workspace/skills', ...segments].join('/')),
  getWorkspaceSkillsDir: vi.fn().mockReturnValue('/tmp/workspace/skills'),
  getWorkspaceRoot: vi.fn().mockReturnValue('/tmp/workspace'),
  getWorkspaceRunsDir: vi.fn().mockReturnValue('/tmp/runs'),
}));

vi.mock('@/lib/workflow/manager', () => ({
  resolveAgentEngineSelection: vi.fn().mockReturnValue({ engine: 'mock-engine', model: 'test-model' }),
  resolveAgentModel: vi.fn().mockReturnValue('test-model'),
}));

vi.mock('@/lib/core/utils', () => ({
  formatTimestamp: vi.fn().mockReturnValue('2024-01-01-000000'),
}));

function loadDiagnosisConfig(file: string) {
  const content = readFileSync(join(process.cwd(), 'configs', file), 'utf-8');
  return parse(content);
}

async function createManagerForRouting() {
  const enginesModule = await import('@/lib/engines');
  const engine = new MockEngine();
  vi.mocked(enginesModule.createEngine).mockResolvedValue(engine as any);
  const { StateMachineWorkflowManager } = await import('@/lib/state-machine/workflow-manager');
  const manager = new StateMachineWorkflowManager();
  (manager as any).currentEngine = engine;
  (manager as any).engineType = 'mock-engine';
  (manager as any).status = 'running';
  (manager as any).currentRunId = 'test-run-001';
  (manager as any).currentConfigFile = 'cpf-ohos-diagnosis.yaml';
  (manager as any).currentRequirements = 'OHOS 诊断';
  (manager as any).workflowName = 'Test Workflow';
  (manager as any).runStartTime = new Date().toISOString();
  (manager as any).agents = [];
  (manager as any).agentConfigs = [];
  (manager as any).persistState = vi.fn().mockResolvedValue(undefined);
  (manager as any).collectSupervisorReview = vi.fn().mockResolvedValue(null);
  (manager as any).appendSupervisorChatEvent = vi.fn().mockResolvedValue(undefined);
  return manager;
}

function buildResult(stateName: string, verdict: 'pass' | 'conditional_pass' | 'fail', output: string) {
  return {
    stateName,
    verdict,
    issues: [],
    stepOutputs: [output],
    summary: '',
  };
}

async function routeNextState(config: any, stateName: string, verdict: any, output: string) {
  const manager = await createManagerForRouting();
  const state = config.workflow.states.find((s: any) => s.name === stateName);
  const evaluateTransitions = (manager as any).evaluateTransitions.bind(manager);
  return evaluateTransitions(state.transitions, buildResult(stateName, verdict, output), config);
}

const CONFIGS = ['cpf-ohos-diagnosis.yaml', 'flutter-ohos-diagnosis.yaml'];

describe.each(CONFIGS)('%s schema', (file) => {
  test('passes zod stateMachineWorkflowSchema validation with field conditions', () => {
    const config = loadDiagnosisConfig(file);
    const result = stateMachineWorkflowSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('passes engine assertRequiredVerdictTransitions (pass/cpass/fail coverage)', async () => {
    const config = loadDiagnosisConfig(file);
    const manager = await createManagerForRouting();
    const assertRequired = (manager as any).assertRequiredVerdictTransitions.bind(manager);
    expect(() => assertRequired(config)).not.toThrow();
  });
});

describe.each(CONFIGS)('%s 修复验证 field routing (replaces engine special-case)', (file) => {
  const config = loadDiagnosisConfig(file);

  test('pass routes to 报告沉淀', async () => {
    const next = await routeNextState(config, '修复验证', 'pass',
      '{"verdict":"pass","run_verification":{"issue_golden_flag_met":true,"engine_aligned":true}}');
    expect(next).toBe('报告沉淀');
  });

  test('fail with feedback_to_target=方案设计 routes to 方案设计 (not default 代码修复)', async () => {
    const next = await routeNextState(config, '修复验证', 'fail',
      '{"verdict":"fail","feedback_to_target":"方案设计","summary":"分支 B，需回退方案设计"}');
    expect(next).toBe('方案设计');
  });

  test('fail with feedback_to_target=问题复现 routes to 问题复现', async () => {
    const next = await routeNextState(config, '修复验证', 'fail',
      '{"verdict":"fail","feedback_to_target":"问题复现","feedback_reason":"Demo 未复现原始 Issue 场景"}');
    expect(next).toBe('问题复现');
  });

  test('conditional_pass with feedback_to_target=根因分析 routes to 根因分析', async () => {
    const next = await routeNextState(config, '修复验证', 'conditional_pass',
      '{"verdict":"conditional_pass","feedback_to_target":"根因分析"}');
    expect(next).toBe('根因分析');
  });

  test('conditional_pass with feedback_to_target=代码修复 routes to 代码修复', async () => {
    const next = await routeNextState(config, '修复验证', 'conditional_pass',
      '{"verdict":"conditional_pass","feedback_to_target":"代码修复","run_verification":{"engine_aligned":false}}');
    expect(next).toBe('代码修复');
  });

  test('fail with only next_state=根因分析 routes to 根因分析', async () => {
    const next = await routeNextState(config, '修复验证', 'fail',
      '{"verdict":"fail","next_state":"根因分析"}');
    expect(next).toBe('根因分析');
  });

  test('prose-only output with Demo defect routes to 问题复现', async () => {
    const next = await routeNextState(config, '修复验证', 'conditional_pass',
      '结论：Demo 本身构造有误，需回到问题复现重新构造');
    expect(next).toBe('问题复现');
  });

  test('prose-only output with revised golden flag routes to 方案设计', async () => {
    const next = await routeNextState(config, '修复验证', 'conditional_pass',
      '**verdict: pass**（按修订后黄金标志）\n{"verdict":"pass","issue_golden_flag_met":true}');
    expect(next).toBe('方案设计');
  });

  test('engine not aligned without feedback routes to 报告沉淀', async () => {
    const next = await routeNextState(config, '修复验证', 'conditional_pass',
      '{"verdict":"conditional_pass","run_verification":{"engine_aligned":false}}');
    expect(next).toBe('报告沉淀');
  });

  test('engine aligned without feedback routes to default 代码修复', async () => {
    const next = await routeNextState(config, '修复验证', 'conditional_pass',
      '{"verdict":"conditional_pass","run_verification":{"engine_aligned":true}}');
    expect(next).toBe('代码修复');
  });

  test('fail without any field routes to 报告沉淀 (engine_aligned missing)', async () => {
    const next = await routeNextState(config, '修复验证', 'fail',
      '{"verdict":"fail","summary":"bug 仍复现"}');
    expect(next).toBe('报告沉淀');
  });

  test('structured feedback wins over prose fallback', async () => {
    const next = await routeNextState(config, '修复验证', 'fail',
      '说明文字提到 Demo 有误，但结构化结论为准。\n{"verdict":"fail","feedback_to_target":"代码修复"}');
    expect(next).toBe('代码修复');
  });
});

describe.each(CONFIGS)('%s 方案设计 adversarial structure', (file) => {
  const config = loadDiagnosisConfig(file);

  test('has defender → attacker → judge steps', () => {
    const state = config.workflow.states.find((s: any) => s.name === '方案设计');
    const roles = state.steps.map((s: any) => `${s.id}:${s.role}:${s.agent}`);
    expect(roles).toEqual([
      'design-fix:defender:diagnosis-fix-advisor',
      'challenge-fix-design:attacker:diagnosis-fix-challenger',
      'judge-fix-design:judge:diagnosis-fix-judge',
    ]);
    expect(state.maxSelfTransitions).toBe(2);
  });

  test('judge pass routes to 代码修复', async () => {
    const next = await routeNextState(config, '方案设计', 'pass',
      '<step-conclusion>{"verdict":"pass","summary":"方案可接受"}</step-conclusion>');
    expect(next).toBe('代码修复');
  });

  test('judge conditional_pass routes back to 方案设计 (self iteration)', async () => {
    const next = await routeNextState(config, '方案设计', 'conditional_pass',
      '<step-conclusion>{"verdict":"conditional_pass","feedback_to_designer":"补充边界条件"}</step-conclusion>');
    expect(next).toBe('方案设计');
  });

  test('judge conditional_pass with next_state=根因分析 routes to 根因分析', async () => {
    const next = await routeNextState(config, '方案设计', 'conditional_pass',
      '<step-conclusion>{"verdict":"conditional_pass","next_state":"根因分析"}</step-conclusion>');
    expect(next).toBe('根因分析');
  });

  test('judge fail routes to 报告沉淀 (design rejected or business_code routing)', async () => {
    const next = await routeNextState(config, '方案设计', 'fail',
      '<step-conclusion>{"verdict":"fail","summary":"应用层问题，只出建议"}</step-conclusion>');
    expect(next).toBe('报告沉淀');
  });
});

describe.each(CONFIGS)('%s regression: other states still route by verdict', (file) => {
  const config = loadDiagnosisConfig(file);

  test('根因分析 cpass self-iterates, pass goes to 方案设计', async () => {
    expect(await routeNextState(config, '根因分析', 'pass', '{"verdict":"pass"}')).toBe('方案设计');
    expect(await routeNextState(config, '根因分析', 'conditional_pass', '{"verdict":"conditional_pass"}')).toBe('根因分析');
    expect(await routeNextState(config, '根因分析', 'fail', '{"verdict":"fail"}')).toBe('报告沉淀');
  });

  test('代码修复 cpass/fail go back to 方案设计, pass goes to 修复验证', async () => {
    expect(await routeNextState(config, '代码修复', 'pass', '{"verdict":"pass"}')).toBe('修复验证');
    expect(await routeNextState(config, '代码修复', 'conditional_pass', '{"verdict":"conditional_pass"}')).toBe('方案设计');
    expect(await routeNextState(config, '代码修复', 'fail', '{"verdict":"fail"}')).toBe('方案设计');
  });

  test('信息采集 fail terminates, pass goes to 问题复现', async () => {
    expect(await routeNextState(config, '信息采集', 'pass', '{"verdict":"pass"}')).toBe('问题复现');
    expect(await routeNextState(config, '信息采集', 'fail', '{"verdict":"fail"}')).toBe('终止');
  });
});
