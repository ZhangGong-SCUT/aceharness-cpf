import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseFailure, FAILURE_CATEGORIES, mergeSupervisorReview } from '../issueAnalysis/failureTriage.js';
import { createFailureRecoveryService } from '../issueAnalysis/failureRecoveryService.js';

const tempDirectories = [];
test.after(async () => {
  await Promise.all(tempDirectories.map(directory => rm(directory, { recursive: true, force: true })));
});
async function tempDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function storeFor(initial) {
  const tasks = new Map(Object.entries(initial));
  return {
    get: id => tasks.get(id),
    patch: (id, patch) => { tasks.set(id, { ...tasks.get(id), ...patch }); },
    dump: id => tasks.get(id),
  };
}
const failedTask = {
  taskId: 'task-1', analysisSessionId: 'run-1', stage: 'failed', error: 'step failed',
  metadata: { runId: 'run-1', configFile: 'cpf-ohos-diagnosis.yaml' },
};
const completedLog = { stepName: '信息采集-Issue信息采集', status: 'completed', output: '<result>{"verdict":"pass"}</result>' };
const failedLog = { stepName: '问题复现-跨平台问题复现', status: 'failed', error: 'Android 对照实验未执行' };

test('locates the exact failed step and produces bounded step guidance', () => {
  const result = diagnoseFailure({ task: failedTask, run: {
    runId: 'run-1', status: 'failed', currentState: '问题复现', currentStep: failedLog.stepName,
    stepLogs: [completedLog, failedLog], completedSteps: [completedLog.stepName],
  } });
  assert.equal(result.category, FAILURE_CATEGORIES.STEP_GUIDANCE);
  assert.equal(result.failedStep.stepName, '跨平台问题复现');
  assert.equal(result.preserved.completedStepCount, 1);
  assert.match(result.guidance.prompt, /Android 对照实验/);
  assert.equal(result.canResume, true);
});

test('never bypasses real fix failure, even if a supervisor tries to call it transient', () => {
  const result = diagnoseFailure({ task: failedTask, run: {
    runId: 'run-1', status: 'failed', stepLogs: [completedLog,
      { ...failedLog, stepName: '修复验证-验证修复', error: 'bug_fixed=false issue_golden_flag_met=false' }],
  } });
  assert.equal(result.category, FAILURE_CATEGORIES.ISSUE_UNRESOLVED);
  assert.equal(result.canResume, false);
  const merged = mergeSupervisorReview(result, { category: 'transient_env', transientEvidence: 'trust me' });
  assert.equal(merged.category, FAILURE_CATEGORIES.ISSUE_UNRESOLVED);
  assert.equal(merged.canResume, false);
});

test('recognizes the known screenshot platform signature, not a generic timeout as a defect', () => {
  const defect = diagnoseFailure({ task: failedTask, run: { runId: 'run-1', status: 'failed', stepLogs: [
    { ...failedLog, error: 'ohos: invalid snapshot path: snapshot_display must resolve under run directory (symlink escape)' },
  ] } });
  assert.equal(defect.category, FAILURE_CATEGORIES.PLATFORM_DEFECT);
  assert.equal(defect.platformDefect.code, 'snapshot_path_escape');
  const transient = diagnoseFailure({ task: failedTask, run: { runId: 'run-1', status: 'failed', stepLogs: [
    { ...failedLog, error: 'request ETIMEDOUT after 30000ms' },
  ] } });
  assert.equal(transient.category, FAILURE_CATEGORIES.TRANSIENT_ENV);
  assert.equal(transient.automaticRetry, true);
});

test('terminal gate errors resume the causal failed step instead of the final archive step', () => {
  const error = 'SDK 隔离失败，已阻止使用共享 SDK：SDK 隔离目录缺少有效清单，请创建新 run';
  const result = diagnoseFailure({ task: failedTask, run: { runId: 'run-1', status: 'failed', currentState: '完成', stepLogs: [
    completedLog,
    { ...failedLog, stepName: '修复验证-修复方案对抗验证', error },
    { ...failedLog, stepName: '报告沉淀-生成诊断报告', error },
    { ...failedLog, stepName: '完成-诊断完成', error },
  ] } });
  assert.equal(result.failedStep.stepKey, '修复验证-修复方案对抗验证');
  assert.equal(result.category, FAILURE_CATEGORIES.PLATFORM_DEFECT);
  assert.equal(result.platformDefect.code, 'sdk_isolation_invalid');
  assert.equal(result.requiresPlatformFix, true);
});

