import { STAGE, TERMINAL_STAGES } from '../orchestrator/stages.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'crashed', 'stopped']);

/**
 * 终态详情的展示快照，不参与运行状态判定。
 * 恢复任务必须先显式失效同一 run 的快照，运行中的查询不得复用旧终态。
 */
export function createTerminalStatusCache(limit = 50) {
    const snapshots = new Map();

    return {
        get(task, runId) {
            if (!TERMINAL_STAGES.has(task?.stage) || !runId) return null;
            const cached = snapshots.get(task.taskId);
            if (!cached || cached.runId !== runId) return null;
            return { ...cached.status };
        },

        put(task, runId, status) {
            if (!TERMINAL_RUN_STATUSES.has(status?.status) || status.runId !== runId) return;
            const taskId = task?.taskId;
            if (!taskId || task.stage === STAGE.ISSUEANALYSIS_ANALYZING
                || task.stage === STAGE.ISSUEANALYSIS_FETCHING
                || task.stage === STAGE.ISSUEANALYSIS_PENDING) return;
            snapshots.delete(taskId);
            snapshots.set(taskId, { runId, status: { ...status } });
            while (snapshots.size > limit) snapshots.delete(snapshots.keys().next().value);
        },

        invalidate(taskId) {
            snapshots.delete(taskId);
        },
    };
}
