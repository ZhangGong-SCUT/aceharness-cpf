import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionValidationCache } from '../prReview/sessionValidation.js';

test('会话验证短期复用并合并并发，不保存原始 token', async () => {
    let calls = 0;
    let release;
    const validate = createSessionValidationCache();
    const verify = token => {
        calls++;
        if (token !== 'valid') return Promise.resolve(null);
        return new Promise(resolve => {
            release = () => resolve({ username: 'tester', role: 'user' });
        });
    };
    const pending = Promise.all([validate('valid', verify), validate('valid', verify)]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await pending, [{ username: 'tester', role: 'user' }, { username: 'tester', role: 'user' }]);
    assert.equal((await validate('valid', verify)).username, 'tester');
    assert.equal(calls, 1);
    assert.equal(await validate('invalid', verify), null);
    assert.equal(await validate('invalid', verify), null);
    assert.equal(calls, 3, '无效 token 不缓存，不将旧身份返回给新凭证');
    assert.equal(await validate('', verify), null);
    assert.equal(calls, 3);
});

test('缓存过期后重新向上游验证，用户禁用不会被长期掩盖', async () => {
    let calls = 0;
    const validate = createSessionValidationCache({ ttlMs: 10 });
    const verify = async () => ++calls === 1 ? { username: 'tester' } : null;
    assert.equal((await validate('token', verify)).username, 'tester');
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(await validate('token', verify), null);
    assert.equal(calls, 2);
});
