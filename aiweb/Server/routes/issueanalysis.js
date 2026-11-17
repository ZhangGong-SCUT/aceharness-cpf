/**
 * Issue 分析路由 — AceHarness 代理层
 *
 * 本系统仅做前端展示和交互，实际分析能力由 AceHarness 服务提供。
 * 所有数据实时从 AceHarness 获取，本地只存任务元数据（taskId ↔ runId 映射）。
 *
 * 路由列表：
 *  POST   /api/issue-analysis                              启动 Issue 分析任务
 *  POST   /api/issue-analysis/validate                     校验 URL 是否合法
 *  GET    /api/issue-analysis/:taskId/status               查询任务状态（代理到 AceHarness）
 *  POST   /api/issue-analysis/:taskId/continue             服务重启中断后从原步骤继续
 *  POST   /api/issue-analysis/:taskId/stop                 停止分析并释放该 run 的设备锁
 *  GET    /api/issue-analysis                               列出所有任务
 *  GET    /api/issue-analysis/:taskId/artifacts            列出 run 产物（截图/日志/补丁，本地磁盘直读）
 *  GET    /api/issue-analysis/:taskId/artifacts/file       读取单个产物（?ref=work/xx.png）
 *  GET    /api/issue-analysis/:taskId/report               最终评审报告（代理到 AceHarness）
 *  GET    /api/issue-analysis/:taskId/outputs              列出步骤输出文件
 *  GET    /api/issue-analysis/:taskId/outputs/:stepName    读取步骤输出内容
 *  GET    /api/issue-analysis/:taskId/final-review         最终评审报告（Markdown 渲染）
 */

import { Router } from 'express';
import { createLogger } from '../library/logger.js';
import config from '../library/config.js';
import { getUserByToken, openLocalSession } from '../prReview/client.js';
import { renderMarkdownSafe } from '../issueAnalysis/markdownSafe.js';
import { issueDetailStatus } from '../issueAnalysis/detailPresentation.js';
import {
    startIssueAnalysis,
    getTask,
    listTasks,
    getTaskStatus,
    getFinalReview,
    isValidIssueUrl,
    parseIssueUrl,
    listTaskArtifacts,
    readTaskArtifact,
    submitFeedback,
    continueIssueAnalysis,
    diagnoseIssueAnalysisFailure,
    listIssuePlatformDefects,
    stopIssueAnalysis,
    getIssueChainHealth,
    getIterationChain,
    compareIterations,
} from '../issueAnalysis/service.js';

const logger = createLogger('Router.IssueAnalysis');

export function issueAnalysisPresentation(task) {
    const t = task || {};
    let meta = {};
    try { meta = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : (t.metadata || {}); } catch { /* 保留可展示的本地字段 */ }
    const runId = meta.runId || t.analysisSessionId || null;
    const configFile = meta.configFile || (t.parentTaskId ? 'cpf-ohos-diagnosis-iterate.yaml' : config.aceharness.configFile) || 'cpf-ohos-diagnosis.yaml';
    const route = runId ? `/workbench/${configFile}?mode=run&run=${runId}` : null;
    return {
        taskId: t.taskId,
        cliType: t.cliType,
        stage: t.stage,
        issueUrl: t.issueUrl,
        issueType: t.issueType,
        dirName: t.dirName,
        runId,
        frontendSessionId: meta.frontendSessionId || null,
        workbenchUrl: route ? `${config.aceharness.baseUrl}/dashboard?route=${encodeURIComponent(route)}` : null,
        priorityLevel: t.priorityLevel,
        summary: t.summary,
        error: t.error,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        parentTaskId: t.parentTaskId ?? null,
        userFeedback: t.userFeedback ?? null,
        metadata: { artifactStatus: meta.artifactStatus ?? null, verificationStatus: meta.verificationStatus ?? null },
    };
}

