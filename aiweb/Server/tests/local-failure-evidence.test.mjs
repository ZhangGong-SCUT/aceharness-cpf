import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { readLocalIssueRunForTriage, readLocalDiagnosticEvents } from '../issueAnalysis/localFailureEvidence.js';
import { loadIssueRunForTriage } from '../issueAnalysis/failureAnalysisAdapter.js';
import { diagnoseFailure } from '../issueAnalysis/failureTriage.js';

const directories = [];
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'ace-local-triage-'));
    directories.push(directory);
    return directory;
}
test.after(async () => Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))));

async function realEvidenceFixture() {
    const root = await fixture();
    const runId = 'run-real-evidence';
    const directory = join(root, runId);
    await mkdir(join(directory, 'outputs', 'step-logs'), { recursive: true });
    const finalResult = {
        version: 1, runId, stepName: '完成-诊断完成',
        fields: { verdict: 'pass', verification_flags: { bug_fixed: 'false', issue_golden_flag_met: 'false' } },
    };
    await writeFile(join(directory, 'outputs', 'step-logs', 'finish.result.json'), JSON.stringify(finalResult));
    const reproductionResult = {
        version: 1, runId, stepName: '问题复现-问题复现',
        fields: {
            reproduction_status: 'theoretical',
            device_id: 'ALT-AL10（API 26；Issue 设备为 API 24 ALN-AL00）',
            actual_behavior: '本机 API 26 两变体 B=2、C=2 均正常，黄金标志未实际触发',
        },
    };
    await writeFile(join(directory, 'outputs', 'step-logs', 'reproduction.result.json'), JSON.stringify(reproductionResult));
    await writeFile(join(directory, 'state.yaml'), stringify({
        runId, configFile: 'cpf-ohos-diagnosis.yaml', status: 'failed', currentPhase: '完成',
        statusReason: '原始 Issue 仍为 theoretical，替代环境不能证明已修复', completedSteps: ['完成-诊断完成'],
        stepLogs: [
            { stepName: '问题复现-问题复现', status: 'completed', resultRef: 'outputs/step-logs/reproduction.result.json', timestamp: '2026-11-15T12:10:00.000Z' },
            { stepName: '方案设计-方案质疑', status: 'completed', timestamp: '2026-11-15T14:47:45.969Z' },
            { stepName: '方案设计-方案裁决', status: 'failed', error: 'SDK 隔离目录不兼容或不完整', timestamp: '2026-11-15T14:53:25.161Z' },
            { stepName: '修复验证-修复方案对抗验证', status: 'failed', error: 'SDK 隔离目录缺少有效清单', timestamp: '2026-11-15T19:06:21.078Z' },
            { stepName: '完成-诊断完成', status: 'completed', resultRef: 'outputs/step-logs/finish.result.json', timestamp: '2026-11-16T06:00:29.594Z' },
        ],
    }, { lineWidth: 0 }));
    await writeFile(join(directory, 'diagnostics.jsonl'), [
        { event: 'ohos.flutter.sdk', matched: true, branch: 'oh-3.41.9-dev', sdkId: '3.41.9-ohos', timestamp: '2026-11-15T11:31:37.884Z' },
        { event: 'step.prompt', state: '方案设计', step: '方案质疑', prompt: '秘密提示词', timestamp: '2026-11-15T14:45:38.227Z' },
        { event: 'ohos.flutter.sdk', matched: false, branch: 'B', reason: '无对应 SDK', output: '秘密输出', timestamp: '2026-11-15T14:47:45.969Z' },
    ].map(JSON.stringify).join('\n'));
    return { root, runId, directory };
}

test('local fallback distinguishes the causal event, later failure and unresolved final verdict', async () => {
    const { root, runId } = await realEvidenceFixture();
    const run = await readLocalIssueRunForTriage(runId, 'cpf-ohos-diagnosis.yaml', root);
    const diagnosis = diagnoseFailure({ task: { taskId: 'ia-real', stage: 'failed' }, run });
    assert.equal(diagnosis.category, 'issue_unresolved');
    assert.equal(diagnosis.canResume, false);
    assert.equal(diagnosis.rootCause.actualBranch, 'B');
    assert.equal(diagnosis.rootCause.stepKey, '方案设计-方案质疑');
    assert.equal(diagnosis.originFailedStep.stepKey, '方案设计-方案裁决');
    assert.equal(diagnosis.failedStep.stepKey, '修复验证-修复方案对抗验证');
    assert.equal(diagnosis.businessRootCause.code, 'reproduction_not_established');
    assert.equal(diagnosis.businessRootCause.stepKey, '问题复现-问题复现');
    assert.equal(diagnosis.causeRelationship.businessPrecedesPlatform, true);
    assert.match(diagnosis.summary, /修复平台故障不等于 Issue 已解决/);
    assert.equal(diagnosis.platformDefect, null, 'a final unresolved verdict must not enter the platform-defect ledger');
});

