/**
 * HTTP 服务入口
 *
 * 运行方式：
 *   node server.js                           # 默认启用持久化（推荐）
 *   TASK_PERSISTENCE=false node server.js    # 禁用持久化（开发调试）
 *   PORT=3000 node server.js                 # 自定义端口
 *
 * 持久化说明：
 * - 默认启用（无需设置环境变量），任务数据保存在 SQLite 数据库
 * - 数据库文件：library/porting.db, library/codecheck.db, library/librarycheck.db
 * - 服务器重启后自动恢复历史任务记录
 * - 只有明确设置 TASK_PERSISTENCE=false 才会禁用持久化
 */

// ─── 持久化默认启用说明 ────────────────────────────────────────────────────────
// HybridTaskStore 内部已默认启用持久化，无需在此设置环境变量
// 只有需要禁用时才设置：TASK_PERSISTENCE=false

// .env 环境变量由 library/config.js 在加载时自动读取（dotenv）
// 敏感信息（AceHarness 邮箱/密码、GitCode Token 等）通过 .env 注入，不硬编码

import express from 'express';
import config from './library/config.js';
import logger from './library/logger.js';
import { createRouter } from './routes/index.js';
import PortingOrchestrator from './PortingOrchestrator.js';

// ─── 初始化 ────────────────────────────────────────────────────────────────────

// 编排器单例（内部自动初始化存储,支持持久化）
// 高内聚:存储生命周期由编排器统一管理
const orchestrator = new PortingOrchestrator();

// ─── Express 应用 ──────────────────────────────────────────────────────────────

const app = express();

// 解析 JSON 请求体（限制 1 MB 防止超大请求）
app.use(express.json({ limit: '1mb' }));

// 挂载路由
app.use('/api', createRouter(orchestrator));

// 404 兜底
app.use((_req, res) => {
    res.status(404).json({ success: false, message: '接口不存在' });
});

// 全局错误处理
app.use((err, _req, res, _next) => {
    logger.error('未处理的请求错误', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: '服务器内部错误' });
});

// ─── 优雅关闭 ──────────────────────────────────────────────────────────────────
process.on('SIGINT', () => {
    logger.info('收到 SIGINT 信号，正在关闭服务...');
    orchestrator.close();  // 通过编排器关闭所有存储连接
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('收到 SIGTERM 信号，正在关闭服务...');
    orchestrator.close();
    process.exit(0);
});

// ─── 启动 ──────────────────────────────────────────────────────────────────────

// HOST 环境变量支持（默认 0.0.0.0 与历史行为一致；桌面客户端传 127.0.0.1 仅本机可达）
app.listen(config.port, process.env.HOST || '0.0.0.0', () => {
    logger.info(`服务已启动`, {
        port:    config.port,
        baseUrl: config.baseUrl,
        env:     process.env.NODE_ENV ?? 'development',
        persistence: process.env.TASK_PERSISTENCE !== 'false' ? 'enabled (default)' : 'disabled',  // ─── 改进：正确显示持久化状态 ─────
    });
    logger.info('API 端点列表', {
        alive:                   `GET  /api/alive`,
        issueAnalysisStart:      `POST /api/issue-analysis`,
        issueAnalysisValidate:   `POST /api/issue-analysis/validate`,
        issueAnalysisStatus:     `GET  /api/issue-analysis/:taskId/status`,
        issueAnalysisList:       `GET  /api/issue-analysis`,
        issueAnalysisReport:     `GET  /api/issue-analysis/:taskId/final-review`,
    });
});

