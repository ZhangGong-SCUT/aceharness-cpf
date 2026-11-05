/**
 * F09：诊断链指标（纯函数，便于用 mock 任务验证口径）。
 *
 * 历史问题：Issue 队列展示的是另一套调度对象（PortingOrchestrator 信号量），
 * 一个 issueanalysis_analyzing 任务在队列面板显示 running=0/queued=0。
 * 这里按任务记录本身统计，与调度实现解耦。
 */

import { TERMINAL_STAGES } from '../orchestrator/stages.js';

/**
 * @param {Array<{stage?: string, updatedAt?: string, metadata?: any}>} tasks 任务记录列表
 * @param {string} [now] ISO 时间（注入便于测试）
 */
export function computeChainMetrics(tasks, now = new Date().toISOString()) {
    const list = Array.isArray(tasks) ? tasks : [];
    const byStage = {};
    let active = 0;
    let terminal = 0;
    let queryDegraded = 0;
    for (const task of list) {
        const stage = task?.stage || 'unknown';
        byStage[stage] = (byStage[stage] || 0) + 1;
        if (TERMINAL_STAGES.has(stage)) terminal += 1;
        else active += 1;
        let metadata = task?.metadata;
        if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = {}; } }
        const health = metadata?.queryHealth;
        if (!TERMINAL_STAGES.has(stage) && health?.error) queryDegraded += 1;
    }
    return {
        total: list.length,
        active,
        terminal,
        byStage,
        queryDegraded,
        computedAt: now,
    };
}
