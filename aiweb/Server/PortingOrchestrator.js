/**
 * PortingOrchestrator — 编排器（Issue 分析专用精简版）
 *
 * 重构说明：
 *   原先所有工作流方法集中在一个文件（~3800行），现已按功能拆分为 Mixin 模块。
 *   本系统已精简为仅保留 Issue 分析模块（由 AceHarness 代理实现，不经过本编排器），
 *   编排器仅保留：构造函数、close()、取消信号管理、通用状态查询、_transition、_performCancel
 *   以及健康检查（供 /api/alive 使用）。
 */

import CLIController from './cli/cli.js';
import sseEmitter from './send/index.js';
import config from './library/config.js';
import { Semaphore } from './core/Semaphore.js';
import { CancelSignal } from './core/CancelSignal.js';
import { createLogger } from './library/logger.js';
import { HybridTaskStore } from './library/HybridTaskStore.js';
import { TaskQueue } from './core/TaskQueue.js';

// 状态常量（从子模块 re-export，保持向后兼容）
import { STAGE, TERMINAL_STAGES } from './orchestrator/stages.js';

const logger = createLogger('PortingOrchestrator');

// ─── PortingOrchestrator ───────────────────────────────────────────────────────

export class PortingOrchestrator {
    /**
     * @param {string} [cliType='opencode'] - 默认使用 opencode
     */
    constructor(cliType = 'opencode') {
        // Issue 分析任务使用独立的 issueanalysis.db（由 issueAnalysis/service.js 管理）
        this._store = new HybridTaskStore('issueanalysis.db');
        this._store.initialize();

        // CLI 控制器：根据 cliType 选择适配器
        this._cli = new CLIController(cliType, {
            host: config.opencode.host,
            port: config.opencode.port,
        });

        /** @type {Map<string, CLIController>} taskId → 该任务使用的 CLI 实例 */
        this._taskClis = new Map();

        /** @type {Map<string, CancelSignal>} taskId → 该任务的取消信号 */
        this._cancelSignals = new Map();

        // ─── 并发控制 ─────────────────────────────────────────────────────────
        this._taskQueue = new TaskQueue({
            maxConcurrent: config.maxConcurrentTasks,
            queueSize:     config.taskQueueSize,
            name:          'issueanalysis',
        });

        // ─── 全局 Session 并发信号量 ──────────────────────────────────────────────
        // 所有任务类型共享，保护 OpenCode 服务端不过载
        this._sessionSemaphore = new Semaphore(config.maxConcurrentSessions, {
            name: 'opencode-session',
            acquireTimeoutMs: config.semaphoreAcquireTimeoutMs,
        });

        logger.info('PortingOrchestrator 初始化完成', {
            cliType,
            maxConcurrentTasks: config.maxConcurrentTasks,
            taskQueueSize: config.taskQueueSize,
        });
    }

    /**
     * 关闭所有存储连接（优雅关闭时调用）
     */
    close() {
        this._store.close();
        logger.info('PortingOrchestrator 已关闭所有存储连接');
    }

    // ─── 取消信号管理（内部） ─────────────────────────────────────────────────

    /**
     * 获取或创建任务的取消信号
     *
     * 每个任务在入队时创建信号，在 finally 中清理。
     * 首次调用自动创建，后续调用复用同一实例。
     *
     * @param {string} taskId
     * @returns {CancelSignal}
     * @private
     */
    _getOrCreateCancelSignal(taskId) {
        let signal = this._cancelSignals.get(taskId);
        if (!signal) {
            signal = new CancelSignal();
            this._cancelSignals.set(taskId, signal);
        }
        return signal;
    }

    /**
     * 释放任务的取消信号（workflow 结束时调用）
     *
     * @param {string} taskId
     * @private
     */
    _disposeCancelSignal(taskId) {
        this._cancelSignals.delete(taskId);
    }

    /**
     * 执行取消操作的通用逻辑
     *
     * 高内聚：所有 cancel* 方法共用此方法，避免重复代码。
     * 职责：触发信号 → 从队列移除 → 标记状态 → abort Session → 清理资源。
     *
     * @param {string} taskId
     * @param {import('./library/HybridTaskStore.js').HybridTaskStore} store
     * @param {TaskQueue} queue
     * @param {string[]} sessionIds - 要 abort 的 Session ID 列表
     * @param {object} loggerInstance - 对应的 logger 实例
     * @param {string} label - 日志标签
     * @returns {boolean}
     * @private
     */
    _performCancel(taskId, store, queue, sessionIds, loggerInstance, label) {
        const task = store.get(taskId);
        if (!task) return false;
        if (TERMINAL_STAGES.has(task.stage)) return false;

        // 1. 触发取消信号 → 唤醒所有阻塞中的 acquire / waitForCompletion
        const signal = this._cancelSignals.get(taskId);
        if (signal) {
            signal.cancel();
        }

        // 2. 从等待队列中移除（如果任务还在排队未执行）
        const removed = queue.remove(taskId);
        if (removed) {
            // 排队中的任务被移除，不需要 release（_runningCount 没增加）
            loggerInstance.info(`${label}任务从等待队列中移除`, { taskId });
        }

        // 3. 标记状态
        this._transition(task, STAGE.CANCELLED, { cancelledAt: new Date().toISOString() }, store);

        // 4. 异步 abort 所有关联的 CLI Session
        const cli = this._taskClis.get(taskId);
        if (cli && sessionIds.length > 0) {
            Promise.allSettled(sessionIds.map(sid => cli.abortSession(sid)))
                .then(results => {
                    results.forEach((r, i) => {
                        if (r.status === 'rejected') {
                            loggerInstance.warn(`${label} Session abort 失败`, {
                                taskId,
                                sessionId: sessionIds[i],
                                error: r.reason?.message,
                            });
                        }
                    });
                    loggerInstance.info(`${label} Session 已中止`, { taskId, count: sessionIds.length });
                });
        }

        // 5. 清理
        setTimeout(() => sseEmitter.close(taskId), 1000);
        loggerInstance.info(`${label}任务已取消`, { taskId });
        return true;
    }