test('diagnostics distinguish the causal origin from the step selected for resume', () => {
  const error = 'SDK 隔离失败，已阻止使用共享 SDK：SDK 隔离目录缺少有效清单，请创建新 run';
  const result = diagnoseFailure({ task: failedTask, run: {
    runId: 'run-1', status: 'failed', currentState: '修复验证',
    stepLogs: [completedLog,
      { stepName: '问题复现-问题复现', status: 'failed', error: 'ENOSPC: no space left on device', timestamp: '2026-11-14T03:52:28.163Z' },
      { stepName: '方案设计-方案质疑', status: 'completed', output: '分支 B（ArkUI 覆盖）', timestamp: '2026-11-14T06:47:45.100Z' },
      { ...failedLog, stepName: '方案设计-方案裁决', error: 'SDK 隔离目录不兼容或不完整', timestamp: '2026-11-14T06:53:25.161Z' },
      { ...failedLog, stepName: '修复验证-修复方案对抗验证', error },
    ],
    diagnostics: [
      { timestamp: '2026-11-14T03:31:00.000Z', event: 'ohos.flutter.sdk', matched: true,
        branch: 'oh-3.41.9-dev', sdkId: '3.41.9-ohos', sdkRoot: '/opt/flutter' },
      { timestamp: '2026-11-14T06:47:45.000Z', event: 'step.prompt', state: '方案设计', step: '方案质疑' },
      { timestamp: '2026-11-14T06:47:45.100Z', event: 'ohos.flutter.sdk', matched: false,
        branch: 'B', reason: 'refresh pin from step result' },
    ],
  } });
  assert.equal(result.failedStep.stepKey, '修复验证-修复方案对抗验证');
  assert.equal(result.originFailedStep.stepKey, '方案设计-方案裁决');
  assert.equal(result.rootCause.stepKey, '方案设计-方案质疑');
  assert.equal(result.rootCause.code, 'sdk_branch_pin_corrupted');
  assert.equal(result.rootCause.expectedBranch, 'oh-3.41.9-dev');
  assert.equal(result.rootCause.actualBranch, 'B');
  assert.equal(result.platformDefect.rootCauseStepKey, '方案设计-方案质疑');
  assert.match(result.rootCause.summary, /次生后果/);
  // Recovery executes the causal failed state; it never re-runs the completed step that supplied evidence.
  assert.equal(result.canResume, true);
});

test('completed final report with explicit false verification flags remains a genuine unresolved issue', () => {
  const result = diagnoseFailure({ task: failedTask, run: { runId: 'run-1', status: 'failed', currentState: '完成', stepLogs: [
    { ...failedLog, status: 'completed', output: '<result>{"verdict":"pass","summary":"验证待运行"}</result>' },
    { stepName: '完成-诊断完成', status: 'completed', output: '{"verification_flags":{"issue_golden_flag_met":"false","bug_fixed":"unknown"}}' },
  ], completedSteps: ['完成-诊断完成'] } });
  assert.equal(result.category, FAILURE_CATEGORIES.ISSUE_UNRESOLVED);
  assert.equal(result.canResume, false);
  assert.equal(result.action, 'preserve_failure_and_review');
});


