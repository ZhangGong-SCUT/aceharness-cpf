/**
 * Semaphore — 全局并发信号量
 *
 * 职责：限制同一时刻并发执行的 OpenCode Session 数量，保护服务端不过载。
 * 设计：Promise-based，acquire 返回 Promise，release 唤醒等待者。
 *       acquire 支持传入 CancelSignal，实现可中断的等待。
 *
 * @example
 * const sem = new Semaphore(10);  // 最多 10 个并发
 * const signal = new CancelSignal();
 * await sem.acquire({ signal });
 * try {
 *     const { sessionId } = await skillExecutor.invokeSkill(...);
 *     await PollingScheduler.waitForCompletion(cli, sessionId, { ... });
 * } finally {
 *     sem.release();
 * }
 */

import { createLogger } from '../library/logger.js';
import { CancelError } from './CancelSignal.js';

const logger = createLogger('Semaphore');

export class Semaphore {
    /**
     * @param {number} max - 最大并发数
     * @param {object} [options]
     * @param {string} [options.name='global'] - 信号量名称，用于日志区分
     * @param {number} [options.acquireTimeoutMs=0] - acquire() 超时时间（毫秒），0 表示不超时
     */
    constructor(max, { name = 'global', acquireTimeoutMs = 0 } = {}) {
        if (!Number.isInteger(max) || max < 1) {
            throw new RangeError(`Semaphore max must be a positive integer, got ${max}`);
        }
        this._max = max;
        this._name = name;
        this._acquireTimeoutMs = acquireTimeoutMs;
        this._current = 0;
        /** @type {Array<{ resolve: Function, reject: Function, timer?: ReturnType<typeof setTimeout> }>} */
        this._waitQueue = [];
    }

    // ─── 状态查询 ──────────────────────────────────────────────────────────────

    /**
     * 获取当前信号量状态快照
     * @returns {{ current: number, max: number, waiting: number }}
     */
    getStatus() {
        return {
            current: this._current,
            max:     this._max,
            waiting: this._waitQueue.length,
        };
    }

    /** @returns {number} 当前可用槽位数 */
    get available() {
        return this._max - this._current;
    }

    // ─── 获取/释放 ──────────────────────────────────────────────────────────────

    /**
     * 获取一个槽位（异步，可超时，可取消）
     *
     * 如果当前并发数未达上限，立即返回；
     * 否则进入等待队列，直到有槽位释放或超时或收到取消信号。
     *
     * @param {object} [options]
     * @param {number} [options.timeoutMs] - 本次 acquire 的超时时间（毫秒），
     *   0 表示不超时；未传则使用构造时的默认值
     * @param {import('./CancelSignal.js').CancelSignal} [options.signal] - 取消信号，
     *   触发时抛出 CancelError 中断等待
     * @returns {Promise<void>}
     * @throws {CancelError} signal 触发时抛出
     * @throws {SemaphoreTimeoutError} 超时时抛出
     */
    async acquire({ timeoutMs, signal } = {}) {
        // 检查取消信号（快速失败）
        if (signal?.cancelled) {
            throw new CancelError();
        }

        const effectiveTimeout = timeoutMs ?? this._acquireTimeoutMs;

        if (this._current < this._max) {
            this._current++;
            logger.debug('信号量槽位已获取', {
                name:     this._name,
                current:  this._current,
                max:      this._max,
                waiting:  this._waitQueue.length,
            });
            return;
        }

        // 排队等待（支持超时 + 取消信号）
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null, signalCleanup: null };

            // ── 取消信号监听 ──────────────────────────────────────────────
            if (signal) {
                const onCancel = () => {
                    // 从等待队列中移除自身
                    const idx = this._waitQueue.indexOf(waiter);
                    if (idx !== -1) {
                        this._waitQueue.splice(idx, 1);
                    }
                    // 清除超时定时器
                    if (waiter.timer) {
                        clearTimeout(waiter.timer);
                    }
                    logger.info('信号量获取被取消信号中断', {
                        name: this._name,
                        current: this._current,
                        max: this._max,
                    });
                    reject(new CancelError());
                };
                // 利用 CancelSignal.wait() 监听取消
                signal.wait().then(onCancel);
            }

            // ── 超时定时器 ────────────────────────────────────────────────
            if (effectiveTimeout > 0) {
                waiter.timer = setTimeout(() => {
                    // 从等待队列中移除自身
                    const idx = this._waitQueue.indexOf(waiter);
                    if (idx !== -1) {
                        this._waitQueue.splice(idx, 1);
                    }
                    const err = new SemaphoreTimeoutError(
                        `Semaphore[${this._name}] acquire timed out after ${effectiveTimeout}ms`,
                        { name: this._name, timeout: effectiveTimeout, waiting: this._waitQueue.length }
                    );
                    logger.warn('信号量获取超时', {
                        name: this._name,
                        timeout: effectiveTimeout,
                        current: this._current,
                        max: this._max,
                        waiting: this._waitQueue.length,
                    });
                    reject(err);
                }, effectiveTimeout);
            }

            this._waitQueue.push(waiter);
            logger.info('信号量已满，进入等待队列', {
                name:     this._name,
                current:  this._current,
                max:      this._max,
                waiting:  this._waitQueue.length,
                timeout:  effectiveTimeout > 0 ? effectiveTimeout : 'none',
            });
        });
    }

    /**
     * 释放一个槽位
     *
     * 如果有等待者，唤醒第一个；否则直接减少计数。
     */
    release() {
        if (this._waitQueue.length > 0) {
            const waiter = this._waitQueue.shift();
            // 清除超时定时器（如果有的话）
            if (waiter.timer) {
                clearTimeout(waiter.timer);
            }
            // 不减少 _current，因为被唤醒者会占用该槽位
            logger.info('信号量槽位释放，唤醒等待者', {
                name:     this._name,
                current:  this._current,
                max:      this._max,
                waiting:  this._waitQueue.length,
            });
            waiter.resolve();
        } else {
            this._current--;
            logger.debug('信号量槽位已释放', {
                name:     this._name,
                current:  this._current,
                max:      this._max,
                waiting:  this._waitQueue.length,
            });
        }
    }
}

/**
 * 信号量获取超时错误
 *
 * 当 acquire() 等待超过指定时间仍无法获取槽位时抛出。
 */
export class SemaphoreTimeoutError extends Error {
    /**
     * @param {string} message - 错误描述
     * @param {object} [context] - 附加上下文
     * @param {string} [context.name] - 信号量名称
     * @param {number} [context.timeout] - 超时时长(ms)
     * @param {number} [context.waiting] - 超时时队列中剩余等待者数量
     */
    constructor(message, context = {}) {
        super(message);
        this.name = 'SemaphoreTimeoutError';
        this.context = context;
    }
}

export default Semaphore;
