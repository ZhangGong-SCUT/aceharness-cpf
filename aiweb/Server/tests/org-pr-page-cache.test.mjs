import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOrgPrPageCache } from '../prReview/orgPrPageCache.js';

const options = { org: 'CPF-Flutter', state: 'open', author: 'Alice', page: 1, perPage: 20 };

test('过期组织 PR 页立即返回旧快照，后台更新并合并并发', async () => {
    let now = 100000;
    const cache = createOrgPrPageCache({ now: () => now, ttlMs: 1000 });
    let calls = 0;
    assert.deepEqual(await cache.get(options, false, async () => ({ prs: [{ number: 1 }] })), { prs: [{ number: 1 }] });
    now += 5000;
    let release;
    const read = () => { calls++; return new Promise(resolve => { release = () => resolve({ prs: [{ number: 2 }] }); }); };
    const stale = await cache.get(options, false, read);
    assert.deepEqual(stale, { prs: [{ number: 1 }], stale: true });
    assert.equal((await cache.get(options, false, read)).stale, true);
    assert.equal(calls, 1);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await cache.get(options, false, read), { prs: [{ number: 2 }] });
});

test('连续强制刷新被去重，不叠加慢 GitCode 请求', async () => {
    const cache = createOrgPrPageCache();
    let calls = 0;
    await cache.get(options, false, async () => ({ prs: [] }));
    const first = await cache.get(options, true, async () => { calls++; return { prs: [{ number: 1 }] }; });
    const second = await cache.get(options, true, async () => { calls++; return { prs: [{ number: 2 }] }; });
    assert.equal(calls, 1);
    assert.deepEqual(second, { ...first, stale: true });
});

test('成功分页缓存落盘，新进程无需等待外部服务即可展示最近结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiweb-org-cache-'));
    try {
        const file = join(root, 'nested', 'pages.json');
        const first = createOrgPrPageCache({ file });
        await first.get(options, false, async () => ({ prs: [{ number: 7, title: '测试' }] }));
        await new Promise(resolve => setTimeout(resolve, 20));
        const disk = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(Object.values(disk)[0].data.prs[0].number, 7);
        assert.ok(!JSON.stringify(disk).includes('token'), '缓存不包含会话或 GitCode 令牌');
        const restored = createOrgPrPageCache({ file });
        const result = await restored.get(options, false, async () => { throw new Error('不应请求'); });
        assert.equal(result.prs[0].number, 7);
    } finally { await rm(root, { recursive: true, force: true }); }
});
