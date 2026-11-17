/**
 * 相同 run 的并发查看合并为一次扫描；终态任务直接复用，运行中最多每 3 秒扫描。
 * 扫描在 worker 中执行，避免目录、图片和日志读取阻塞 Express 的其他请求。
 */
export function createArtifactSummaryCache({ read, ttlMs = 3000, limit = 60, defer } = {}) {
    const cached = new Map();
    const pending = new Map();
    const schedule = defer || (fn => import('node:worker_threads').then(({ Worker }) => {
        const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
            import(workerData.modulePath).then(({ listRunArtifacts }) => {
                parentPort.postMessage({ value: listRunArtifacts(workerData.runId) });
            }).catch(error => { throw error; });`, { eval: true, workerData: { modulePath: new URL('./artifacts.js', import.meta.url).href, runId: fn } });
        return new Promise((resolve, reject) => {
            worker.once('message', message => resolve(message.value));
            worker.once('error', reject);
        }).finally(() => worker.terminate());
    }));
    return {
        get(runId, terminal = false) {
            if (!runId) return Promise.resolve({ images: [], logs: [], files: [], steps: [] });
            const hit = cached.get(runId);
            if (hit && (terminal || Date.now() - hit.at < ttlMs)) {
                cached.delete(runId);
                cached.set(runId, hit);
                return Promise.resolve(hit.value);
            }
            if (pending.has(runId)) return pending.get(runId);
            const task = Promise.resolve().then(() => schedule(runId))
                .then(value => {
                    cached.delete(runId);
                    cached.set(runId, { at: Date.now(), value });
                    while (cached.size > limit) cached.delete(cached.keys().next().value);
                    return value;
                })
                .finally(() => pending.delete(runId));
            pending.set(runId, task);
            return task;
        },
        invalidate(runId) {
            cached.delete(runId);
        },
    };
}

let defaultCache;

/** 展示与迭代对比复用同一 run 的目录摘要，文件读取仍单独执行安全校验。 */
export function listArtifactsCached(runId, terminal, read) {
    if (!defaultCache) defaultCache = createArtifactSummaryCache({ read });
    return defaultCache.get(runId, terminal);
}

export function invalidateArtifactSummary(runId) {
    defaultCache?.invalidate(runId);
}
