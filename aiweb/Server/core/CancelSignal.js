/**
 * CancelSignal — 轻量级取消信号
 *
 * 职责：在任务取消时通知所有阻塞中的异步操作（Semaphore.acquire / PollingScheduler.waitForCompletion）立即退出。
 * 设计：单向广播，触发后不可恢复；与业务无关，可被任何需要取消语义的组件消费。
 *
 * @example
 * const signal = new CancelSignal();
 * // 取消时
 * signal.cancel();
 * // 检查时
 * if (signal.cancelled) { ... }
 * // 在 acquire / waitForCompletion 中传入
 * await semaphore.acquire({ signal });
 */

export class CancelSignal {
    constructor() {
        /** @private */
        this._cancelled = false;
        /** @private @type {Array<{ resolve: Function }>} */
        this._waiters = [];
    }

    /** @returns {boolean} 是否已取消 */
    get cancelled() {
        return this._cancelled;
    }

    /**
     * 触发取消信号
     *
     * 唤醒所有通过 wait() 等待的调用者，之后 cancelled 永远为 true。
     * 多次调用是安全的（幂等）。
     */
    cancel() {
        if (this._cancelled) return;
        this._cancelled = true;
        for (const waiter of this._waiters) {
            waiter.resolve();
        }
        this._waiters = [];
    }

    /**
     * 等待取消信号触发（非阻塞）
     *
     * 如果已取消，立即 resolve；否则返回一个在 cancel() 时 resolve 的 Promise。
     * 典型用途：与 Promise.race 配合，让阻塞操作可中断。
     *
     * @returns {Promise<void>}
     */
    wait() {
        if (this._cancelled) return Promise.resolve();
        return new Promise((resolve) => {
            this._waiters.push({ resolve });
        });
    }

    /**
     * 如果已取消则抛出异常
     *
     * 在 workflow 的关键节点调用，实现「快速失败」。
     *
     * @param {string} [taskId] - 任务 ID，用于错误上下文
     * @throws {CancelError}
     */
    throwIfCancelled(taskId) {
        if (this._cancelled) {
            throw new CancelError(taskId);
        }
    }
}

/**
 * CancelError — 取消导致的异常
 *
 * 与 StageError 不同，CancelError 表示主动取消而非业务失败。
 * workflow catch 块应忽略此错误（因为 _transition 已在 cancel 方法中完成）。
 */
export class CancelError extends Error {
    /**
     * @param {string} [taskId]
     */
    constructor(taskId) {
        const message = taskId
            ? `任务 ${taskId} 已被取消`
            : '操作已被取消';
        super(message);
        this.name = 'CancelError';
        this.code = 'cancelled';
        this.taskId = taskId;
    }
}

export default CancelSignal;
