/**
 * 系统路由 — 健康检查与队列状态
 *
 * 路由列表：
 *  GET /api/alive           — 轻量健康检查
 *  GET /api/alive/detail    — 详细健康信息（含内存、SSE 统计）
 *  GET /api/alive/copilot   — Copilot CLI 健康检查
 *  GET /api/queue/status    — 并发队列状态
 */

import { Router } from 'express';
import { createLogger } from '../library/logger.js';
import config from '../library/config.js';
import sseEmitter from '../send/index.js';
import CopilotCLI from '../cli/copilot/index.js';
import { getUserByToken } from '../prReview/client.js';

const logger = createLogger('Router.System');

/**
 * @param {import('../PortingOrchestrator.js').PortingOrchestrator} orchestrator
 * @returns {Router}
 */
export function createSystemRouter(orchestrator) {
    const router = Router();

    async function requireUser(req, res) {
        const authorization = req.headers.authorization || '';
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        if (!token) {
            res.status(401).json({ success: false, message: '请先登录' });
            return null;
        }
        const user = await getUserByToken(token);
        if (!user) res.status(401).json({ success: false, message: '登录已过期' });
        return user;
    }

    // ── 轻量健康检查 ───────────────────────────────────────────────────────────

    router.get('/alive', (_req, res) => {
        // Process liveness is independent of a legacy fixed-port model server.
        // Use /api/issue-analysis/health for the actual diagnosis dependency chain.
        res.json({ success: true, status: 'ok', uptime: process.uptime(),
            diagnosisHealthUrl: '/api/issue-analysis/health' });
    });

    // ── 详细健康检查 ───────────────────────────────────────────────────────────

    router.get('/alive/detail', async (req, res) => {
        if (!await requireUser(req, res)) return;
        try {
            const queueStatus = orchestrator.getQueueStatus();
            const aiAgentHealth = await orchestrator.checkHealth();
            const sseStats = sseEmitter.getStats();

            const health = {
                server: {
                    status: 'ok',
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    timestamp: new Date().toISOString(),
                },
                queue: {
                    status: queueStatus.running < config.maxConcurrentTasks ? 'ok' : 'full',
                    ...queueStatus,
                    maxConcurrent: config.maxConcurrentTasks,
                    capacity: config.taskQueueSize,
                },
                sse: {
                    totalConnections: sseStats.totalConnections,
                    taskCount: sseStats.taskCount,
                    userStats: Object.fromEntries(sseStats.userStats),
                    oldestConnection: sseStats.oldestConnection,
                },
                aiAgent: aiAgentHealth,
                config: {
                    gitcodeToken: config.gitcodeToken ? 'configured' : 'missing',
                    maxConcurrentTasks: config.maxConcurrentTasks,
                    taskQueueSize: config.taskQueueSize,
                    sseMaxPerTask: config.sseMaxSubscribersPerTask,
                    sseMaxPerUser: config.sseMaxSubscribersPerUser,
                },
            };

            res.json({ success: true, health });
        } catch (err) {
            logger.error('详细健康检查失败', { error: err.message });
            res.status(503).json({ success: false, message: err.message });
        }
    });

    // ── Copilot 健康检查 ────────────────────────────────────────────────────────

    router.get('/alive/copilot', async (req, res) => {
        if (!await requireUser(req, res)) return;
        const cli = new CopilotCLI();
        try {
            const health = await cli.checkHealth();
            res.json({ success: true, ...health });
        } catch (err) {
            logger.error('Copilot 健康检查失败', { error: err.message });
            res.status(503).json({ success: false, message: err.message });
        } finally {
            await cli.close();
        }
    });

    // ── 队列状态 ───────────────────────────────────────────────────────────────

    router.get('/queue/status', (req, res) => {
        const allQueues = orchestrator.getAllQueueStatuses();
        const queues = {
            issueanalysis:        allQueues.issueanalysis,
        };
        const semaphore = allQueues.semaphore;

        // 支持 ?format=text 返回易读的文本表格
        const wantText = req.query.format === 'text' ||
            req.accepts('text/plain') && !req.accepts('json');

        if (wantText) {
            const labelMap = {
                issueanalysis:      'Issue 分析',
            };

            // 表格行
            const rows = Object.entries(queues).map(([key, q]) => {
                const label = labelMap[key] || key;
                const usage = `${q.running}/${q.maxConcurrent}`;
                const bar = renderBar(q.running, q.maxConcurrent);
                const queueInfo = q.queued > 0 ? `  排队: ${q.queued}/${q.capacity}` : '';
                return `  ${label.padEnd(22)} 并发: ${usage.padEnd(7)} ${bar}${queueInfo}`;
            });

            // 信号量行
            const semUsage = `${semaphore.current}/${semaphore.max}`;
            const semBar = renderBar(semaphore.current, semaphore.max);
            const semWait = semaphore.waiting > 0 ? `  等待: ${semaphore.waiting}` : '';

            const output = [
                '╔══════════════════════════════════════════════════════════════╗',
                '║                    并发队列状态总览                          ║',
                '╚══════════════════════════════════════════════════════════════╝',
                '',
                '任务队列:',
                ...rows,
                '',
                '全局信号量 (OpenCode Session):',
                `  会话占用: ${semUsage.padEnd(7)} ${semBar}${semWait}`,
                '',
                `时间: ${new Date().toISOString()}`,
            ].join('\n');

            res.type('text/plain; charset=utf-8').send(output);
        } else {
            res.json({
                success: true,
                queues,
                semaphore,
                config: {
                    maxConcurrentTasks:                      config.maxConcurrentTasks,
                    taskQueueSize:                           config.taskQueueSize,
                    maxConcurrentSessions:                   config.maxConcurrentSessions,
                },
            });
        }
    });

    return router;
}

/**
 * 渲染文本进度条
 * @param {number} used  - 已使用数
 * @param {number} total - 总数
 * @param {number} width - 进度条宽度（字符数）
 * @returns {string}
 */
function renderBar(used, total, width = 10) {
    const filled = total > 0 ? Math.round((used / total) * width) : 0;
    const bar = '█'.repeat(Math.min(filled, width)) + '░'.repeat(width - Math.min(filled, width));
    const pct = total > 0 ? `${Math.round((used / total) * 100)}%` : '0%';
    return `[${bar}] ${pct}`;
}

export default createSystemRouter;
