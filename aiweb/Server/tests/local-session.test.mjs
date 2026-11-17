import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLocalAdminSession, readLocalAdminUserByToken } from '../library/localSession.js';

async function fixture(t) {
    const home = await mkdtemp(join(tmpdir(), 'ace-local-session-'));
    await mkdir(join(home, 'data'));
    const admin = { id: 'admin-test', username: 'local-admin', role: 'admin', status: 'active' };
    await writeFile(join(home, 'data', 'users.json'), JSON.stringify([admin]));
    const previousHome = process.env.ACE_HOME;
    const previousDeployment = process.env.AIWEB_DEPLOYMENT;
    process.env.ACE_HOME = home;
    process.env.AIWEB_DEPLOYMENT = 'personal';
    t.after(async () => {
        if (previousHome === undefined) delete process.env.ACE_HOME; else process.env.ACE_HOME = previousHome;
        if (previousDeployment === undefined) delete process.env.AIWEB_DEPLOYMENT; else process.env.AIWEB_DEPLOYMENT = previousDeployment;
        await rm(home, { recursive: true, force: true });
    });
    return { home, admin };
}

test('本机令牌过期：无需密码补发，并合并并发恢复', async t => {
    const { home, admin } = await fixture(t);
    await writeFile(join(home, 'data', 'tokens.json'), JSON.stringify([
        ['expired-secret', { userId: admin.id, expiry: Date.now() - 1000 }],
    ]));
    let calls = 0;
    const verify = async token => {
        calls++;
        const tokens = JSON.parse(await readFile(join(home, 'data', 'tokens.json'), 'utf8'));
        return tokens.some(([value, info]) => value === token && info.userId === admin.id && info.expiry > Date.now()) ? admin : null;
    };
    const [first, second] = await Promise.all([
        resolveLocalAdminSession(verify), resolveLocalAdminSession(verify),
    ]);
    assert.equal(first.token, second.token);
    assert.notEqual(first.token, 'expired-secret');
    assert.equal(first.user.username, 'local-admin');
    assert.equal(calls, 1);
    const tokens = JSON.parse(await readFile(join(home, 'data', 'tokens.json'), 'utf8'));
    assert.equal(tokens.length, 1, '过期令牌不再保留');
});

test('已有本机会话直接复用；ACE 拒绝时不签发新令牌', async t => {
    const { home, admin } = await fixture(t);
    await writeFile(join(home, 'data', 'tokens.json'), JSON.stringify([
        ['valid-local', { userId: admin.id, expiry: Date.now() + 10000 }],
    ]));
    const session = await resolveLocalAdminSession(async () => admin);
    assert.equal(session.token, 'valid-local');
    await writeFile(join(home, 'data', 'tokens.json'), '[]');
    await assert.rejects(resolveLocalAdminSession(async () => null), /ACE_HOME/);
    assert.deepEqual(JSON.parse(await readFile(join(home, 'data', 'tokens.json'), 'utf8')), []);
});

test('本机有效令牌直接校验，不重复请求 ACE；过期或其他用户不冒充管理员', async t => {
    const { home, admin } = await fixture(t);
    const other = { id: 'other-user', username: 'other', role: 'user', status: 'active' };
    await writeFile(join(home, 'data', 'users.json'), JSON.stringify([admin, other]));
    await writeFile(join(home, 'data', 'tokens.json'), JSON.stringify([
        ['valid-local', { userId: admin.id, expiry: Date.now() + 10000 }],
        ['expired-local', { userId: admin.id, expiry: Date.now() - 1000 }],
        ['ordinary-user', { userId: other.id, expiry: Date.now() + 10000 }],
    ]));
    assert.equal(readLocalAdminUserByToken('valid-local').username, admin.username);
    assert.equal(readLocalAdminUserByToken('expired-local'), null);
    assert.equal(readLocalAdminUserByToken('ordinary-user'), null);
    process.env.AIWEB_DEPLOYMENT = 'public';
    assert.equal(readLocalAdminUserByToken('valid-local'), null);
});

test('非个人部署禁止取得本机管理员会话', async t => {    await fixture(t);
    process.env.AIWEB_DEPLOYMENT = 'public';
    await assert.rejects(resolveLocalAdminSession(async () => { throw new Error('不应校验令牌'); }), /需要登录/);
});
