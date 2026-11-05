/**
 * 全局配置管理
 * 所有可配置项通过环境变量注入，提供类型化默认值
 */

import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import path from 'node:path';

// 加载 .env 文件中的环境变量（必须在读取 process.env 之前执行）
// .env 位于项目根目录（Server 的上一级）
const _dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(_dirname, '..', '..', '.env') });

const config = {
    // ─── HTTP 服务 ────────────────────────────────────────────────────────────
    port: parseInt(process.env.PORT || '3000'),
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',

    // ─── 数据存储根目录 ────────────────────────────────────────────────────────
    // 数据与代码分离：所有数据库、产物、日志统一存储在项目根目录的 db/
    // 环境变量优先，默认指向 ../../../db/issueanalysis/ (相对于 Server/library/config.js)
    issueanalysisRoot: process.env.ISSUEANALYSIS_ROOT
        ? process.env.ISSUEANALYSIS_ROOT
        : fileURLToPath(new URL('../../../db/issueanalysis', import.meta.url)),

    // ─── AceHarness 工作流服务 ─────────────────────────────────────────────────
    // Issue 分析的实际处理能力由 AceHarness 提供，当前系统仅做代理和前端展示
    // 详见 ACEHarness/docs/workflow-api-spec.md
    // ⚠️ 安全：email/password 必须通过环境变量注入，禁止硬编码
    aceharness: {
        baseUrl: process.env.ACEHARNESS_BASE_URL || 'https://cpf-manager.xyz',
        // API 调用地址：AceHarness 与本服务同机部署，直连本机绕过公网回环
        // （公网域名走 Cloudflare 隧道，存在 IPv6/网络波动导致请求超时的风险）
        // 展示类链接（workbenchUrl 跳转）仍使用公网 baseUrl
        apiBaseUrl: process.env.ACEHARNESS_API_BASE_URL || 'http://127.0.0.1:3031',
        email: process.env.ACEHARNESS_EMAIL || '',
        password: process.env.ACEHARNESS_PASSWORD || '',
        // 默认工作流配置文件（Issue 诊断，带 vision-look MCP 看图能力）
        configFile: process.env.ACEHARNESS_CONFIG_FILE || 'cpf-ohos-diagnosis.yaml',
        // A02：Issue 分析入口允许用户指定的工作流配置白名单（逗号分隔）。
        // 用户传入的 configFile 必须命中白名单，否则在创建任务前拒绝——
        // 防止借服务身份启动任意工作流配置。仅含文件名，不允许路径分隔符。
        allowedDiagnosisConfigFiles: (process.env.ACEHARNESS_ALLOWED_DIAGNOSIS_CONFIGS || 'cpf-ohos-diagnosis.yaml')
            .split(',').map(s => s.trim()).filter(Boolean),
        // PR 监控评审工作流配置文件
        prReviewConfigFile: process.env.ACEHARNESS_PR_REVIEW_CONFIG_FILE || 'gitcode-pr-review.yaml',
        // 管理员凭证（AIWeb 注册免审核用）：优先专用凭证，回退服务凭证
        // 用它调用 AceHarness POST /api/users 直接创建 active 用户；
        // 未配置时 AIWeb 注册将降级为普通注册（需 AceHarness 管理员审核）
        adminEmail: process.env.ACEHARNESS_ADMIN_EMAIL || '',
        adminPassword: process.env.ACEHARNESS_ADMIN_PASSWORD || '',
        // HTTP 请求超时
        timeoutMs: parseInt(process.env.ACEHARNESS_TIMEOUT_MS || '600000'), // 10min
        // 前端轮询间隔（ms）
        pollIntervalMs: parseInt(process.env.ACEHARNESS_POLL_INTERVAL_MS || '3000'),
        // 轮询最大时长（ms），超过后停止轮询
        pollMaxDurationMs: parseInt(process.env.ACEHARNESS_POLL_MAX_DURATION_MS || '3600000'), // 60min
    },
    // ─── OpenCode CLI ─────────────────────────────────────────────────────────
    opencode: {
        host: process.env.OPENCODE_HOST || 'localhost',
        port: process.env.OPENCODE_PORT || '4096',
    },

    // ─── GitHub Copilot CLI ───────────────────────────────────────────────────
    copilot: {
        ghCommand: process.env.GH_COMMAND || 'gh',
    },

    // ─── GitCode / Gitee Token ────────────────────────────────────────────────
    // 用于代码检视 Skill 调用平台 API（获取 PR 详情、变更文件等）
    // 私有仓库需在环境变量中配置 GITCODE_TOKEN，留空时以匿名方式调用
    // ⚠️ 安全：禁止硬编码 Token，必须通过环境变量注入
    gitcodeToken: process.env.GITCODE_TOKEN || '',

    // ─── 轮询配置 ─────────────────────────────────────────────────────────────
    polling: {
        // 自适应轮询：初始间隔 → 最大间隔，逐步增长以减少资源占用
        initialIntervalMs: parseInt(process.env.POLLING_INITIAL_INTERVAL_MS || '2000'),  // 初始 2s
        maxIntervalMs: parseInt(process.env.POLLING_MAX_INTERVAL_MS || '12000'),          // 最大 12s
        growthFactor: parseFloat(process.env.POLLING_GROWTH_FACTOR || '1.5'),            // 增长倍数
        issueanalysisTimeoutMs: parseInt(process.env.ISSUEANALYSIS_TIMEOUT_MS || '1800000'), // 30 min（单 Issue 分析相对轻量）
    },

    // ─── 重试 ─────────────────────────────────────────────────────────────────
    maxPortingRetries: parseInt(process.env.MAX_PORTING_RETRIES || '3'),

    // ─── 日志 ─────────────────────────────────────────────────────────────────
    logLevel: process.env.LOG_LEVEL || 'info',

    // ─── SSE ──────────────────────────────────────────────────────────────────
    sseHeartbeatMs: parseInt(process.env.SSE_HEARTBEAT_MS || '25000'),
    sseMaxSubscribersPerTask: parseInt(process.env.SSE_MAX_SUBSCRIBERS_PER_TASK || '15'),  // 每任务最大连接
    sseMaxSubscribersPerUser: parseInt(process.env.SSE_MAX_SUBSCRIBERS_PER_USER || '10'),   // 每用户最大连接（需覆盖多任务并发+页面刷新重连）

    // ─── 并发控制 ────────────────────────────────────────────────────────────
    maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS || '12'),              // 任务最大并发
    taskQueueSize: parseInt(process.env.TASK_QUEUE_SIZE || '20'),                      // 任务队列容量
    maxConcurrentIssueAnalysisTasks: parseInt(process.env.MAX_CONCURRENT_ISSUEANALYSIS_TASKS || '3'), // Issue 分析最大并发
    issueAnalysisQueueSize: parseInt(process.env.ISSUEANALYSIS_QUEUE_SIZE || '20'),          // Issue 分析队列容量
    // ─── 全局 Session 并发控制 ──────────────────────────────────────────────────
    // 所有任务类型共享的最大并发 OpenCode Session 数，保护服务端不过载
    maxConcurrentSessions: parseInt(process.env.MAX_CONCURRENT_SESSIONS || '50'),
    // acquire() 等待槽位的最大时间（毫秒），超时后抛出 SemaphoreTimeoutError，0 表示不超时
    semaphoreAcquireTimeoutMs: parseInt(process.env.SEMAPHORE_ACQUIRE_TIMEOUT_MS || '3000000'),  // 默认 50 分钟
};

// issueanalysisRoot 兜底：确保是字符串
if (typeof config.issueanalysisRoot !== 'string') {
    config.issueanalysisRoot = './issueanalysis';
}
// ─── 启动安全检查 ─────────────────────────────────────────────────────────────
// ⚠️ 生产环境必须配置 GITCODE_TOKEN，否则私有仓库检视会失败
if (!config.gitcodeToken) {
    console.warn('⚠️ [安全警告] GITCODE_TOKEN 未配置，私有仓库检视功能将受限');
    console.warn('   请在环境变量中设置: GITCODE_TOKEN=<your_token>');
}

// ⚠️ 并发配置检查
if (config.maxConcurrentTasks > 20) {
    console.warn(`⚠️ [性能警告] maxConcurrentTasks=${config.maxConcurrentTasks} 过大，建议不超过 20`);
}

export default config;
