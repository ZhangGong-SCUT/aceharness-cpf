import { createHash } from 'node:crypto';

/** 同一用户、同一分页的短时读复用；不保留原始会话令牌。 */
export function createRecentQueryCache({ ttlMs = 3000, limit = 40 } = {}) {
    const cached = new Map();
    const pending = new Map();
    const keyOf = (token, ...parts) => createHash('sha256').update(token).update('\0').update(JSON.stringify(parts)).digest('hex');
    const tokenKey = token => createHash('sha256').update(token).digest('hex');

    return {
        async get(token, parts, read) {
            if (typeof token !== 'string' || !token) return read();
            const key = keyOf(token, ...parts);
            const hit = cached.get(key);
            if (hit && hit.expiresAt > Date.now()) return hit.value;
            if (hit) cached.delete(key);
            if (pending.has(key)) return pending.get(key);
            const ownerKey = tokenKey(token);
            const task = Promise.resolve().then(read).then(value => {
                cached.delete(key);
                cached.set(key, { value, ownerKey, expiresAt: Date.now() + ttlMs });
                while (cached.size > limit) cached.delete(cached.keys().next().value);
                return value;
            }).finally(() => pending.delete(key));
            pending.set(key, task);
            return task;
        },
        invalidate(token) {
            if (typeof token !== 'string' || !token) return;
            const ownerKey = tokenKey(token);
            for (const [key, value] of cached) if (value.ownerKey === ownerKey) cached.delete(key);
        },
    };
}
