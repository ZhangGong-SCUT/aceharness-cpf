import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createIssueAnalysisRouter } from '../routes/issueanalysis.js';

const ISSUE_URL = 'https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2590';

async function withRouter(t, { remoteAddress = '127.0.0.1', getLocalSession, getUser } = {}) {
    const submissions = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true });
        next();
    });
    app.use('/api', createIssueAnalysisRouter(null, {
        getUser: getUser || (async token => token === 'valid'
            ? { id: 'user-valid', username: 'tester', role: 'user' } : null),
        getLocalSession: getLocalSession || (async () => ({
            token: 'local-test', user: { id: 'admin-local', username: 'local-admin', role: 'admin' },
        })),
        startTask: async options => {
            submissions.push(options);
            return { taskId: 'ia-auth-test', runId: 'run-auth-test', dirName: 'test', frontendSessionId: null };
        },
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        submissions,
        post: (body, headers = {}) => fetch(`${base}/api/issue-analysis`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
        }),
    };
}

test('本机个人部署：无登录凭证可以启动，任务归属本机管理员', async t => {
    const previous = process.env.AIWEB_DEPLOYMENT;
    process.env.AIWEB_DEPLOYMENT = 'personal';
    t.after(() => { if (previous === undefined) delete process.env.AIWEB_DEPLOYMENT; else process.env.AIWEB_DEPLOYMENT = previous; });
    const api = await withRouter(t);
    const response = await api.post({ issueUrl: ISSUE_URL });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).taskId, 'ia-auth-test');
    assert.equal(api.submissions.length, 1);
    assert.equal(api.submissions[0].ownerUsername, 'local-admin');
});

test('本机个人部署：过期凭证自动恢复，仍拒绝远程匿名请求', async t => {
    const previous = process.env.AIWEB_DEPLOYMENT;
    process.env.AIWEB_DEPLOYMENT = 'personal';
    t.after(() => { if (previous === undefined) delete process.env.AIWEB_DEPLOYMENT; else process.env.AIWEB_DEPLOYMENT = previous; });
    const local = await withRouter(t);
    assert.equal((await local.post({ issueUrl: ISSUE_URL }, { Authorization: 'Bearer expired' })).status, 202);
    const remote = await withRouter(t, { remoteAddress: '203.0.113.20' });
    const response = await remote.post({ issueUrl: ISSUE_URL });
    assert.equal(response.status, 401);
    assert.equal(remote.submissions.length, 0);
});

test('公网部署：本机地址也不能绕过登录，有效用户保持原行为', async t => {
    const previous = process.env.AIWEB_DEPLOYMENT;
    delete process.env.AIWEB_DEPLOYMENT;
    t.after(() => { if (previous !== undefined) process.env.AIWEB_DEPLOYMENT = previous; });
    const api = await withRouter(t, {
        getLocalSession: async () => { throw new Error('公网不应调用本机会话'); },
    });
    assert.equal((await api.post({ issueUrl: ISSUE_URL })).status, 401);
    const response = await api.post({ issueUrl: ISSUE_URL }, { Authorization: 'Bearer valid' });
    assert.equal(response.status, 202);
    assert.equal(api.submissions[0].ownerUsername, 'tester');
});
