/**
 * PollingScheduler — 自适应 CLI Session 轮询器
 *
 * 职责：等待一个 CLI Session 从"运行中"变为终态（completed/failed/error）。
 * 优化：初始间隔短（2s），随时间指数增长到上限（12s），大幅降低资源占用。
 * 取消：支持传入 CancelSignal，每次轮询迭代检查取消状态，实现快速退出。
 *
 * @example
 * await PollingScheduler.waitForCompletion(cli, sessionId, {
 *     timeoutMs: 900000,  // 15 分钟超时
 *     signal,             // CancelSignal，取消时立即退出
 * });
 */

import config from '../library/config.js';
import { createLogger } from '../library/logger.js';
import { StageError, delay } from '../library/utils.js';
import { CancelError } from './CancelSignal.js';

const logger = createLogger('PollingScheduler');

export class PollingScheduler {
    /**
     * 自适应轮询等待 CLI Session 完成
     *
     * 轮询策略：
     *   - 初始间隔：config.polling.initialIntervalMs（默认 2s）
     *   - 增长倍数：config.polling.growthFactor（默认 1.5）
     *   - 最大间隔：config.polling.maxIntervalMs（默认 12s）
     *
     * 轮询节奏示例（growthFactor=1.5，max=12s）：
     *   2s → 3s → 4.5s → 6.75s → 10.125s → 12s → 12s → ...
     *   相比固定 2s 轮询，长任务期间节省约 83% 的轮询次数。
     *
     * @param {import('../cli/cli.js').default} cli  - CLIController 实例
     * @param {string}   sessionId                   - 等待完成的 Session ID
     * @param {object}   options
     * @param {number}   options.timeoutMs           - 超时时间（ms）
     * @param {import('./CancelSignal.js').CancelSignal} [options.signal] - 取消信号
     * @returns {Promise<'completed'>}
     * @throws {CancelError} signal 触发时抛出
     * @throws {StageError} code='timeout'   超时时抛出
     * @throws {StageError} code=<status>    Session 以非 completed 状态结束时抛出
     */
    static async waitForCompletion(cli, sessionId, { timeoutMs, signal } = {}) {
        const deadline   = Date.now() + timeoutMs;
        let lastStatus   = 'unknown';
        let lastResult   = null;
        let intervalMs   = config.polling.initialIntervalMs;
        const maxInterval = config.polling.maxIntervalMs;
        const growthFactor = config.polling.growthFactor;

        logger.debug('开始轮询 Session', { sessionId, timeoutMs });

        while (Date.now() < deadline) {
            // ── 检查取消信号 ──────────────────────────────────────────────
            if (signal?.cancelled) {
                throw new CancelError();
            }

            lastResult = await cli.checkSessionStatus(sessionId);
            lastStatus = lastResult.status;

            // 任何非进行中状态均视为终态，立即退出循环
            if (lastStatus !== 'running' && lastStatus !== 'unknown') {
                if (lastStatus !== 'completed') {
                    throw new StageError(
                        lastStatus,
                        `Session ${sessionId} 以状态 "${lastStatus}" 终止` +
                        (lastResult.error ? `：${lastResult.error.name}` : '')
                    );
                }
                logger.debug('Session 轮询完成', { sessionId, status: lastStatus });
                return 'completed';
            }

            // 使用 Promise.race 让 delay 可被取消信号中断
            if (signal) {
                await Promise.race([
                    delay(intervalMs),
                    signal.wait(),
                ]);
                // 如果是信号唤醒的（而非 delay 到期），下一轮循环会因 cancelled 检查抛出
            } else {
                await delay(intervalMs);
            }

            // 指数增长，不超过最大值
            intervalMs = Math.min(intervalMs * growthFactor, maxInterval);
        }

        throw new StageError(
            'timeout',
            `Session ${sessionId} 等待超时（${timeoutMs / 1000}s），最后状态：${lastStatus}`
        );
    }
}

export default PollingScheduler;
