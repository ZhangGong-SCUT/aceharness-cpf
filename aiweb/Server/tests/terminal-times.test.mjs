// F08 验收：分别构造"引擎返回有/无 endTime（旧字段 runEndTime）"的状态对象验证时间契约
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTerminalTimes } from '../issueAnalysis/terminalTimes.js';

const NOW = '2026-10-13T03:00:00.000Z';

test('引擎返回规范 endTime：finishedAt 使用引擎时间，不用查询时间', () => {
    const r = resolveTerminalTimes(
        { status: 'completed', startTime: '2026-10-13T01:00:00Z', endTime: '2026-10-13T02:30:00Z' },
        {}, {}, NOW);
    assert.equal(r.finishedAt, '2026-10-13T02:30:00Z');
    assert.equal(r.engineEndedAt, '2026-10-13T02:30:00Z');
    assert.equal(r.engineStartedAt, '2026-10-13T01:00:00Z');
});

test('引擎只给旧字段 runEndTime（持久化恢复路径）：同样识别', () => {
    const r = resolveTerminalTimes(
        { status: 'completed', runEndTime: '2026-10-13T02:31:00Z' }, {}, {}, NOW);
    assert.equal(r.finishedAt, '2026-10-13T02:31:00Z');
});

test('引擎时间缺失：固化为首次观察到终态的时间，后续查询不再漂移', () => {
    const first = resolveTerminalTimes({ status: 'completed' }, {}, {}, NOW);
    assert.equal(first.finishedAt, NOW);
    assert.equal(first.terminalObservedAt, NOW);
    // 一小时后再次查询：terminalObservedAt 已固化，finishedAt 不漂移
    const later = resolveTerminalTimes({ status: 'completed' },
        { terminalObservedAt: first.terminalObservedAt }, {}, '2026-10-13T04:00:00.000Z');
    assert.equal(later.finishedAt, NOW);
    assert.equal(later.terminalObservedAt, NOW);
});

test('引擎时间晚到：已固化的 engineEndedAt 不被 null 覆盖，新引擎时间可补齐', () => {
    const meta = { engineEndedAt: '2026-10-13T02:30:00Z', terminalObservedAt: NOW };
    const r = resolveTerminalTimes({ status: 'completed' }, meta, {}, '2026-10-13T04:00:00Z');
    assert.equal(r.engineEndedAt, '2026-10-13T02:30:00Z');
    assert.equal(r.finishedAt, '2026-10-13T02:30:00Z');
});

test('task.finishedAt 作为最后兜底（历史任务兼容）', () => {
    const r = resolveTerminalTimes({ status: 'failed' }, {},
        { finishedAt: '2026-10-12T20:00:00Z' }, NOW);
    assert.equal(r.finishedAt, '2026-10-12T20:00:00Z');
    assert.equal(r.terminalObservedAt, NOW);
});