test('preserves final genuine verification failure after a recovered historical platform defect', () => {
  const result = diagnoseFailure({ task: failedTask, run: {
    runId: 'run-1', status: 'failed',
    statusReason: '原始 Issue 复现状态为 theoretical，替代版本或理论分析不能证明原始缺陷已修复；只能交付待运行验证报告',
    stepLogs: [completedLog,
      { stepName: '方案设计-方案质疑', status: 'completed', output: '分支 B（ArkUI 覆盖）' },
      { ...failedLog, stepName: '方案设计-方案裁决', error: 'SDK 隔离目录不兼容或不完整' },
      { ...failedLog, stepName: '修复验证-修复方案对抗验证', error: 'SDK 隔离目录缺少有效清单' },
      { stepName: '完成-诊断完成', status: 'completed', output: '{"verification_status":"needs_runtime_validation","verification_flags":{"bug_fixed":"false","issue_golden_flag_met":"false"}}' },
    ],
    diagnostics: [
      { timestamp: '2026-11-14T03:31:00.000Z', event: 'ohos.flutter.sdk', matched: true, branch: 'oh-3.41.9-dev', sdkId: '3.41.9-ohos' },
      { timestamp: '2026-11-14T06:47:45.000Z', event: 'step.prompt', state: '方案设计', step: '方案质疑' },
      { timestamp: '2026-11-14T06:47:45.100Z', event: 'ohos.flutter.sdk', matched: false, branch: 'B' },
    ],
  } });
  assert.equal(result.category, FAILURE_CATEGORIES.ISSUE_UNRESOLVED);
  assert.equal(result.canResume, false);
  assert.equal(result.action, 'preserve_failure_and_review');
  assert.equal(result.rootCause.code, 'sdk_branch_pin_corrupted');
  assert.equal(result.rootCause.stepKey, '方案设计-方案质疑');
  assert.equal(result.businessRootCause.code, 'fix_verification_not_confirmed');
});

test('distinguishes an earlier reproduction gap from an independent later platform defect', () => {
  const result = diagnoseFailure({ task: failedTask, run: {
    runId: 'run-1', status: 'failed', currentState: '修复验证',
    statusReason: '原始 Issue 的黄金标志尚未实测满足',
    stepLogs: [completedLog,
      { stepName: '问题复现-问题复现', status: 'completed', timestamp: '2026-11-14T04:00:00.000Z',
        output: '{"reproduction_status":"theoretical","device_id":"ALT-AL10 API 26；Issue 为 API 24","actual_behavior":"黄金标志未实际触发"}' },
      { stepName: '方案设计-方案质疑', status: 'completed', timestamp: '2026-11-14T06:47:45.100Z' },
      { ...failedLog, stepName: '方案设计-方案裁决', error: 'SDK 隔离目录不兼容或不完整', timestamp: '2026-11-14T06:53:25.161Z' },
      { ...failedLog, stepName: '修复验证-修复方案对抗验证', error: 'SDK 隔离目录缺少有效清单' },
      { stepName: '完成-诊断完成', status: 'completed', output: '{"verification_flags":{"bug_fixed":"false","issue_golden_flag_met":"false"}}' },
    ],
    diagnostics: [
      { timestamp: '2026-11-14T03:31:00.000Z', event: 'ohos.flutter.sdk', matched: true, branch: 'oh-3.41.9-dev', sdkId: '3.41.9-ohos' },
      { timestamp: '2026-11-14T06:47:45.000Z', event: 'step.prompt', state: '方案设计', step: '方案质疑' },
      { timestamp: '2026-11-14T06:47:45.100Z', event: 'ohos.flutter.sdk', matched: false, branch: 'B' },
    ],
  } });
  assert.equal(result.category, FAILURE_CATEGORIES.ISSUE_UNRESOLVED);
  assert.equal(result.businessRootCause.code, 'reproduction_not_established');
  assert.equal(result.businessRootCause.stepKey, '问题复现-问题复现');
  assert.equal(result.rootCause.code, 'sdk_branch_pin_corrupted');
  assert.equal(result.rootCause.domain, 'platform');
  assert.equal(result.causeRelationship.type, 'independent');
  assert.equal(result.causeRelationship.businessPrecedesPlatform, true);
  assert.match(result.summary, /修复平台故障不等于 Issue 已解决/);
  assert.equal(result.canResume, false);
});

test('a theoretical reproduction is not reported as a root cause when verification actually passed', () => {
  const result = diagnoseFailure({ task: { ...failedTask, stage: 'issueanalysis_complete' }, run: {
    runId: 'run-1', status: 'completed', stepLogs: [completedLog,
      { stepName: '问题复现-问题复现', status: 'completed', output: '{"reproduction_status":"theoretical"}' },
      { stepName: '完成-诊断完成', status: 'completed', output: '{"verification_flags":{"bug_fixed":"true","issue_golden_flag_met":"true"}}' },
    ],
  } });
  assert.equal(result.businessRootCause, null);
});

