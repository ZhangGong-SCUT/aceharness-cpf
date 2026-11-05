/**
 * 统计路由 — 网站访问计数等统计功能
 *
 * 挂载点：/api/stats/*
 */

import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../library/logger.js';

const logger = createLogger('StatsRouter');

// 访问统计数据存储路径：db/web/visit-stats.json
const STATS_DIR = process.env.WEB_STATS_ROOT
    ? process.env.WEB_STATS_ROOT
    : fileURLToPath(new URL('../../../db/web', import.meta.url));
const STATS_FILE = path.join(STATS_DIR, 'visit-stats.json');

/**
 * 确保统计目录和文件存在
 */
async function ensureStatsFile() {
    try {
        await fs.mkdir(STATS_DIR, { recursive: true });
        // 检查文件是否存在
        try {
            await fs.access(STATS_FILE);
        } catch {
            // 文件不存在，创建初始数据
            const initialData = {
                visitCount: 0,
                sessionCount: 0,  // Session 调用次数统计
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            await fs.writeFile(STATS_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
            logger.info('访问统计数据文件已创建', { path: STATS_FILE });
        }
    } catch (err) {
        logger.error('确保统计文件失败', { error: err.message });
        throw err;
    }
}

/**
 * 读取访问统计数据
 */
async function readStats() {
    await ensureStatsFile();
    const content = await fs.readFile(STATS_FILE, 'utf-8');
    return JSON.parse(content);
}

/**
 * 写入访问统计数据
 */
async function writeStats(data) {
    await ensureStatsFile();
    await fs.writeFile(STATS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 创建统计路由
 * @returns {Router}
 */
export function createStatsRouter() {
    const router = Router();

    /**
     * GET /api/stats/visit
     * 获取访问次数并自增（每次页面加载调用）
     */
    router.get('/stats/visit', async (_req, res) => {
        try {
            const stats = await readStats();
            stats.visitCount += 1;
            stats.updatedAt = new Date().toISOString();
            await writeStats(stats);
            
            logger.debug('访问计数更新', { visitCount: stats.visitCount });
            
            res.json({
                success: true,
                data: {
                    visitCount: stats.visitCount,
                    updatedAt: stats.updatedAt
                }
            });
        } catch (err) {
            logger.error('访问计数更新失败', { error: err.message });
            res.status(500).json({
                success: false,
                message: '访问统计服务暂不可用'
            });
        }
    });

    /**
     * GET /api/stats/visit/count
     * 仅获取当前访问次数（不自增，用于实时查看）
     */
    router.get('/stats/visit/count', async (_req, res) => {
        try {
            const stats = await readStats();
            res.json({
                success: true,
                data: {
                    visitCount: stats.visitCount,
                    updatedAt: stats.updatedAt
                }
            });
        } catch (err) {
            logger.error('获取访问计数失败', { error: err.message });
            res.status(500).json({
                success: false,
                message: '访问统计服务暂不可用'
            });
        }
    });

    /**
     * POST /api/stats/session/increment
     * Session 调用计数自增（每次 startSession 调用时触发）
     */
    router.post('/stats/session/increment', async (_req, res) => {
        try {
            const stats = await readStats();
            stats.sessionCount = (stats.sessionCount || 0) + 1;
            stats.updatedAt = new Date().toISOString();
            await writeStats(stats);
            
            logger.debug('Session 调用计数更新', { sessionCount: stats.sessionCount });
            
            res.json({
                success: true,
                data: {
                    sessionCount: stats.sessionCount,
                    updatedAt: stats.updatedAt
                }
            });
        } catch (err) {
            logger.error('Session 调用计数更新失败', { error: err.message });
            res.status(500).json({
                success: false,
                message: 'Session 统计服务暂不可用'
            });
        }
    });

    /**
     * GET /api/stats/session/count
     * 仅获取当前 Session 调用次数（不自增，用于实时查看）
     */
    router.get('/stats/session/count', async (_req, res) => {
        try {
            const stats = await readStats();
            res.json({
                success: true,
                data: {
                    sessionCount: stats.sessionCount || 0,
                    updatedAt: stats.updatedAt
                }
            });
        } catch (err) {
            logger.error('获取 Session 调用计数失败', { error: err.message });
            res.status(500).json({
                success: false,
                message: 'Session 统计服务暂不可用'
            });
        }
    });

    return router;
}

export default createStatsRouter;