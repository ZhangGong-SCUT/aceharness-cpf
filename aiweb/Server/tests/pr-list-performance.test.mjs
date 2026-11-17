import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listLocalPrRuns, findLocalPrRun } from '../prReview/localRunSummaries.js';
import { createRecentQueryCache } from '../prReview/recentQueryCache.js';

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'aiweb-pr-summary-'));
    for (const [index, runId] of ['run-1-pr7-abcdef', 'run-2-pr8-abcdef', 'run-3-pr7-abcdef'].entries()) {
        await mkdir(join(root, runId));
        await writeFile(join(root, runId, 'summary.json'), JSON.stringify({
            runId, configFile: 'gitcode-pr-review.yaml', ownerId: 'owner-a', ownerName: 'alice',
            startTime: ['2026-11-01', '2026-11-03', '2026-11-02'][index] + 'T00:00:00.000Z', status: 'running',
        }));
    }
    await mkdir(join(root, 'run-4-pr9-abcdef'));
    await writeFile(join(root, 'run-4-pr9-abcdef', 'summary.json'), JSON.stringify({
        runId: 'run-4-pr9-abcdef', configFile: 'gitcode-pr-review.yaml', ownerId: 'owner-b',
        startTime: '2026-11-04T00:00:00.000Z', status: 'completed',
    }));
    return root;
}

test('本机摘要按会话归属筛选，分页且同 PR 只保留最新记录', async () => {
    const root = await fixture();
    try {
        const result = await listLocalPrRuns({
            user: { id: 'owner-a', role: 'user' }, runsRoot: root, configFile: 'gitcode-pr-review.yaml',
            enrich: summary => ({ runId: summary.runId, prNumber: /pr(\d+)/.exec(summary.runId)[1], repo: 'flutter', startTime: summary.startTime }),
        });
        assert.deepEqual(result.runs.map(run => run.runId), ['run-2-pr8-abcdef', 'run-3-pr7-abcdef']);
        assert.equal(result.total, 2);
        const paged = await listLocalPrRuns({
            user: { id: 'owner-a', role: 'user' }, runsRoot: root, configFile: 'gitcode-pr-review.yaml', pageSize: 1,
            enrich: summary => ({ runId: summary.runId, prNumber: /pr(\d+)/.exec(summary.runId)[1], repo: 'flutter', startTime: summary.startTime }),
        });
        assert.equal(paged.total, 2);
        assert.equal(paged.totalPages, 2);
        assert.equal(paged.runs[0].runId, 'run-2-pr8-abcdef');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('旧摘要缺归属时回退原接口，不向普通用户暴露记录', async () => {
    const root = await fixture();
    try {
        await writeFile(join(root, 'run-1-pr7-abcdef', 'summary.json'), JSON.stringify({
            runId: 'run-1-pr7-abcdef', configFile: 'gitcode-pr-review.yaml',
        }));
        const result = await listLocalPrRuns({ user: { id: 'owner-a', role: 'user' }, runsRoot: root, configFile: 'gitcode-pr-review.yaml' });
        assert.equal(result, null);
        await assert.rejects(() => listLocalPrRuns({ user: null, runsRoot: root, configFile: 'gitcode-pr-review.yaml' }), /登录已过期/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('单个摘要只读目标记录，普通用户不能读取他人运行', async () => {
    const root = await fixture();
    try {
        const common = { runsRoot: root, configFile: 'gitcode-pr-review.yaml', runId: 'run-1-pr7-abcdef' };
        const own = await findLocalPrRun({ ...common, user: { id: 'owner-a', role: 'user' } });
        assert.equal(own.runId, common.runId);
        assert.equal(await findLocalPrRun({ ...common, user: { id: 'owner-b', role: 'user' } }), null);
        assert.equal(await findLocalPrRun({ ...common, user: { id: 'admin', role: 'admin' } }).then(run => run.runId), common.runId);
        assert.equal(await findLocalPrRun({ ...common, runId: '../private', user: { id: 'owner-a', role: 'user' } }), null);
        assert.equal(await findLocalPrRun({ ...common, runId: 'run-unknown', user: { id: 'owner-a', role: 'user' } }), undefined, '摘要缺失留给 ACE 在线校验');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('短缓存合并相同并发查询，隔离用户并可按会话整体失效', async () => {
    const cache = createRecentQueryCache();
    let calls = 0;
    let release;
    const read = () => { calls++; return new Promise(resolve => { release = () => resolve({ calls }); }); };
    const pending = Promise.all([cache.get('alice', ['runs', 1], read), cache.get('alice', ['runs', 1], read)]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    await pending;
    assert.equal(calls, 1);
    await cache.get('alice', ['runs', 2], async () => { calls++; return {}; });
    await cache.get('bob', ['runs', 1], async () => { calls++; return {}; });
    assert.equal(calls, 3);
    cache.invalidate('alice');
    await cache.get('alice', ['runs', 1], async () => { calls++; return {}; });
    await cache.get('alice', ['runs', 2], async () => { calls++; return {}; });
    await cache.get('bob', ['runs', 1], async () => { calls++; return {}; });
    assert.equal(calls, 5, '只让当前会话的缓存失效，不影响其他用户');
});

test('单条详情归属只读对应摘要，缺摘要仍回退在线接口', async () => {
    const root = await fixture();
    try {
        const owner = { id: 'owner-a', role: 'user' };
        const owned = await findLocalPrRun({ user: owner, runsRoot: root, configFile: 'gitcode-pr-review.yaml', runId: 'run-1-pr7-abcdef' });
        assert.equal(owned.runId, 'run-1-pr7-abcdef');
        assert.equal(owned.status, 'running');
        assert.equal(await findLocalPrRun({ user: owner, runsRoot: root, configFile: 'gitcode-pr-review.yaml', runId: 'run-4-pr9-abcdef' }), null);
        assert.equal(await findLocalPrRun({ user: owner, runsRoot: root, configFile: 'gitcode-pr-review.yaml', runId: 'run-missing-pr7-abcdef' }), undefined);
        const admin = await findLocalPrRun({ user: { id: 'admin', role: 'admin' }, runsRoot: root, configFile: 'gitcode-pr-review.yaml', runId: 'run-4-pr9-abcdef' });
        assert.equal(admin.runId, 'run-4-pr9-abcdef');
    } finally { await rm(root, { recursive: true, force: true }); }
});