test('compact API evidence avoids full-detail timeouts and restores omitted final verification fields', async () => {
    const { root, runId } = await realEvidenceFixture();
    const disk = await readLocalIssueRunForTriage(runId, 'cpf-ohos-diagnosis.yaml', root);
    const compact = { ...disk, stepLogs: disk.stepLogs.map(log => ({ ...log, output: '' })) };
    const run = await loadIssueRunForTriage(runId, 'cpf-ohos-diagnosis.yaml', {
        token: 'not-returned', readStatus: async () => compact,
        localReader: async () => readLocalDiagnosticEvents(runId, root),
        localRunReader: async () => disk,
    });
    const diagnosis = diagnoseFailure({ task: { taskId: 'ia-real', stage: 'failed' }, run });
    assert.equal(diagnosis.category, 'issue_unresolved');
    assert.equal(diagnosis.canResume, false);
    assert.match(run.stepLogs.at(-1).output, /bug_fixed/);
    assert.match(run.stepLogs[0].output, /reproduction_status/);
    assert.equal(diagnosis.businessRootCause.stepKey, '问题复现-问题复现');
    assert.equal(JSON.stringify(run).includes('秘密提示词'), false);
    assert.equal(JSON.stringify(run).includes('秘密输出'), false);
});

test('full-detail timeout falls back to bounded persisted steps without resuming the run', async () => {
    const run = { runId: 'run-1', configFile: 'cpf-ohos-diagnosis.yaml', status: 'failed', currentState: '问题复现',
        stepLogs: [{ stepName: '问题复现-跨平台复现', status: 'failed', error: 'Android 对照实验未执行' }] };
    const result = await loadIssueRunForTriage('run-1', 'cpf-ohos-diagnosis.yaml', {
        token: 'test', readStatus: async () => { throw new Error('请求超时'); },
        readPersisted: async () => run, localReader: async () => [],
        localRunReader: async () => null,
    });
    assert.equal(result.stepLogs[0].error, 'Android 对照实验未执行');
    assert.deepEqual(result.diagnostics, []);
});

test('old ACE persisted summary still recovers the full causal history and final verification', async () => {
    const { root, runId } = await realEvidenceFixture();
    const disk = await readLocalIssueRunForTriage(runId, 'cpf-ohos-diagnosis.yaml', root);
    const run = await loadIssueRunForTriage(runId, 'cpf-ohos-diagnosis.yaml', {
        token: 'test', readStatus: async () => { throw new Error('旧 ACE 查询超时'); },
        readPersisted: async () => ({ runId, configFile: 'cpf-ohos-diagnosis.yaml', status: 'failed',
            stepLogs: [{ stepName: '修复验证-修复方案对抗验证', status: 'failed', error: 'SDK 隔离目录缺少有效清单' }] }),
        localReader: async () => readLocalDiagnosticEvents(runId, root),
        localRunReader: async () => disk,
        readDiagnosticEvents: async () => ({ status: 200, data: '<html>旧 ACE 前端兜底</html>' }),
    });
    const diagnosis = diagnoseFailure({ task: { taskId: 'ia-real', stage: 'failed' }, run });
    assert.equal(diagnosis.rootCause.stepKey, '方案设计-方案质疑');
    assert.equal(diagnosis.originFailedStep.stepKey, '方案设计-方案裁决');
    assert.equal(diagnosis.category, 'issue_unresolved');
    assert.match(run.stepLogs.find(log => log.stepName === '完成-诊断完成').output, /bug_fixed/);
});

test('local reader fails closed on identity mismatches, oversized state and arbitrary paths', async () => {
    const { root, runId } = await realEvidenceFixture();
    assert.equal(await readLocalIssueRunForTriage(runId, 'another.yaml', root), null);
    assert.equal(await readLocalIssueRunForTriage('../private', 'cpf-ohos-diagnosis.yaml', root), null);
    assert.equal(await readLocalIssueRunForTriage('run-../../private', 'cpf-ohos-diagnosis.yaml', root), null);
    await writeFile(join(root, runId, 'state.yaml'), 'runId: wrong-run\nconfigFile: cpf-ohos-diagnosis.yaml\n');
    assert.equal(await readLocalIssueRunForTriage(runId, 'cpf-ohos-diagnosis.yaml', root), null);
});

test('diagnostic events never return prompt or output contents and redact credential-like values', async () => {
    const { root, runId, directory } = await realEvidenceFixture();
    await writeFile(join(directory, 'diagnostics.jsonl'), JSON.stringify({
        event: 'step.fail', step: '方案裁决', error: 'token ghp_secret-value', prompt: '禁止泄露', output: '也禁止泄露',
    }));
    const events = await readLocalDiagnosticEvents(runId, root);
    assert.equal(events[0].error, 'token [已隐藏凭证]');
    assert.equal(JSON.stringify(events).includes('禁止泄露'), false);
    assert.equal(JSON.stringify(events).includes('ghp_'), false);
});
