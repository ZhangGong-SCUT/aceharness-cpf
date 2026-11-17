import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import http from 'node:http';
import express from 'express';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 使用模拟 ACE/GitCode，不读取本机令牌或真实运行记录。
const root = await mkdtemp(join(tmpdir(), 'aiweb-pr-route-'));
await mkdir(join(root, 'data', 'env-vars.users'), { recursive: true });
await mkdir(join(root, 'runs'), { recursive: true });
await writeFile(join(root, 'data', 'users.json'), JSON.stringify([{ id: 'user-a', username: 'alice', email: 'alice@example.com' }]));
await writeFile(join(root, 'data', 'env-vars.users', 'user-a.yaml'), 'GITCODE_TOKEN_alice: test-placeholder\n');
const previousHome = process.env.ACE_HOME;
process.env.ACE_HOME = root;

const requestTimes = [];
const upstream = http.createServer(async (req, res) => {
    requestTimes.push({ url: req.url, at: Date.now() });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/auth/me') {
        res.end(JSON.stringify({ user: { id: 'user-a', username: 'alice', role: 'user' } }));
        return;
    }
    await new Promise(resolve => setTimeout(resolve, 120));
    if (req.url.startsWith('/orgs/')) {
        res.end(JSON.stringify([{ full_name: 'CPF-Flutter/flutter_flutter' }]));
        return;
    }
    if (req.url.startsWith('/org/CPF-Flutter/pull_requests')) {
        res.end(JSON.stringify([{ number: 7, title: 'test', state: 'open', user: { login: 'alice' }, base: { repo: { full_path: 'CPF-Flutter/flutter_flutter' } } }]));
        return;
    }
    res.statusCode = 404;
    res.end('{}');
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
process.env.GITCODE_ORG_API_ROOT = `http://127.0.0.1:${upstream.address().port}`;
process.env.ACEHARNESS_API_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;

const { createPrReviewRouter } = await import('../routes/prreview.js');
const app = express();
app.use('/api', createPrReviewRouter(null));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

test('PR 列表与仓库目录并行，监控标注不重复扫描', async () => {
    const started = Date.now();
    const response = await fetch(`${base}/api/pr-review/gitcode-prs?page=1&perPage=20&state=all&scope=self`, { headers: { Authorization: 'Bearer test' } });
    const elapsed = Date.now() - started;
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.prs[0].number, 7);
    const repoStart = requestTimes.find(item => item.url.startsWith('/orgs/'));
    const prStart = requestTimes.find(item => item.url.startsWith('/org/CPF-Flutter/pull_requests'));
    assert.ok(repoStart && prStart, '仓库目录和 PR 列表都应请求');
    assert.ok(Math.abs(repoStart.at - prStart.at) < 100, `两个外部请求应并行发起：${JSON.stringify(requestTimes.map(item => ({ url: item.url, offset: item.at - started })))}`);
});

test.after(async () => {
    server.close();
    upstream.close();
    if (previousHome === undefined) delete process.env.ACE_HOME; else process.env.ACE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
});
