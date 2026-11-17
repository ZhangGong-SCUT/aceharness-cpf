import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 分页 PR 展示缓存：正常 TTL 60s，异常时可使用最近成功快照，绝不用于鉴权。 */
export function createOrgPrPageCache({ file, ttlMs = 60000, staleMs = 86400000, limit = 100, now = () => Date.now() } = {}) {
    const cached = new Map();
    const pending = new Map();
    const updated = new Map();
    let save = Promise.resolve();
    let loaded = false;

    const normalize = options => ({
        org: String(options.org || 'CPF-Flutter'), repo: String(options.repo || '').toLowerCase(),
        page: Number(options.page) || 1, perPage: Number(options.perPage) || 20,
        state: String(options.state || 'all'), search: String(options.search || ''),
        author: String(options.author || '').toLowerCase(),
    });
    const keyOf = options => JSON.stringify(normalize(options));
    async function load() {
        if (loaded || !file) return;
        loaded = true;
        try {
            const disk = JSON.parse(await readFile(file, 'utf8'));
            for (const [key, entry] of Object.entries(disk || {})) {
                if (entry?.at && Array.isArray(entry.data?.prs)) cached.set(key, entry);
            }
        } catch { /* 首次运行或旧缓存损坏不影响在线加载 */ }
    }
    function persist() {
        if (!file) return;
        const snapshot = JSON.stringify(Object.fromEntries(cached));
        save = save.then(() => mkdir(dirname(file), { recursive: true })
            .then(() => writeFile(`${file}.${process.pid}.tmp`, snapshot, { mode: 0o600 }))
            .then(() => rename(`${file}.${process.pid}.tmp`, file)))
            .catch(() => {});
        return save;
    }
    return {
        async get(options, fresh, read) {
            await load();
            const normalized = normalize(options);
            const key = keyOf(normalized);
            const hit = cached.get(key);
            const age = hit ? now() - hit.at : Infinity;
            if (!fresh && hit && age < ttlMs) return hit.data;
            if (!fresh && hit && age < staleMs && pending.has(key)) return { ...hit.data, stale: true };
            if (pending.has(key)) return pending.get(key);
            if (fresh && now() - (updated.get(key) || 0) < 2000 && hit) return { ...hit.data, stale: true };
            if (fresh) updated.set(key, now());
            const task = Promise.resolve().then(() => read(normalized)).then(data => {
                cached.delete(key);
                cached.set(key, { at: now(), data });
                while (cached.size > limit) cached.delete(cached.keys().next().value);
                void persist();
                return data;
            }).finally(() => pending.delete(key));
            pending.set(key, task);
            if (!fresh && hit && age < staleMs) {
                void task.catch(() => {});
                return { ...hit.data, stale: true };
            }
            return task;
        },
    };
}
