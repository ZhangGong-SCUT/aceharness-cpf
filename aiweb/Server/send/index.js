/**
 * SSE 推送管理器（SSEEmitter）
 * 按 taskId 分组管理 Server-Sent Events 连接
 *
 * 改进点：
 * - 按用户限流（而非按任务），支持团队协作
 * - 僵尸连接自动清理（超时机制）
 * - 连接状态监控与统计
 * - 全局单心跳（替代 N 个 per-taskId 心跳，大幅减少定时器占用）
 *
 * - subscribe(taskId, res)           注册新的 SSE 客户端
 * - emit(taskId, eventType, data)    向 taskId 的所有客户端推送事件
 * - close(taskId)                    关闭 taskId 的所有连接
 * - subscriberCount(taskId)          返回当前订阅者数量
 */

import config from '../library/config.js';
import { createLogger } from '../library/logger.js';

const logger = createLogger('SSEEmitter');

export class SSEEmitter {
    constructor() {
        // Map<taskId, Set<express.Response>>
        this._subscribers = new Map();
        // Map<taskId, Set<{res, userId, createdAt, timeoutMs}>>
        this._connectionMetadata = new Map();
        // ─── 反向索引：Map<userId, number> ──────────────────────────────────────
        // O(1) 查询用户连接数，替代原 O(N*M) 遍历所有任务所有连接
        this._userConnectionCount = new Map();

        // ─── 全局单心跳（替代 N 个 per-taskId 心跳） ─────────────────────────────
        this._globalHeartbeat = setInterval(
            () => this._broadcastHeartbeat(),
            config.sseHeartbeatMs
        );
        if (this._globalHeartbeat.unref) this._globalHeartbeat.unref();

        // 僵尸连接清理定时器
        this._cleanupTimer = setInterval(
            () => this._cleanZombies(),
            300000   // 5 分钟
        );
        if (this._cleanupTimer.unref) this._cleanupTimer.unref();
    }

    // ─── 公开接口 ──────────────────────────────────────────────────────────────

