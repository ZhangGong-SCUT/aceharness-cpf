// F09 验收：用两个 mock 任务验证诊断链计数口径
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeChainMetrics } from '../issueAnalysis/chainMetrics.js';
import { STAGE } from '../orchestrator/stages.js';

test('两个 mock 任务：一个分析中一个已完成，口径正确', () => {
    const tasks = [
        { taskId: 'ia-1', stage: STAGE.ISSUEANALYSIS_ANALYZING ?? 'analyzing', metadata: { requestKey: 'a' } },
        { taskId: 'ia-2', stage: STAGE.ISSUEANALYSIS_COMPLETE, metadata: {} },
    ];
    const m = computeChainMetrics(tasks, '2026-10-13T05:00:00Z');
    assert.equal(m.total, 2);
    assert.equal(m.active, 1);
    assert.equal(m.terminal, 1);
    assert.equal(m.computedAt, '2026-10-13T05:00:00Z');
    // 活跃任务必须被数到——不能再出现"有任务在跑但 running=0"
    assert.equal(Object.values(m.byStage).reduce((a, b) => a + b, 0), 2);
});

test('查询降级计数：进行中任务带 queryHealth.error 才被统计', () => {
    const tasks = [
        { taskId: 'ia-1', stage: STAGE.ISSUEANALYSIS_ANALYZING ?? 'analyzing',
          metadata: JSON.stringify({ queryHealth: { error: '状态查询超时' } }) },
        { taskId: 'ia-2', stage: STAGE.ISSUEANALYSIS_ANALYZING ?? 'analyzing',
          metadata: { queryHealth: { error: null } } },
        { taskId: 'ia-3', stage: STAGE.ISSUEANALYSIS_COMPLETE,
          metadata: { queryHealth: { error: '历史错误（已终态不计）' } } },
    ];
    const m = computeChainMetrics(tasks);
    assert.equal(m.active, 2);
    assert.equal(m.queryDegraded, 1);
});

test('空列表与异常输入不炸', () => {
    assert.deepEqual(computeChainMetrics([]).total, 0);
    assert.equal(computeChainMetrics(null).active, 0);
    assert.equal(computeChainMetrics([{ }]).byStage.unknown, 1);
});
