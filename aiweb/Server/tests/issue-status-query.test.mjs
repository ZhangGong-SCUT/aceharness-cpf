import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'cpf-issue-status-'));
process.env.NODE_ENV = 'test';
process.env.ISSUEANALYSIS_ROOT = dbDir;
const { getTaskStatus, setIssueStatusTestDependencies } = await import('../issueAnalysis/service.js');
const { HybridTaskStore } = await import('../library/HybridTaskStore.js');
const store = new HybridTaskStore('issueanalysis.db');
store.initialize();
setIssueStatusTestDependencies({ store });

function task(taskId, stage) {
    store.create({ taskId, cliType: 'aceharness', stage, analysisSessionId: 'run-1',
        metadata: { runId: 'run-1', configFile: 'cpf-ohos-diagnosis.yaml' } });
}
const completed = { runId: 'run-1', status: 'completed', endTime: '2026-11-16T06:00:00.000Z',
    stepLogs: [{ stepName: '问题复现-跨平台问题复现', status: 'completed', outputRef: 'outputs/repro.md' }] };

test('真实状态协调入口复用已确认终态，不重复加载大型 ACE 状态', async () => {
    task('ia-terminal', 'issueanalysis_complete');
    let reads = 0;
    setIssueStatusTestDependencies({ readStatus: async () => { reads++; return completed; } });
    const first = await getTaskStatus('ia-terminal');
    assert.equal(first.aceharnessStatus.stepLogs.length, 1);
    const second = await getTaskStatus('ia-terminal');
    assert.equal(second.aceharnessStatus.stepLogs[0].stepName, '问题复现-跨平台问题复现');
    assert.equal(reads, 1, '同一任务同一 run 的再次打开不应请求上游');
    assert.equal(second.queryUnavailable, false, '终态展示命中不是查询故障');
    assert.equal(second.stage, 'issueanalysis_complete');
    assert.equal(second.statusAsOf, first.statusAsOf, '终态缓存不伪装新的成功查询');
});

test('失败状态只读已有分诊，不隐式触发监督模型', async () => {
    setIssueStatusTestDependencies({ readStatus: async () => completed });
    task('ia-read-only-triage', 'failed');
    const result = await getTaskStatus('ia-read-only-triage');
    assert.equal(result.failureDiagnosis, null, '没有已存分诊时只展示原始失败，不隐式审查');
    store.patch('ia-read-only-triage', { metadata: { failureRecovery: { diagnosis: { category: 'platform_defect' } } } });
    assert.equal((await getTaskStatus('ia-read-only-triage')).failureDiagnosis.category, 'platform_defect');
});

test('真实状态协调入口不给运行中的任务套用旧终态', async () => {
    task('ia-running', 'issueanalysis_complete');
    setIssueStatusTestDependencies({ readStatus: async () => completed });
    await getTaskStatus('ia-running');
    store.patch('ia-running', { stage: 'issueanalysis_analyzing', finishedAt: null });
    setIssueStatusTestDependencies({ readStatus: async () => { throw new Error('ETIMEDOUT'); } });
    const result = await getTaskStatus('ia-running');
    assert.equal(result.stage, 'issueanalysis_analyzing');
    assert.equal(result.aceharnessStatus, null);
    assert.equal(result.queryUnavailable, true);
});

test.after(() => {
    store.close();
    rmSync(dbDir, { recursive: true, force: true });
});
