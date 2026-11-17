import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 读取本机 PR 摘要。缺摘要或无法确认归属时返回 null，由调用方回退 ACE 接口。 */
export async function listLocalPrRuns({ user, runsRoot, configFile, page = 1, pageSize = 50, enrich }) {
    if (!user?.id || !['admin', 'user'].includes(user.role)) throw new Error('登录已过期，请重新登录');
    const entries = await readdir(runsRoot, { withFileTypes: true });
    const candidates = entries.filter(entry => entry.isDirectory() && /^run-[A-Za-z0-9-]+-pr\d+-[A-Za-z0-9]+$/.test(entry.name));
    const summaries = await Promise.all(candidates.map(async entry => {
        try {
            const value = JSON.parse(await readFile(join(runsRoot, entry.name, 'summary.json'), 'utf8'));
            return { directory: entry.name, value };
        } catch {
            return { directory: entry.name, value: null };
        }
    }));
    // 不能确认旧摘要的归属时，不猜测、不暴露；交给 ACE 做原有归属校验。
    if (summaries.some(item => !item.value || item.value.runId !== item.directory
        || (user.role !== 'admin' && !item.value.ownerId))) return null;
    const runs = summaries.filter(item => item.value.configFile === configFile
        && (user.role === 'admin' || item.value.ownerId === user.id))
        .map(item => enrich(item.value))
        .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    // 保留原有「仓库 + PR 编号只展示最新任务」语义。
    const byPr = new Map();
    const deduped = [];
    for (const run of runs) {
        const key = `${run.repo || '?'}/${run.prNumber}`;
        if (!run.prNumber || !byPr.has(key)) {
            if (run.prNumber) byPr.set(key, run);
            deduped.push(run);
        }
    }
    const total = deduped.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    return {
        runs: deduped.slice((safePage - 1) * pageSize, safePage * pageSize),
        total, page: safePage, totalPages,
    };
}

/** 单个详情只读对应摘要，避免为了归属校验重新扫描全部历史。 */
export async function findLocalPrRun({ user, runsRoot, configFile, runId }) {
    if (!user?.id || !['admin', 'user'].includes(user.role)) throw new Error('登录已过期，请重新登录');
    if (!/^run-[A-Za-z0-9-]+$/.test(String(runId || ''))) return null;
    try {
        const summary = JSON.parse(await readFile(join(runsRoot, runId, 'summary.json'), 'utf8'));
        if (summary.runId !== runId) return undefined;
        // 老摘要没有归属时不能用于普通用户鉴权，交由 ACE 在线接口确认。
        if (user.role !== 'admin' && !summary.ownerId) return undefined;
        if (summary.configFile !== configFile
            || (user.role !== 'admin' && summary.ownerId !== user.id)) return null;
        return { runId, status: summary.status, currentPhase: summary.currentPhase };
    } catch {
        // 预校验失败或摘要尚未生成时保留在线回退；不能把文件缺失当成无权访问。
        return undefined;
    }
}
