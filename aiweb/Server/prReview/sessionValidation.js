import { createHash } from 'node:crypto';

/**
 * 短期会话验证缓存：只缓存哈希后的键和上游确认的用户，不保存原始令牌。
 * 同一页面的并发请求共用一次验证；无效令牌不缓存，便于用户立即重新登录。
 */
export function createSessionValidationCache({ ttlMs = 15000, limit = 100 } = {}) {
    const valid = new Map();
    const pending = new Map();
    const keyOf = (token) => createHash('sha256').update(token).digest('hex');

    return async function validate(token, verify) {
        if (typeof token !== 'string' || !token) return null;
        const key = keyOf(token);
        const now = Date.now();
        const cached = valid.get(key);
        if (cached && cached.expiresAt > now) return cached.user;
        if (cached) valid.delete(key);
        if (pending.has(key)) return pending.get(key);
        const request = Promise.resolve().then(() => verify(token)).then(user => {
            if (user?.username) {
                valid.delete(key);
                valid.set(key, { user, expiresAt: Date.now() + ttlMs });
                while (valid.size > limit) valid.delete(valid.keys().next().value);
            }
            return user || null;
        }).finally(() => pending.delete(key));
        pending.set(key, request);
        return request;
    };
}
