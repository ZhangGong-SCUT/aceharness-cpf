// F03 验收（CPF 侧）：快照写入的哈希命名、幂等、落盘一致性、上限
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { EVAL_INPUTS_DIR, writeIssueSnapshot } from '../issueAnalysis/snapshotInput.js';

const BODY = '# 盲测快照\n\n症状描述正文，不含修复线索。\n';
const created = [];

test('writeIssueSnapshot：以内容哈希命名并落盘，回读一致', () => {
    const r = writeIssueSnapshot(BODY);
    created.push(r.path);
    assert.equal(r.sha256, createHash('sha256').update(BODY).digest('hex'));
    assert.ok(r.path.startsWith(EVAL_INPUTS_DIR));
    assert.ok(r.path.endsWith(`${r.sha256}.md`));
    assert.equal(readFileSync(r.path, 'utf8'), BODY);
    assert.equal(r.bytes, Buffer.byteLength(BODY));
});

test('writeIssueSnapshot：同内容幂等复用同一路径', () => {
    const a = writeIssueSnapshot(BODY);
    const b = writeIssueSnapshot(BODY);
    created.push(a.path);
    assert.equal(a.path, b.path);
    assert.equal(a.sha256, b.sha256);
});

test('writeIssueSnapshot：过短/超长拒绝', () => {
    assert.throws(() => writeIssueSnapshot('   '), /过短/);
    assert.throws(() => writeIssueSnapshot('x'.repeat(300 * 1024)), /上限/);
});

test('清理', () => {
    for (const f of created) if (existsSync(f)) rmSync(f);
});