test('a later successful reproduction supersedes an earlier theoretical attempt', () => {
  const result = diagnoseFailure({ task: failedTask, run: { runId: 'run-1', status: 'failed', stepLogs: [completedLog,
    { stepName: '问题复现-问题复现', status: 'completed', output: '{"reproduction_status":"theoretical"}' },
    { stepName: '问题复现-问题复现', status: 'completed', output: '{"reproduction_status":"reproduced"}' },
    { stepName: '完成-诊断完成', status: 'completed', output: '{"verification_flags":{"bug_fixed":"false"}}' },
  ] } });
  assert.equal(result.businessRootCause.code, 'fix_verification_not_confirmed');
});

test('explicit evidence contradiction in an archived report cannot be bypassed', () => {
  const result = diagnoseFailure({ task: failedTask, run: { runId: 'run-1', status: 'failed',
    stepLogs: [completedLog, { stepName: '完成-诊断完成', status: 'completed',
      output: '{"verdict":"pass","verification_status":"needs_runtime_validation","consistency_warnings":[{"code":"android_evidence_contradiction","detail":"报告称未执行 Android，但存在 Android 证据"}]}' }],
  } });
  assert.equal(result.category, FAILURE_CATEGORIES.ISSUE_UNRESOLVED);
  assert.equal(result.canResume, false);
  assert.equal(result.action, 'preserve_failure_and_review');
});

test('missing runtime evidence remains visible and cannot be converted into verified', () => {
  const result = diagnoseFailure({ task: { ...failedTask, stage: 'issueanalysis_complete',
    metadata: { ...failedTask.metadata, verificationStatus: 'needs_runtime_validation' } }, run: {
    runId: 'run-1', status: 'completed', currentStep: failedLog.stepName,
    stepLogs: [{ ...failedLog, status: 'completed', output: '未获取 Android 真机证据' }],
  } });
  assert.equal(result.code, 'runtime_validation_missing');
  assert.match(result.guidance.prompt, /不得把真实/);
  assert.equal(result.canResume, true);
});

test('retry budget is per fingerprint and total; escalates instead of infinite recovery', () => {
  const run = { runId: 'run-1', status: 'failed', stepLogs: [{ ...failedLog, error: 'ETIMEDOUT' }] };
  const initial = diagnoseFailure({ task: failedTask, run });
  const result = diagnoseFailure({ task: failedTask, run, recovery: { attempts: [
    { fingerprint: initial.fingerprint }, { fingerprint: initial.fingerprint },
  ] } });
  assert.equal(result.retry.exhausted, true);
  assert.equal(result.action, 'escalate_retry_budget');
  assert.equal(result.canResume, false);
});

async function recoveryFixture(run, initial = failedTask, directory = null) {
  const store = storeFor({ [initial.taskId]: initial });
  const calls = [];
  const { createPlatformDefectLedger } = await import('../issueAnalysis/platformDefectLedger.js');
  const ledger = createPlatformDefectLedger(directory || await mkdtemp(join(tmpdir(), 'ace-recovery-test-')));
  const service = createFailureRecoveryService({
    store, aceConfigFile: 'cpf-ohos-diagnosis.yaml', stageAnalyzing: 'issueanalysis_analyzing',
    resumeWorkflow: async (runId, prompt) => { calls.push({ runId, prompt }); },
    singleFlight: (_key, operation) => operation(), logger: { info() {}, warn() {} },
    readRun: async () => run, supervisorReview: async (_run, diagnosis) => diagnosis, ledger,
  });
  return { store, service, calls, run };
}