export function createIssueAnalysisRouter(orchestrator, dependencies = {}) {
    const {
        getUser = getUserByToken,
        getLocalSession = openLocalSession,
        startTask = startIssueAnalysis,
        findTask = getTask,
    } = dependencies;
    const router = Router();

    // ── 鉴权（身份隔离：提交人仅可见自己的任务，admin 可见全部） ──────────────

    // 从请求中提取用户 token：Authorization 头（authApi）或 ?token= 查询参数
    // （<img src> / <a download> / 新标签页打开报告等浏览器原生请求带不了 header，走查询参数）
    function extractToken(req) {
        const h = req.headers.authorization || '';
        if (h.startsWith('Bearer ')) return h.slice(7);
        const q = req.query?.token;
        return (typeof q === 'string' && q) ? q : null;
    }

    async function _requireUser(req, res) {
        const token = extractToken(req);
        const user = token ? await getUser(token) : null;
        if (user) return user;
        // 仅限真正的本机个人部署；转发头不参与判断，公网部署永不回退。
        if (process.env.AIWEB_DEPLOYMENT === 'personal'
            && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) {
            try {
                const local = await getLocalSession();
                if (local?.user) return local.user;
            } catch (err) {
                res.status(503).json({ success: false, message: `本机免登录会话不可用：${err.message}` });
                return null;
            }
        }
        res.status(401).json({ success: false, message: token ? '登录已过期，请重新登录' : '未登录' });
        return null;
    }

    // 单任务归属校验：任务不存在 → 404；非本人且非 admin → 403
    async function _authTask(req, res, taskId) {
        const user = await _requireUser(req, res);
        if (!user) return null;
        const task = findTask(taskId);
        if (!task) {
            res.status(404).json({ success: false, message: `Issue 分析任务 ${taskId} 不存在` });
            return null;
        }
        const isOwner = task.ownerUsername && task.ownerUsername === user.username;
        if (!isOwner && user.role !== 'admin') {
            logger.warn('越权访问 Issue 分析任务被拒', { taskId, username: user.username, owner: task.ownerUsername });
            res.status(403).json({ success: false, message: '只能查看自己提交的 Issue 分析任务' });
            return null;
        }
        return { user, task };
    }

    // ── 1. 启动任务 ───────────────────────────────────────────────────────────

    router.post('/issue-analysis', async (req, res) => {
        const { issueUrl, accessToken, priority, issueType, configFile, issueContent, evaluationMode } = req.body ?? {};

        const user = await _requireUser(req, res);
        if (!user) return;

        if (!issueUrl) {
            return res.status(400).json({ success: false, message: '缺少 issueUrl 参数' });
        }
        if (!isValidIssueUrl(issueUrl)) {
            return res.status(400).json({
                success: false,
                message: 'Issue URL 格式无效（仅支持 gitcode/github/gitee，形如 /owner/repo/issues/123）',
            });
        }
        // F03：受控快照输入（盲测/受控回放）。提供 issueContent 时必须为字符串且非空
        if (issueContent != null && (typeof issueContent !== 'string' || !issueContent.trim())) {
            return res.status(400).json({ success: false, message: 'issueContent 必须为非空字符串（Markdown 快照）' });
        }
        if (evaluationMode != null && !['guided_replay', 'blind_eval'].includes(evaluationMode)) {
            return res.status(400).json({ success: false, message: 'evaluationMode 仅支持 guided_replay / blind_eval' });
        }

        try {
            const { taskId, runId, dirName, frontendSessionId } = await startTask({
                issueUrl,
                accessToken: accessToken || null,
                priority: priority || null,
                issueType: issueType || null,
                configFile: configFile || null,
                ownerUsername: user.username,
                issueContent: issueContent || null,
                evaluationMode: evaluationMode || null,
            });
            // 构造 AceHarness 工作流任务详情页 URL，供前端展示跳转按钮
            let workbenchUrl = null;
            if (runId) {
                const cf = configFile || config.aceharness.configFile || 'cpf-ohos-diagnosis.yaml';
                const route = `/workbench/${cf}?mode=run&run=${runId}`;
                workbenchUrl = `${config.aceharness.baseUrl}/dashboard?route=${encodeURIComponent(route)}`;
            }
            logger.info('Issue 分析任务已受理', { taskId, runId, issueUrl, submitter: user.username });
            res.status(202).json({
                success: true,
                taskId,
                runId,
                dirName,
                frontendSessionId,
                workbenchUrl,
                statusUrl: `/api/issue-analysis/${taskId}/status`,
                finalReviewUrl: `/api/issue-analysis/${taskId}/final-review`,
            });
        } catch (err) {
            logger.error('启动 Issue 分析任务失败', { error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // ── 2. URL 校验 ──────────────────────────────────────────────────────────

    router.post('/issue-analysis/validate', (req, res) => {
        const { issueUrl } = req.body ?? {};
        if (!issueUrl) {
            return res.json({ success: true, valid: false, message: 'URL 为空' });
        }
        if (!isValidIssueUrl(issueUrl)) {
            return res.json({
                success: true, valid: false,
                message: 'Issue URL 格式无效（仅支持 gitcode / github / gitee）',
            });
        }
        try {
            const meta = parseIssueUrl(issueUrl);
            res.json({ success: true, valid: true, ...meta });
        } catch (e) {
            res.json({ success: true, valid: false, message: e.message });
        }
    });

    // ── 2.5 诊断链健康与指标（F09：与 PortingOrchestrator 队列分开统计） ─────
    // 注意：注册在 /issue-analysis/:taskId/status 之前，路径无冲突（段数不同）

    router.get('/issue-analysis/health', async (req, res) => {
        const user = await _requireUser(req, res);
        if (!user) return;
        try {
            const health = await getIssueChainHealth();
            res.json({ success: true, ...health });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // ── 3. 任务状态（代理到 AceHarness） ──────────────────────────────────────

    router.post('/issue-analysis/:taskId/stop', async (req, res) => {
        const { taskId } = req.params;
        const auth = await _authTask(req, res, taskId);
        if (!auth) return;
        try {
            const result = await stopIssueAnalysis(taskId);
            res.json({ success: true, ...result });
        } catch (err) {
            logger.error('停止分析失败', { taskId, error: err.message });
            res.status(err.status || 500).json({ success: false, message: err.message });
        }
    });

    // 失败分诊只读取真实运行证据；不会启动或修改原工作流。
    router.get('/issue-analysis/:taskId/failure-diagnosis', async (req, res) => {
        const { taskId } = req.params;
        const auth = await _authTask(req, res, taskId);
        if (!auth) return;
        try {
            const diagnosis = await diagnoseIssueAnalysisFailure(taskId, { supervisor: true });
            res.json({ success: true, diagnosis });
        } catch (err) {
            res.status(err.status || 500).json({ success: false, message: err.message, diagnosis: err.diagnosis });
        }
    });

    router.get('/issue-analysis/platform-defects', async (req, res) => {
        const user = await _requireUser(req, res);
        if (!user) return;
        if (!isActiveAdmin(user)) return res.status(403).json({ success: false, message: '仅管理员可查看平台缺陷台账' });
        try { res.json({ success: true, ...(await listIssuePlatformDefects()) }); }
        catch (err) { res.status(500).json({ success: false, message: err.message }); }
    });

    router.post('/issue-analysis/:taskId/continue', async (req, res) => {
        const { taskId } = req.params;
        const auth = await _authTask(req, res, taskId);
        if (!auth) return;
        try {
            const result = await continueIssueAnalysis(taskId, {
                feedback: typeof req.body?.feedback === 'string' ? req.body.feedback : '',
                fixEvidence: typeof req.body?.fixEvidence === 'string' ? req.body.fixEvidence : '',
            });
            res.json({ success: true, ...result });
        } catch (err) {
            logger.error('继续分析失败', { taskId, error: err.message });
            res.status(err.status || 500).json({ success: false, message: err.message, diagnosis: err.diagnosis });
        }
    });

    router.get('/issue-analysis/:taskId/status', async (req, res) => {
        const { taskId } = req.params;
        const auth = await _authTask(req, res, taskId);
        if (!auth) return;
        try {
            const rawTask = await getTaskStatus(taskId);
            if (!rawTask) {
                return res.status(404).json({ success: false, message: `Issue 分析任务 ${taskId} 不存在` });
            }
            const presentation = issueAnalysisPresentation(rawTask);
            const { accessToken, metadata: _metadata, ...rawFields } = rawTask;
            res.json({ success: true, task: { ...rawFields, ...presentation, aceharnessStatus: issueDetailStatus(rawTask.aceharnessStatus), queryUnavailable: !!rawTask.queryUnavailable } });
        } catch (err) {
            logger.error('查询状态失败', { taskId, error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // ── 4. 任务列表（身份隔离：本人任务 + admin 全量） ────────────────────────

    router.get('/issue-analysis', async (req, res) => {
        const user = await _requireUser(req, res);
        if (!user) return;
        const isAdmin = user.role === 'admin';
        // A10：用户条件与分页下沉到存储层查询（先限定访问范围再分页排序），
        // 不再"全站取最近 100 条再按用户过滤"——否则别人的新任务会挤掉自己的历史。
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
        const { tasks: rawTasks, total } = listTasks({
            ownerUsername: isAdmin ? null : user.username,
            page,
            pageSize,
        });
        const tasks = rawTasks.map(t => ({
            ...issueAnalysisPresentation(t),
            ownerUsername: isAdmin ? (t.ownerUsername ?? null) : undefined,
            accessToken: t.accessToken ? '***' : null,
        }));
        res.json({
            success: true,
            page,
            pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            tasks,
        });
    });

    // ── 4b. 用户反馈迭代 ──────────────────────────────────────────────────────

    // 4b-1. 提交反馈：fork 出迭代任务（从方案设计阶段重新收敛，不全量重跑）
    router.post('/issue-analysis/:taskId/feedback', async (req, res) => {
        const { taskId } = req.params;
        const auth = await _authTask(req, res, taskId);
        if (!auth) return;
        const feedback = req.body?.feedback;
        if (!feedback || typeof feedback !== 'string' || !feedback.trim()) {
            return res.status(400).json({ success: false, message: '缺少反馈内容（feedback）' });
        }
        try {
            const result = await submitFeedback(taskId, feedback);
            res.json({ success: true, ...result });
        } catch (err) {
            logger.error('提交反馈失败', { taskId, error: err.message });
            const status = /不存在|未结束|已不存在|缺少/.test(err.message) ? 400 : 500;
            res.status(status).json({ success: false, message: err.message });
        }
    });

    // 4b-2. 查询迭代链（根任务 + 全部轮次）
    router.get('/issue-analysis/:taskId/iterations', async (req, res) => {
        const auth = await _authTask(req, res, req.params.taskId);
        if (!auth) return;
        const chain = getIterationChain(req.params.taskId);
        if (!chain) {
            return res.status(404).json({ success: false, message: `任务 ${req.params.taskId} 不存在` });
        }
        res.json({ success: true, ...chain });
    });

    // 4b-3. 两轮修复对比（AI 轮 vs 用户反馈轮）
    // A01：with 参数的目标任务同样必须通过归属校验，不能只鉴权路径里的 taskId
    router.get('/issue-analysis/:taskId/compare', async (req, res) => {
        const { taskId } = req.params;
        const auth = await _authTask(req, res, taskId);
        if (!auth) return;
        const withTaskId = req.query.with;
        if (!withTaskId) {
            return res.status(400).json({ success: false, message: '缺少对比目标（?with=<taskId>）' });
        }
        // 目标任务：不存在 → 404；非本人且非 admin → 403（不读取其补丁/产物）
        const target = getTask(String(withTaskId));
        if (!target) {
            return res.status(404).json({ success: false, message: `Issue 分析任务 ${withTaskId} 不存在` });
        }
        const isTargetOwner = target.ownerUsername && target.ownerUsername === auth.user.username;
        if (!isTargetOwner && auth.user.role !== 'admin') {
            logger.warn('越权对比 Issue 分析任务被拒', { taskId, with: withTaskId, username: auth.user.username, owner: target.ownerUsername });
            return res.status(403).json({ success: false, message: '只能对比自己提交的 Issue 分析任务' });
        }
        try {
            const data = await compareIterations(taskId, String(withTaskId));
            res.json({ success: true, ...data });
        } catch (err) {
            logger.error('对比查询失败', { taskId, with: withTaskId, error: err.message });
            res.status(400).json({ success: false, message: err.message });
        }
    });

    // ── 5. Run 产物（截图/日志/补丁/步骤日志，本地磁盘直读） ──────────────────

    // 5a. 读取单个产物文件：图片/二进制直接流式返回，文本默认 JSON
    router.get('/issue-analysis/:taskId/artifacts/file', async (req, res) => {
        const { taskId } = req.params;
        const ref = req.query.ref;
        const auth = await _authTask(req, res, taskId);
        if (!auth) return;
        if (!ref) {
            return res.status(400).json({ success: false, message: '缺少 ref 参数' });
        }
        try {
            const item = readTaskArtifact(taskId, String(ref));
            if (item === null) {
                return res.status(404).json({ success: false, message: `任务 ${taskId} 不存在` });
            }
            if (req.query.download === '1') {
                res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(item.name)}"`);
            }
            if (item.kind === 'text') {
                if (req.query.format === 'json') {
                    return res.json({ success: true, name: item.name, content: item.buffer.toString('utf-8') });
                }
                res.set('Content-Type', 'text/plain; charset=utf-8');
                return res.send(item.buffer);
            }
            // 图片 / 二进制
            res.set('Content-Type', item.contentType);
            res.set('Cache-Control', 'private, max-age=300');
            return res.send(item.buffer);
        } catch (err) {
            if (err.code === 'ENOENT') {
                return res.status(404).json({ success: false, message: '文件不存在（run 目录可能已被清理）' });
            }
            logger.error('读取产物失败', { taskId, ref: String(ref), error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // 5b. 产物列表
    router.get('/issue-analysis/:taskId/artifacts', async (req, res) => {
        const auth = await _authTask(req, res, req.params.taskId);
        if (!auth) return;
    const { taskId } = req.params;
    try {
        const result = await listTaskArtifacts(taskId);
        if (!result) {
            return res.status(404).json({ success: false, message: `Issue 分析任务 ${taskId} 不存在` });
        }
        res.json({
            success: true,
            taskId,
            runId: result.runId,
            ...result.artifacts,
        });
    } catch (err) {
        logger.error('列出产物失败', { taskId, error: err.message });
        res.status(500).json({ success: false, message: '诊断证据暂时无法读取，请稍后重试' });
    }
    });

    // ── 6. 诊断报告下载（Markdown 文件） ─────────────────────────────────────

    router.get('/issue-analysis/:taskId/final-review', async (req, res) => {
        const { taskId } = req.params;
        const auth = await _authTask(req, res, taskId);
        if (!auth) return;
        try {
            const report = await getFinalReview(taskId).catch(() => null);
            if (!report) {
                if (req.query.format === 'json' || (req.headers.accept || '').includes('application/json')) {
                    return res.status(404).json({ success: false, message: '报告尚未生成（工作流未完成或报告沉淀步骤未找到）' });
                }
                return res.status(404).send('报告尚未生成（工作流未完成或报告沉淀步骤未找到）');
            }
            const md = report.content;
            const accept = req.headers.accept || '';
            if (req.query.format === 'json' || accept.includes('application/json')) {
                // JSON 模式（页面内嵌渲染用）：返回原始 Markdown
                res.json({ success: true, taskId, content: md });
            } else if (accept.includes('text/html')) {
                // 在线预览：渲染为 HTML（A03：Markdown 中活动 HTML 一律转义，不执行脚本/事件）
                const token = extractToken(req);
                const html = renderReportHtml(md, taskId, token);
                res.set('Content-Type', 'text/html; charset=utf-8');
                res.send(html);
            } else {
                // 下载 Markdown 文件
                res.set('Content-Type', 'text/markdown; charset=utf-8');
                res.set('Content-Disposition', `attachment; filename="diagnosis-report-${taskId}.md"`);
                res.send(md);
            }
        } catch (err) {
            logger.error('获取诊断报告失败', { taskId, error: err.message });
            res.status(500).json({ success: false, message: err.message });
        }
    });

    return router;
}

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

/**
 * 渲染 Markdown 为完整 HTML 页面
 * A03：正文使用 renderMarkdownSafe（先转义再构建），marked 原始输出不直接注入。
 * A08：工具栏"查看证据与产物"指向真实存在的 artifacts 列表接口并附带本次请求的鉴权 token
 *（报告页由浏览器原生 <a> 打开，无法带 Authorization 头；token 与打开预览的链接同源同源）。
 */
function renderReportHtml(md, taskId, token) {
    const body = renderMarkdownSafe(md);
    const artifactsHref = `/api/issue-analysis/${taskId}/artifacts`
        + (token ? `?token=${encodeURIComponent(token)}` : '');
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Issue 分析报告 — ${taskId}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
         max-width: 900px; margin: 24px auto; padding: 0 20px;
         color: #24292e; line-height: 1.6; }
  h1, h2, h3, h4 { border-bottom: 1px solid #eaecef; padding-bottom: 6px; }
  pre, code { font-family: "SF Mono", Menlo, Consolas, monospace; }
  pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow: auto; }
  code { background: rgba(27,31,35,0.06); padding: 2px 6px; border-radius: 3px; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 4px solid #dfe2e5; color: #6a737d; margin: 0; padding: 0 12px; }
  table { border-collapse: collapse; }
  table th, table td { border: 1px solid #dfe2e5; padding: 6px 12px; }
  table tr:nth-child(2n) { background: #f6f8fa; }
  .toolbar { position: fixed; top: 12px; right: 12px; }
  .toolbar a { background: #0366d6; color: #fff; padding: 6px 12px; border-radius: 4px;
               text-decoration: none; font-size: 14px; margin-left: 8px; }
</style>
</head>
<body>
  <div class="toolbar">
    <a href="${artifactsHref}" target="_blank">查看证据与产物</a>
  </div>
${body}
</body>
</html>`;
}
