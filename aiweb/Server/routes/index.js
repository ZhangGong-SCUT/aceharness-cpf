/**
 * 路由组装器 — 将各业务域路由组合到一个 Router
 *
 * 挂载点（server.js 中）：app.use('/api', router)
 *
 * 业务域划分：
 *  system.js          — /alive, /alive/detail, /alive/copilot, /queue/status
 *  issueanalysis.js   — /issue-analysis/*
 *  prreview.js        — /pr-review/*（PR 监控评审，按 userId 隔离）
 *  stats.js           — /stats/*
 */

import { Router } from 'express';
import { createSystemRouter } from './system.js';
import { createIssueAnalysisRouter } from './issueanalysis.js';
import { createPrReviewRouter } from './prreview.js';
import { createStatsRouter } from './stats.js';

/**
 * @param {import('../PortingOrchestrator.js').PortingOrchestrator} orchestrator
 * @returns {Router}
 */
export function createRouter(orchestrator) {
    const router = Router();

    router.use(createSystemRouter(orchestrator));
    router.use(createIssueAnalysisRouter(orchestrator));
    router.use(createPrReviewRouter(orchestrator));
    router.use(createStatsRouter());

    return router;
}

export default createRouter;
