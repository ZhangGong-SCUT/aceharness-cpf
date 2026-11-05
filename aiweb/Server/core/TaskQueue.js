/**
 * TaskQueue — 通用任务并发队列
 *
 * 职责：限制并发任务数量，超出时排队等待，完成后自动触发下一个任务。
 * 设计：与业务无关的纯队列控制器，可被 PortingService、CodeCheckService、
 *       LibraryCheckService 各自实例化，互不干扰。
 *
 * @example
 * const queue = new TaskQueue({ maxConcurrent: 5, queueSize: 20 });
 * const { queued, position } = queue.enqueue(task, cli, skillExecutor);
 * // ...任务完成后
 * queue.release(taskId, runWorkflow);
 */

import config from '../library/config.js';
import { createLogger } from '../library/logger.js';
import { StageError } from '../library/utils.js';

const logger = createLogger('TaskQueue');

export class TaskQueue {
    /**
     * @param {object} [options]
     * @param {number} [options.maxConcurrent] - 最大并发任务数（默认读取 config）
     * @param {number} [options.queueSize]     - 队列容量上限（默认读取 config）
     * @param {string} [options.name]          - 队列名称，用于日志区分
     */
    constructor({
        maxConcurrent = config.maxConcurrentTasks,
        queueSize     = config.taskQueueSize,
        name          = 'default',
    } = {}) {
        this._maxConcurrent = maxConcurrent;
        this._queueSize     = queueSize;
        this._name          = name;
        /** @type {Array<{task: object, cli: object, skillExecutor: object}>} */
        this._queue         = [];
        this._runningCount  = 0;
    }

    // ─── 状态查询 ──────────────────────────────────────────────────────────────

    /**
     * 获取当前队列状态快照
     * @returns {{ queued: number, running: number, capacity: number, maxConcurrent: number }}
     */
    getStatus() {
        return {
            queued:        this._queue.length,
            running:       this._runningCount,
            capacity:      this._queueSize,
            maxConcurrent: this._maxConcurrent,
        };
    }

    /** @returns {boolean} 是否可立即执行（运行中数量未达上限） */
    canExecuteImmediately() {
        return this._runningCount < this._maxConcurrent;
    }

    /** @returns {boolean} 队列是否已满（等待区容量已满） */
    isFull() {
        return this._queue.length >= this._queueSize;
    }

    // ─── 队列操作 ──────────────────────────────────────────────────────────────

    /**
     * 尝试将任务加入执行或等待队列
     *
     * @param {object} task           - 任务记录对象（需含 taskId）
     * @param {object} cli            - CLIController 实例
     * @param {object} skillExecutor  - SkillExecutor 实例
     * @returns {{ queued: boolean, position: number }}
     *          queued=false 表示立即执行；queued=true 表示已加入等待队列
     * @throws {StageError} code='queue_full' 当队列已满时
     */
    enqueue(task, cli, skillExecutor) {
        if (this.isFull()) {
            throw new StageError(
                'queue_full',
                `[${this._name}] 任务队列已满（容量 ${this._queueSize}），请稍后重试`
            );
        }

        if (this.canExecuteImmediately()) {
            this._runningCount++;
            return { queued: false, position: 0 };
        }

        // 加入等待区
        this._queue.push({ task, cli, skillExecutor });
        const position = this._queue.length;
        logger.info('任务加入队列等待', {
            queue:       this._name,
            taskId:      task.taskId,
            position,
            queueLength: this._queue.length,
        });
        return { queued: true, position };
    }

    /**
     * 任务完成后释放槽位，自动触发等待队列中的下一个任务
     *
     * @param {string}   taskId      - 完成的任务 ID（仅用于日志）
     * @param {Function} runWorkflow - 工作流执行函数，签名：(task, cli, skillExecutor) => void
     */
    release(taskId, runWorkflow) {
        this._runningCount--;
        logger.debug('任务槽位已释放', {
            queue:        this._name,
            taskId,
            runningCount: this._runningCount,
            queueLength:  this._queue.length,
        });

        if (this._queue.length > 0) {
            const next = this._queue.shift();
            this._runningCount++;
            logger.info('触发队列中的下一个任务', {
                queue:        this._name,
                taskId:       next.task.taskId,
                runningCount: this._runningCount,
            });
            runWorkflow(next.task, next.cli, next.skillExecutor);
        }
    }

    /**
     * 从等待队列中移除指定任务（用于取消排队中的任务）
     *
     * 仅移除还在等待区（_queue）中的任务，不影响正在执行的任务。
     * 如果任务已开始执行（不在 _queue 中），则不做任何操作。
     *
     * @param {string} taskId - 要移除的任务 ID
     * @returns {boolean} 是否成功移除（true = 从等待区移除，false = 不在等待区）
     */
    remove(taskId) {
        const idx = this._queue.findIndex(item => item.task.taskId === taskId);
        if (idx === -1) return false;

        this._queue.splice(idx, 1);
        logger.info('任务已从等待队列中移除', {
            queue:       this._name,
            taskId,
            queueLength: this._queue.length,
        });
        return true;
    }
}

export default TaskQueue;
