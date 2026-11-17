import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalStatusCache } from '../issueAnalysis/statusSnapshots.js';

const status = {
    runId: 'run-1', status: 'completed',
    stepLogs: [{ stepName: '报告沉淀-生成诊断报告', status: 'completed', outputRef: 'outputs/report.md' }],
};

test('终态超时只回退同一 run 的成功快照，保留时间线', () => {
    const cache = createTerminalStatusCache();
    const task = { taskId: 'ia-1', stage: 'issueanalysis_complete' };
    assert.equal(cache.get(task, 'run-1'), null, '首次访问没有快照时不能伪造');
    cache.put(task, 'run-1', status);
    const cached = cache.get(task, 'run-1');
    assert.equal(cached.stepLogs[0].stepName, '报告沉淀-生成诊断报告');
    assert.equal(cache.get({ taskId: 'ia-other', stage: 'issueanalysis_complete' }, 'run-1'), null, '不能跨任务串数据');
    assert.equal(cache.get(task, 'run-other'), null, '同一任务换 run 后旧快照必须失效');
    cache.invalidate('ia-1');
    assert.equal(cache.get(task, 'run-1'), null, '恢复运行前显式清除终态');
});

test('运行中的任务不读取或写入终态缓存，不覆盖引擎当前状态', () => {
    const cache = createTerminalStatusCache();
    const task = { taskId: 'ia-running', stage: 'failed' };
    cache.put(task, 'run-1', status);
    const running = { ...task, stage: 'issueanalysis_analyzing' };
    assert.equal(cache.get(running, 'run-1'), null);
    cache.put(running, 'run-1', status);
    assert.equal(cache.get({ ...running, stage: 'failed' }, 'run-1').stepLogs.length, 1, '运行中写入不能覆盖先前成功快照');
    cache.put(task, 'run-1', { ...status, status: 'running' });
    assert.equal(cache.get(task, 'run-1').stepLogs.length, 1, '运行状态写入不能覆盖已有的成功快照');
});
