// R1 验收：仅凭 status='completed' 不得宣称"门禁全绿"；由 gate-check 快照区分关闭/合入/通过/阻塞/未知。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveGateOutcome, runGateOutcomeOf } from '../prReview/client.js';

test('关闭未合入的 run：prState=closed，gateOutcome 不是 green', () => {
    const out = deriveGateOutcome({ closed: true, merged: false, phase: 'unknown', summary: 'PR 已关闭', head_sha: 'abc' });
    assert.equal(out.prState, 'closed');
    assert.equal(out.gateOutcome, 'closed');
    assert.notEqual(out.gateOutcome, 'green');
});

test('已合入的 run：prState=merged', () => {
    const out = deriveGateOutcome({ closed: true, merged: true, phase: 'green' });
    assert.equal(out.prState, 'merged');
    assert.equal(out.gateOutcome, 'merged');
});

test('门禁全绿才有 green', () => {
    const out = deriveGateOutcome({ closed: false, merged: false, phase: 'green' });
    assert.equal(out.prState, 'open');
    assert.equal(out.gateOutcome, 'green');
});

test('测试人通过有独立结果，不虚构全绿或已合入', () => {
    const out = deriveGateOutcome({ phase: 'tester_approved', summary: '测试人已全部通过', build_passed: false });
    assert.equal(out.gateOutcome, 'tester_approved');
    assert.equal(out.prState, 'open');
    assert.equal(deriveGateOutcome({ phase: 'tester_approved', closed: true }).gateOutcome, 'closed');
    assert.equal(deriveGateOutcome({ phase: 'tester_approved', merged: true }).gateOutcome, 'merged');
});

test('页面明确区分测试人通过、未知和归档失败', async () => {
    const source = await readFile(new URL('../../web/public/js/prreview.js', import.meta.url), 'utf8');
    const fn = source.match(/function _prDoneNoteInner\([^]*?\n\}/)[0];
    const context = vm.createContext({ escHtml: value => String(value).replaceAll('<', '&lt;') });
    vm.runInContext(fn, context);
    const render = context._prDoneNoteInner;
    const approved = render({ prState: 'open', gateOutcome: 'tester_approved' });
    assert.match(approved, /测试人已通过/);
    assert.doesNotMatch(approved, /全绿|需人工处理|结果未确认/);
    assert.match(render({ gateOutcome: 'unknown' }), /结果未确认/);
    assert.match(render({ gateOutcome: 'green', artifactStatus: 'partial' }), /归档不完整/);
    assert.doesNotMatch(render({ gateOutcome: 'green', artifactStatus: 'failed' }), /全绿/);
});

test('限流阻塞与编译失败分别归为 blocked / failed', () => {
    assert.equal(deriveGateOutcome({ closed: false, phase: 'blocked_rate_limit' }).gateOutcome, 'blocked');
    assert.equal(deriveGateOutcome({ closed: false, phase: 'compile_failed' }).gateOutcome, 'failed');
    assert.equal(deriveGateOutcome({ closed: false, phase: 'running' }).gateOutcome, 'running');
});

test('runGateOutcomeOf 读取归档；缺失归档返回空值（按未知处理）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr-gate-'));
    try {
        await mkdir(join(root, 'run-1', 'outputs'), { recursive: true });
        await writeFile(join(root, 'run-1', 'outputs', 'gate-check.json'),
            JSON.stringify({ closed: true, merged: false, phase: 'unknown', summary: 'PR 已关闭', head_sha: 'deadbeef' }));
        const found = runGateOutcomeOf('run-1', root);
        assert.equal(found.prState, 'closed');
        assert.equal(found.gateHeadSha, 'deadbeef');
        assert.equal(runGateOutcomeOf('run-missing', root).gateOutcome, '');
        await writeFile(join(root, 'run-1', 'outputs', 'pr-archive-manifest.json'), JSON.stringify({
            version: 2, artifact_status: 'partial', entries: [{ name: 'gate-source.json', status: 'missing' }],
        }));
        assert.equal(runGateOutcomeOf('run-1', root).artifactStatus, 'partial');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