    // ─── 通用状态查询 ─────────────────────────────────────────────────────────

    /**
     * 获取队列状态
     * @returns {{ queued: number, running: number, capacity: number, maxConcurrent: number }}
     */
    getQueueStatus() {
        return this._taskQueue.getStatus();
    }

    /**
     * 获取信号量状态
     * @returns {{ current: number, max: number, waiting: number, available: number }}
     */
    getSemaphoreStatus() {
        const status = this._sessionSemaphore.getStatus();
        return {
            ...status,
            available: this._sessionSemaphore.available,
        };
    }

    /**
     * 获取所有任务类型的队列状态
     *
     * @returns {Record<string, { queued: number, running: number, capacity: number, maxConcurrent: number }> & { semaphore: { current: number, max: number, waiting: number, available: number } }>}
     */
    getAllQueueStatuses() {
        return {
            issueanalysis:        this._taskQueue.getStatus(),
            semaphore:            this.getSemaphoreStatus(),
        };
    }

    /**
     * 查询单个任务状态
     * @param {string} taskId
     * @returns {TaskRecord|null}
     */
    getTaskStatus(taskId) {
        return this._store.get(taskId);
    }

    /**
     * 列出所有任务
     * @returns {TaskRecord[]}
     */
    listTasks() {
        return this._store.list();
    }

    /**
     * 检查 CLI 后端健康状态
     */
    async checkHealth() {
        return this._cli.checkHealth();
    }

    // ─── 内部通用方法 ─────────────────────────────────────────────────────────

    /**
     * 状态转换：更新 store + 推送 SSE 事件 + 同步内存引用
     *
     * @param {object} task       - 任务对象引用
     * @param {string} newStage   - 目标阶段
     * @param {object} [extra={}] - 附带更新的字段
     * @param {HybridTaskStore} [store=null] - 指定 store，默认 this._store
     * @private
     */
    _transition(task, newStage, extra = {}, store = null) {
        const activeStore = store ?? this._store;
        // 终态不允许被覆盖（防止取消后工作流异步写入覆盖 cancelled 状态）
        if (TERMINAL_STAGES.has(task.stage) && task.stage !== newStage) {
            logger.warn('忽略终态覆盖', { taskId: task.taskId, current: task.stage, requested: newStage });
            return;
        }
        const oldStage = task.stage || 'unknown';
        const safeNewStage = newStage || 'unknown';

        // ─── 自动记录时间戳 ───────────────────────────────────────────────────
        // 1. startedAt: 从 pending 类状态转换到第一个活跃状态时记录
        const isPendingStage = oldStage.includes('pending');
        const isNewStagePending = safeNewStage.includes('pending');
        if (isPendingStage && !isNewStagePending && !task.startedAt) {
            extra.startedAt = new Date().toISOString();
            logger.info('记录开始执行时间', { taskId: task.taskId, startedAt: extra.startedAt });
        }

        // 2. finishedAt: 进入终态时记录
        if (TERMINAL_STAGES.has(newStage) && !task.finishedAt) {
            extra.finishedAt = new Date().toISOString();
            logger.info('记录结束执行时间', { taskId: task.taskId, finishedAt: extra.finishedAt });
        }

        activeStore.patch(task.taskId, { stage: newStage, ...extra });
        // 读取更新后的 task 用于事件
        const updated = activeStore.get(task.taskId);

        logger.info('状态转换', { taskId: task.taskId, from: oldStage, to: newStage });

        sseEmitter.emit(task.taskId, 'status', {
            taskId: task.taskId,
            stage: newStage,
            prevStage: oldStage,
            ...extra,
        });

        // 同步更新传入引用（便于后续代码直接使用 task）
        Object.assign(task, updated);
    }
}

// ─── 导出 ───────────────────────────────────────────────────────────────────────
// 保持向后兼容：default export + named export STAGE

export { STAGE };
export default PortingOrchestrator;