    /**
     * 将一个 HTTP response 注册为 SSE 订阅者
     *
     * 改进：
     * - 支持按用户限流（而非按任务）
     * - 记录连接元数据（userId、创建时间）
     * - 超时自动清理僵尸连接
     *
     * @param {string}           taskId
     * @param {express.Response} res
     * @param {object}           [options]
     * @param {string}           [options.userId]      - 用户标识（用于限流）
     * @param {object}           [options.initialData] - 连接建立后立即推送的数据
     * @param {number}           [options.timeoutMs]   - 连接超时时间（默认 30min）
     */
    subscribe(taskId, res, options = {}) {
        const { userId = 'anonymous', initialData = {}, timeoutMs = 1800000 } = options;

        // ─── 同一用户对同一任务去重：拒绝新连接（避免关闭旧连接触发浏览器自动重连风暴） ──
        const existingMeta = this._connectionMetadata.get(taskId);
        if (existingMeta) {
            for (const meta of existingMeta) {
                if (meta.userId === userId) {
                    logger.info('SSE 同用户同任务已有连接，拒绝新连接', {
                        taskId,
                        userId,
                    });
                    res.status(409).json({
                        success: false,
                        errorCode: 'E409_SSE_DUPLICATE',
                        message: '已存在相同任务的活动连接',
                    });
                    return;
                }
            }
        }

        // ─── 改进：按用户限流 ────────────────────────────────────────────────
        const userConnections = this._getUserConnections(userId);
        if (userConnections >= config.sseMaxSubscribersPerUser) {
            logger.warn('用户 SSE 连接数已达上限', {
                taskId,
                userId,
                connections: userConnections,
                limit: config.sseMaxSubscribersPerUser,
            });
            res.status(429).json({
                success: false,
                errorCode: 'E429_SSE_LIMIT',
                message: `用户连接数已达上限（${config.sseMaxSubscribersPerUser}），请关闭其他连接后重试`,
            });
            return;
        }

        // 检查任务级连接数上限（保留原有逻辑）
        const current = this._subscribers.get(taskId);
        if (current && current.size >= config.sseMaxSubscribersPerTask) {
            logger.warn('任务 SSE 连接数已达上限', {
                taskId,
                limit: config.sseMaxSubscribersPerTask,
            });
            res.status(429).json({
                success: false,
                errorCode: 'E429_TASK_SSE_LIMIT',
                message: `该任务连接数已达上限（${config.sseMaxSubscribersPerTask}），请稍后重试`,
            });
            return;
        }

        // 设置 SSE 响应头
        res.set({
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();

        // 注册到订阅者集合
        if (!this._subscribers.has(taskId)) {
            this._subscribers.set(taskId, new Set());
        }
        this._subscribers.get(taskId).add(res);

        // ─── 改进：记录连接元数据 ────────────────────────────────────────────────
        if (!this._connectionMetadata.has(taskId)) {
            this._connectionMetadata.set(taskId, new Set());
        }
        const connectionMeta = { res, userId, createdAt: Date.now(), timeoutMs };
        this._connectionMetadata.get(taskId).add(connectionMeta);

        // 更新反向索引
        this._userConnectionCount.set(userId, (this._userConnectionCount.get(userId) || 0) + 1);

        // 推送 connected 事件（附带当前状态快照）
        this._sendFrame(res, 'connected', {
            taskId,
            userId,
            timestamp: new Date().toISOString(),
            ...initialData,
        });

        // ─── 全局心跳已在构造函数中开启，这里无需再起定时器 ─────────────

        // 客户端断线时自动清理
        res.on('close', () => {
            this._unsubscribe(taskId, res, connectionMeta);
        });
    }

    /**
     * 向 taskId 的所有订阅者推送事件
     * @param {string} taskId
     * @param {string} eventType - 'status' | 'result' | 'progress' | 'error' | 'done'
     * @param {object} data
     */
    emit(taskId, eventType, data) {
        const subs = this._subscribers.get(taskId);
        if (!subs || subs.size === 0) {
            logger.debug('emit: 无活跃订阅者', { taskId, eventType });
            return;
        }
        const payload = { timestamp: new Date().toISOString(), ...data };
        logger.debug('SSE 推送', { taskId, eventType, subscriberCount: subs.size });
        for (const res of subs) {
            this._sendFrame(res, eventType, payload);
        }
    }

    /**
     * 关闭 taskId 的所有 SSE 连接（任务完成/失败时调用）
     * @param {string} taskId
     */
    close(taskId) {
        const subs = this._subscribers.get(taskId);
        if (subs) {
            for (const res of subs) {
                try { res.end(); } catch { /* 忽略已关闭的连接 */ }
            }
            this._subscribers.delete(taskId);
            logger.info('SSE 连接已全部关闭', { taskId });
        }

        // 清理反向索引
        const metadataSet = this._connectionMetadata.get(taskId);
        if (metadataSet) {
            for (const meta of metadataSet) {
                const count = this._userConnectionCount.get(meta.userId);
                if (count !== undefined) {
                    if (count <= 1) {
                        this._userConnectionCount.delete(meta.userId);
                    } else {
                        this._userConnectionCount.set(meta.userId, count - 1);
                    }
                }
            }
        }

        this._connectionMetadata.delete(taskId);
    }

    /**
     * 返回指定 taskId 的当前订阅者数量
     * @param {string} taskId
     * @returns {number}
     */
    subscriberCount(taskId) {
        return this._subscribers.get(taskId)?.size ?? 0;
    }

    // ─── 内部方法 ──────────────────────────────────────────────────────────────

    _sendFrame(res, eventType, data) {
        try {
            res.write(`event: ${eventType}\n`);
            res.write(`data: ${JSON.stringify(data)}\n`);
            res.write('\n');
        } catch (err) {
            logger.warn('SSE 帧写入失败', { error: err.message });
        }
    }

    _unsubscribe(taskId, res, connectionMeta) {
        const subs = this._subscribers.get(taskId);
        if (!subs) return;
        subs.delete(res);

        const metadataSet = this._connectionMetadata.get(taskId);
        if (metadataSet && connectionMeta) {
            metadataSet.delete(connectionMeta);
            // 更新反向索引
            const userId = connectionMeta.userId;
            const count = this._userConnectionCount.get(userId);
            if (count !== undefined) {
                if (count <= 1) {
                    this._userConnectionCount.delete(userId);
                } else {
                    this._userConnectionCount.set(userId, count - 1);
                }
            }
        }

        if (subs.size === 0) {
            this._subscribers.delete(taskId);
            this._connectionMetadata.delete(taskId);
        }
    }

    /**
     * 全局心跳：向所有订阅中的客户端广播心跳包
     * 相比每任务独立心跳，N 个任务只消耗 1 个定时器
     */
    _broadcastHeartbeat() {
        if (this._subscribers.size === 0) return;
        const heartbeat = `: heartbeat ${new Date().toISOString()}\n\n`;
        for (const [, subs] of this._subscribers) {
            for (const res of subs) {
                try { res.write(heartbeat); } catch { /* 连接已断开，忽略 */ }
            }
        }
    }

    /**
     * 清理超时的僵尸连接
     */
    _cleanZombies() {
        const now = Date.now();
        let cleaned = 0;

        for (const [taskId, metadataSet] of this._connectionMetadata) {
            for (const meta of metadataSet) {
                if (now - meta.createdAt > meta.timeoutMs) {
                    try {
                        meta.res.end();
                        this._unsubscribe(taskId, meta.res, meta);
                        cleaned++;
                    } catch {
                        // 连接已断开，忽略
                    }
                }
            }
        }

        if (cleaned > 0) {
            logger.info('僵尸连接清理完成', { cleanedCount: cleaned });
        }
    }

    // ─── 辅助方法 ──────────────────────────────────────────────────────────────

    /**
     * 获取某用户的总连接数（跨所有任务）
     * O(1) 查询，使用反向索引 Map
     * @param {string} userId
     * @returns {number}
     */
    _getUserConnections(userId) {
        return this._userConnectionCount.get(userId) || 0;
    }

    /**
     * 启动僵尸连接清理定时器（5 分钟检查一次）
     * @deprecated 已内建到构造函数中，保留以兼容
     */
    _startCleanupTimer() {}

    /**
     * 获取全局连接统计信息
     * @returns {{
     *   totalConnections: number,
     *   taskCount: number,
     *   userStats: Map<string, number>,
     *   oldestConnection: { taskId: string, age: number, userId: string } | null
     * }}
     */
    getStats() {
        let totalConnections = 0;
        const userStats = new Map();
        let oldestConnection = null;
        let oldestAge = 0;

        for (const [taskId, metadataSet] of this._connectionMetadata) {
            totalConnections += metadataSet.size;

            for (const meta of metadataSet) {
                // 统计用户连接数
                const userCount = userStats.get(meta.userId) || 0;
                userStats.set(meta.userId, userCount + 1);

                // 寻找最老的连接
                const age = Date.now() - meta.createdAt;
                if (age > oldestAge) {
                    oldestAge = age;
                    oldestConnection = { taskId, age, userId: meta.userId };
                }
            }
        }

        return {
            totalConnections,
            taskCount: this._subscribers.size,
            userStats: this._userConnectionCount,
            oldestConnection: oldestAge > 0 ? oldestConnection : null,
        };
    }
}

// 全局单例，确保所有模块共用同一个 SSE 管理器
const sseEmitter = new SSEEmitter();
export default sseEmitter;