test('guided resume preserves completed steps and injects only failure-step instructions', async () => {
  const run = { runId: 'run-1', configFile: 'cpf-ohos-diagnosis.yaml', status: 'failed', currentState: '问题复现', stepLogs: [completedLog, failedLog] };
  const { service, calls, store } = await recoveryFixture(run);
  const result = await service.continueTask('task-1', { feedback: '补齐证据后重新执行一致性检查' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, 'run-1');
  assert.match(calls[0].prompt, /Android 对照实验/);
  assert.match(calls[0].prompt, /补齐证据后重新执行一致性检查/);
  assert.ok(!calls[0].prompt.includes(completedLog.output));
  assert.equal(store.dump('task-1').stage, 'issueanalysis_analyzing');
  assert.equal(store.dump('task-1').metadata.failureRecovery.attempts.length, 1);
  assert.equal(result.step, '跨平台问题复现');
});

test('platform defect blocks resume until repair verification, then records and resumes same run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-recovery-test-'));
  const run = { runId: 'run-1', configFile: 'cpf-ohos-diagnosis.yaml', status: 'failed', stepLogs: [
    completedLog, { ...failedLog, error: '设备锁泄漏：stale host-ohos zombie lock still held' },
  ] };
  const { service, calls } = await recoveryFixture(run, failedTask, dir);
  await assert.rejects(service.continueTask('task-1'), /已登记平台缺陷/);
  assert.equal(calls.length, 0);
  const ledger = await service.listDefects();
  assert.equal(ledger.open, 1);
  await service.continueTask('task-1', { fixEvidence: 'device-lock 过期锁回归测试通过，已验证锁释放与队列交接' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /平台修复验证/);
  assert.equal((await service.listDefects()).fixVerified, 1);
});

test('true Issue failure and exhausted retries cannot be resumed', async () => {
  const trueFailure = { runId: 'run-1', configFile: 'cpf-ohos-diagnosis.yaml', status: 'failed', stepLogs: [
    completedLog, { ...failedLog, error: 'bug_fixed=false issue_golden_flag_met=false' },
  ] };
  const { service, calls } = await recoveryFixture(trueFailure);
  await assert.rejects(service.continueTask('task-1'), /真实验证失败/);
  assert.equal(calls.length, 0);

  const timeout = { runId: 'run-1', configFile: 'cpf-ohos-diagnosis.yaml', status: 'failed', stepLogs: [{ ...failedLog, error: 'ETIMEDOUT' }] };
  const first = diagnoseFailure({ task: failedTask, run: timeout });
  const task = { ...failedTask, metadata: { ...failedTask.metadata, failureRecovery: {
    attempts: [{ fingerprint: first.fingerprint }, { fingerprint: first.fingerprint }],
  } } };
  const exhausted = await recoveryFixture(timeout, task);
  await assert.rejects(exhausted.service.continueTask('task-1'), /需要人工排查/);
  assert.equal(exhausted.calls.length, 0);
});

test('transport failure does not erase failure evidence or silently restart', async () => {
  const run = { runId: 'run-1', configFile: 'cpf-ohos-diagnosis.yaml', status: 'failed', stepLogs: [completedLog, failedLog] };
  const store = storeFor({ 'task-1': failedTask });
  const service = createFailureRecoveryService({
    store, aceConfigFile: 'cpf-ohos-diagnosis.yaml', stageAnalyzing: 'issueanalysis_analyzing',
    resumeWorkflow: async () => { throw new Error('ACE offline'); },
    singleFlight: (_key, operation) => operation(), readRun: async () => run,
    supervisorReview: async (_run, diagnosis) => diagnosis, logger: { info() {}, warn() {} },
  });
  await assert.rejects(service.continueTask('task-1'), /ACE offline/);
  assert.equal(store.dump('task-1').stage, 'failed');
  assert.match(store.dump('task-1').metadata.failureRecovery.lastResumeError, /ACE offline/);
});

test('platform defect must be recorded and fixed before a guided resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-defect-test-'));
  const { createPlatformDefectLedger } = await import('../issueAnalysis/platformDefectLedger.js');
  const { record: recordPlatformDefect, markFixed: markPlatformDefectFixed, list: listPlatformDefects } = createPlatformDefectLedger(dir);
  const defect = await recordPlatformDefect({ signature: 'sig-1', code: 'device_lock_leak', title: '锁泄漏', runId: 'run-1', taskId: 'task-1', stepKey: '复现-真机复现' });
  await recordPlatformDefect({ signature: 'sig-1', code: 'device_lock_leak', title: '锁泄漏', runId: 'run-1', taskId: 'task-1', stepKey: '复现-真机复现' });
  assert.equal(defect.occurrenceCount, 1);
  assert.equal((await listPlatformDefects()).occurrences, 2);
  await assert.rejects(markPlatformDefectFixed('sig-1', '已修复'));
  const fixed = await markPlatformDefectFixed('sig-1', 'node --test device-lock 测试通过，已验证过期锁交接');
  assert.equal(fixed.status, 'fix_verified');
  assert.equal((await listPlatformDefects()).open, 0);
});
