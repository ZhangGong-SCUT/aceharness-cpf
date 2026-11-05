// 回归：dispatch receipt 合并语义——创建时写入的 F03 审计字段不得在 dispatch 时丢失。
// 复刻 service.js _dispatchTask 的合并表达式（修复后版本），钉住语义防回退。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'cpf-store-'));
process.env.TASK_DB_DIR = dbDir;

const { HybridTaskStore } = await import('../library/HybridTaskStore.js');

test('create 的 inputMode/inputSha256/evaluationMode 在 dispatch receipt 后保留', async () => {
    const store = new HybridTaskStore('issueanalysis-test.db');
    await store.ready?.();
    const taskId = 'ia-test-1';
    store.create({
        taskId, stage: 'issueanalysis_pending', issueUrl: 'https://gitcode.com/o/r/issues/1',
        metadata: { requestKey: 'k1', configFile: 'cpf-ohos-diagnosis.yaml',
            inputMode: 'snapshot', inputSha256: 'ab'.repeat(32), evaluationMode: 'blind_eval' },
    });
    // 修复后的 receipt 构造：合并已有 metadata，而非替换
    const existing = store.get(taskId);
    const existingMeta = typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : existing.metadata;
    const receipt = { ...existingMeta, requestKey: 'k1', runId: 'run-x', configFile: 'cpf-ohos-diagnosis.yaml', startState: 'dispatching' };
    store.patch(taskId, { analysisSessionId: 'run-x', metadata: receipt });

    const after = store.get(taskId);
    const meta = typeof after.metadata === 'string' ? JSON.parse(after.metadata) : after.metadata;
    assert.equal(meta.inputMode, 'snapshot');
    assert.equal(meta.evaluationMode, 'blind_eval');
    assert.equal(meta.inputSha256, 'ab'.repeat(32));
    assert.equal(meta.startState, 'dispatching');
    assert.equal(meta.runId, 'run-x');
});

test('清理', () => { rmSync(dbDir, { recursive: true, force: true }); });
