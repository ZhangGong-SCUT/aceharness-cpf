import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactSummaryCache } from '../issueAnalysis/artifactSummaryCache.js';
import { issueDetailStatus } from '../issueAnalysis/detailPresentation.js';

test('历史产物只扫描一次，同 run 并发共享扫描，失效后才重新扫描', async () => {
    let reads = 0;
    let release = () => {};
    const readScan = async () => {
        reads++;
        await new Promise(resolve => { release = resolve; });
        return { files: [{ name: 'fix.patch' }] };
    };
    const cache = createArtifactSummaryCache({ read: readScan, defer: readScan });
    const first = cache.get('run-1', true);
    const second = cache.get('run-1', true);
    await new Promise(resolve => setImmediate(resolve));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(reads, 1);
    assert.equal(a.files[0].name, 'fix.patch');
    assert.equal(await cache.get('run-1', true), a);
    assert.equal(reads, 1);
    cache.invalidate('run-1');
    const next = cache.get('run-1', true);
    await new Promise(resolve => setImmediate(resolve));
    release();
    await next;
    assert.equal(reads, 2);
});

test('真实产物 worker 返回目录摘要并正常退出', async () => {
    const cache = createArtifactSummaryCache();
    const result = await cache.get('__performance_probe__', false);
    assert.deepEqual(result, { runId: '__performance_probe__', images: [], logs: [], files: [], steps: [] });
    cache.invalidate('__performance_probe__');
});

test('详情保留所有时间线步骤和日志引用，不传输大型执行审计', () => {
    const status = issueDetailStatus({
        runId: 'run-1', status: 'completed', currentPhase: '报告沉淀',
        diagnosisVerificationStatus: 'passed',
        stepLogs: [{ stepName: '问题复现-验证', status: 'completed', timestamp: '2026-11-16T00:00:00Z', outputRef: 'outputs/repro.md', output: '长日志'.repeat(2000), tokenUsage: { huge: 'data' } }],
        stateHistory: [{ content: '不需要' }], subworkflowRuns: [{ content: '不需要' }],
    });
    assert.equal(status.stepLogs.length, 1);
    assert.equal(status.stepLogs[0].outputRef, 'outputs/repro.md');
    assert.equal(status.stepLogs[0].output, undefined);
    assert.equal(status.stateHistory, undefined);
    assert.equal(status.subworkflowRuns, undefined);
    assert.equal(status.diagnosisVerificationStatus, 'passed');
});
