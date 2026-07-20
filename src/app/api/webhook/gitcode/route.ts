import { NextRequest, NextResponse } from 'next/server';
import { workflowRegistry } from '@/lib/workflow/registry';
import { createRun } from '@/lib/run/store';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { randomUUID } from 'crypto';
import { parse } from 'yaml';
import { getRuntimeWorkflowConfigPath } from '@/lib/run/runtime-configs';
import { getWorkspaceRoot } from '@/lib/core/app-paths';

/**
 * GitCode Webhook 接收端点
 *
 * 功能：
 * 1. 接收 GitCode Issue 创建/更新 webhook 事件
 * 2. 自动触发 cpf-ohos-diagnosis 工作流
 * 3. 工作流完成后将诊断报告回写到 Issue 评论
 *
 * 配置方式（参照 CPF-Manager 的 webhook 实现）：
 * 在 GitCode 仓库设置 → Webhooks 中添加：
 *   URL: http://<your-server>:3000/api/webhook/gitcode
 *   Content-Type: application/json
 *   Secret: <自定义密钥，与下方 WEBHOOK_SECRET 环境变量一致>
 *   触发事件: Issue events
 *
 * 环境变量：
 *   WEBHOOK_SECRET: webhook 密钥（用于验证请求来源）
 *   GITCODE_ACCESS_TOKEN: GitCode API token（用于回写评论）
 *   WEBHOOK_CONFIG_FILE: 工作流配置文件名（默认 cpf-ohos-diagnosis.yaml）
 *   WEBHOOK_DEFAULT_USER_ID: 默认用户 ID（用于创建 run，需要是系统中的用户）
 *
 * GitCode webhook 事件头（参照 CPF-Manager）：
 *   x-gitcode-event: 事件类型（如 "Issue Hook"）
 *   x-hub-signature-256: HMAC 签名（可选验证）
 *
 * GitCode webhook 数据格式（参照 CPF-Manager 的 object_attributes 结构）：
 *   {
 *     "object_attributes": {
 *       "action": "open",
 *       "number": 1,
 *       "title": "Issue 标题",
 *       "description": "Issue 正文",
 *       "state": "opened",
 *       "url": "https://gitcode.com/...",
 *       "created_at": "2026-07-09T..."
 *     },
 *     "project": {
 *       "namespace": "owner",
 *       "name": "repo",
 *       "path_with_namespace": "owner/repo"
 *     },
 *     "repository": {
 *       "full_name": "owner/repo",
 *       "name": "repo"
 *     }
 *   }
 */

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const GITCODE_ACCESS_TOKEN = process.env.GITCODE_ACCESS_TOKEN || '';
const WEBHOOK_CONFIG_FILE = process.env.WEBHOOK_CONFIG_FILE || 'cpf-ohos-diagnosis.yaml';
const WEBHOOK_DEFAULT_USER_ID = process.env.WEBHOOK_DEFAULT_USER_ID || '';

interface GitCodeWebhookPayload {
  // GitCode webhook 标准格式（参照 CPF-Manager）
  object_attributes?: {
    action?: string; // "open" | "close" | "reopen" | "update"
    number?: number | string;
    iid?: number | string; // GitCode uses iid for issue numbers
    title?: string;
    description?: string;
    body?: string;
    state?: string;
    url?: string;
    html_url?: string;
    created_at?: string;
  };
  project?: {
    namespace?: string;
    name?: string;
    path_with_namespace?: string;
  };
  repository?: {
    full_name?: string;
    name?: string;
    namespace?: string;
  };
  // 兼容直接传 issue 对象的格式
  issue?: {
    number: number | string;
    title: string;
    body: string;
    state: string;
    html_url: string;
    created_at: string;
    user: { login: string };
    repository?: { full_name: string };
  };
  action?: string;
}

/**
 * 验证 webhook 签名（参照 CPF-Manager 的 x-hub-signature-256 验证）
 */
function verifyWebhookSecret(request: NextRequest): boolean {
  if (!WEBHOOK_SECRET) {
    // 如果没有配置 secret，跳过验证（仅用于开发环境）
    return true;
  }
  // GitCode webhook 使用 x-hub-signature-256 头（参照 CPF-Manager）
  const signature = request.headers.get('x-hub-signature-256') || request.headers.get('x-gitcode-token') || '';
  return signature === WEBHOOK_SECRET;
}

/**
 * 获取默认用户信息（用于创建 run）
 */
function getDefaultUser(): { id: string; username: string; personalDir: string } | null {
  if (!WEBHOOK_DEFAULT_USER_ID) {
    // 尝试从 tokens.json 获取第一个用户
    try {
      const tokensPath = join(getWorkspaceRoot(), 'data', 'tokens.json');
      if (existsSync(tokensPath)) {
        const tokens = JSON.parse(readFileSync(tokensPath, 'utf-8'));
        if (Array.isArray(tokens) && tokens.length > 0) {
          const userId = tokens[0][1]?.userId;
          if (userId) {
            const usersPath = join(getWorkspaceRoot(), 'data', 'users.json');
            if (existsSync(usersPath)) {
              const users = JSON.parse(readFileSync(usersPath, 'utf-8'));
              const user = Array.isArray(users) ? users.find((u: any) => u.id === userId) : users[userId];
              if (user) {
                return { id: user.id, username: user.username, personalDir: user.personalDir || '' };
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return null;
  }
  // 从 users.json 查找指定用户
  try {
    const usersPath = join(getWorkspaceRoot(), 'data', 'users.json');
    if (existsSync(usersPath)) {
      const users = JSON.parse(readFileSync(usersPath, 'utf-8'));
      const user = Array.isArray(users) ? users.find((u: any) => u.id === WEBHOOK_DEFAULT_USER_ID) : users[WEBHOOK_DEFAULT_USER_ID];
      if (user) {
        return { id: user.id, username: user.username, personalDir: user.personalDir || '' };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 回写诊断报告到 GitCode Issue 评论
 * 参照 CPF-Manager 的 GitCodeApiClient，使用 access_token URL 参数方式调用 API
 */
async function postCommentToGitCodeIssue(
  owner: string,
  repo: string,
  issueNumber: string,
  commentBody: string,
): Promise<boolean> {
  if (!GITCODE_ACCESS_TOKEN) {
    console.error('[webhook/gitcode] GITCODE_ACCESS_TOKEN not configured, cannot post comment');
    return false;
  }

  // 参照 CPF-Manager 的 GitCodeApiClient：使用 access_token 作为 URL 参数
  const apiUrl = `https://gitcode.com/api/v5/repos/${owner}/${repo}/issues/${issueNumber}/comments?access_token=${GITCODE_ACCESS_TOKEN}`;
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        body: commentBody,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[webhook/gitcode] Failed to post comment: ${response.status} ${errorText}`);
      return false;
    }

    console.log(`[webhook/gitcode] Comment posted to ${owner}/${repo}#${issueNumber}`);
    return true;
  } catch (error: any) {
    console.error(`[webhook/gitcode] Error posting comment:`, error.message);
    return false;
  }
}

/**
 * 从 Issue URL 解析 owner/repo/number
 */
function parseIssueUrl(url: string): { owner: string; repo: string; number: string } | null {
  // https://gitcode.com/{owner}/{repo}/issues/{number}
  const match = url.match(/gitcode\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (match) {
    return { owner: match[1], repo: match[2], number: match[3] };
  }
  return null;
}

/**
 * 读取诊断报告并回写到 GitCode Issue 评论
 *
 * 报告查找优先级：
 * 1. step-logs/报告沉淀-生成诊断报告-*.md — reporter agent 的完整诊断报告（含根因+修复建议）
 * 2. 报告沉淀-生成诊断报告.md — reporter agent 的摘要输出（仅结论）
 * 3. 拼接所有阶段输出 — 兜底方案
 */
async function postReportComment(
  runId: string,
  issueInfo: { owner: string; repo: string; number: string; title: string; url: string },
  status: string,
): Promise<void> {
  const runDir = join(getWorkspaceRoot(), 'runs', runId);
  const outputsDir = join(runDir, 'outputs');
  const stepLogsDir = join(outputsDir, 'step-logs');

  let reportContent = '';

  // 优先级 1：从 step-logs 中查找报告沉淀的完整输出（含根因分析+修复建议全文）
  if (existsSync(stepLogsDir)) {
    const { readdir } = await import('fs/promises');
    const stepFiles = await readdir(stepLogsDir);
    // 查找报告沉淀的 step-log 文件（包含完整诊断报告）
    const reportStepFile = stepFiles.find(f => f.startsWith('报告沉淀') && f.endsWith('.md'));
    if (reportStepFile) {
      let rawContent = readFileSync(join(stepLogsDir, reportStepFile), 'utf-8');
      // 截掉 <step-conclusion> 标签及其后面的内容（工作流内部元数据，不应出现在报告中）
      const conclusionIdx = rawContent.indexOf('<step-conclusion>');
      if (conclusionIdx > 0) {
        rawContent = rawContent.substring(0, conclusionIdx).trimEnd();
      }
      // 同时截掉结尾的裁决 JSON 块（```json ... ```）
      rawContent = rawContent.replace(/```json\s*\{[\s\S]*?"verdict"[\s\S]*?\}\s*```/g, '').trimEnd();
      reportContent = rawContent;
    }
  }

  // 优先级 2：查找摘要报告文件
  if (!reportContent) {
    const possibleReports = [
      'diagnosis-report-issue-1.md',
      '报告沉淀-生成诊断报告.md',
    ];
    for (const name of possibleReports) {
      const path = join(outputsDir, name);
      if (existsSync(path)) {
        reportContent = readFileSync(path, 'utf-8');
        break;
      }
    }
  }

  // 优先级 3：拼接所有阶段的摘要输出（根因分析 + 修复建议 + 报告沉淀 + 完成）
  if (!reportContent) {
    if (existsSync(outputsDir)) {
      const { readdir } = await import('fs/promises');
      const files = await readdir(outputsDir);
      // 按阶段顺序拼接关键输出文件
      const stageOrder = ['根因分析', '修复建议', '报告沉淀', '完成'];
      const parts: string[] = [];
      for (const stage of stageOrder) {
        const file = files.find(f => f.startsWith(stage) && f.endsWith('.md') && !f.includes('step-logs'));
        if (file) {
          const content = readFileSync(join(outputsDir, file), 'utf-8');
          parts.push(`## ${stage}\n\n${content}`);
        }
      }
      if (parts.length > 0) {
        reportContent = parts.join('\n\n---\n\n');
      }
    }
  }

  if (!reportContent) {
    reportContent = `工作流已完成（状态: ${status}），但未找到诊断报告文件。请到 ACEHarness 查看完整结果。\n\nRun ID: ${runId}`;
  }

  // 构造评论内容
  const commentBody = `## 🤖 ACEHarness 自动诊断报告

> 本报告由 ACEHarness 自动诊断工作流生成，Issue 创建后自动触发。

**Issue**: ${issueInfo.title}
**诊断状态**: ${status === 'completed' ? '✅ 完成' : '❌ ' + status}
**诊断时间**: ${new Date().toISOString()}

---

${reportContent}

---

> 由 [ACEHarness](http://127.0.0.1:3000) 自动生成`;

  // 回写到 GitCode Issue 评论
  await postCommentToGitCodeIssue(issueInfo.owner, issueInfo.repo, issueInfo.number, commentBody);
}

/**
 * 监控工作流完成并回写评论
 */
async function monitorAndComment(
  runId: string,
  configFile: string,
  issueInfo: { owner: string; repo: string; number: string; title: string; url: string },
  userId: string,
): Promise<void> {
  const maxWaitMs = 4 * 60 * 60 * 1000; // 最多等待 4 小时（工作流可能耗时 3+ 小时）
  const pollIntervalMs = 30 * 1000; // 每 30 秒检查一次
  const startTime = Date.now();

  console.log(`[webhook/gitcode] Monitoring run ${runId} for issue ${issueInfo.owner}/${issueInfo.repo}#${issueInfo.number}`);

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      // Use getManagerByRunId to get the specific manager for this run
      // (supports parallel runs — each run has its own manager instance)
      const manager = await workflowRegistry.getManagerByRunId(runId);
      if (!manager) {
        console.warn(`[webhook/gitcode] Manager not found for run ${runId}, may have been cleaned up`);
        // Try to read the run state directly to check if it completed
        const runStatePath = join(getWorkspaceRoot(), 'runs', runId, 'summary.json');
        if (existsSync(runStatePath)) {
          const runState = JSON.parse(readFileSync(runStatePath, 'utf-8'));
          if (runState.status === 'completed' || runState.status === 'failed' || runState.status === 'crashed') {
            console.log(`[webhook/gitcode] Run ${runId} finished (from state file) with status: ${runState.status}`);
            await postReportComment(runId, issueInfo, runState.status);
            return;
          }
        }
        continue;
      }
      const status = manager.getStatus();

      if (status.status === 'completed' || status.status === 'failed' || status.status === 'crashed') {
        console.log(`[webhook/gitcode] Run ${runId} finished with status: ${status.status}`);
        await postReportComment(runId, issueInfo, status.status);
        return;
      }
    } catch (error: any) {
      console.error(`[webhook/gitcode] Error monitoring run ${runId}:`, error.message);
    }
  }

  console.log(`[webhook/gitcode] Monitoring timeout for run ${runId}`);
}

export async function POST(request: NextRequest) {
  // 验证 webhook 密钥（参照 CPF-Manager 的 x-hub-signature-256 验证）
  if (!verifyWebhookSecret(request)) {
    return NextResponse.json({ error: 'Invalid webhook secret' }, { status: 401 });
  }

  // 获取事件类型（参照 CPF-Manager 的 x-gitcode-event 头）
  const eventType = request.headers.get('x-gitcode-event') || '';

  try {
    const payload: GitCodeWebhookPayload = await request.json();

    // 解析 webhook 数据（参照 CPF-Manager 的 object_attributes 结构）
    let issueNumber: string = '';
    let issueTitle: string = '';
    let issueBody: string = '';
    let issueUrl: string = '';
    let issueCreatedAt: string = '';
    let action: string = '';
    let owner: string = '';
    let repo: string = '';

    if (payload.object_attributes) {
      // GitCode 标准 webhook 格式（object_attributes 结构，参照 CPF-Manager）
      const obj = payload.object_attributes;
      action = obj.action || '';
      issueNumber = String(obj.iid || obj.number || '');
      issueTitle = obj.title || '';
      issueBody = obj.description || obj.body || '';
      issueUrl = obj.url || obj.html_url || '';
      issueCreatedAt = obj.created_at || '';

      // 从 project 或 repository 解析 owner/repo
      if (payload.project?.namespace && payload.project?.name) {
        owner = payload.project.namespace;
        repo = payload.project.name;
      } else if (payload.repository?.full_name) {
        const parts = payload.repository.full_name.split('/');
        owner = parts[0];
        repo = parts[1];
      }
    } else if (payload.issue) {
      // 兼容直接传 issue 对象的格式
      action = payload.action || 'opened';
      issueNumber = String(payload.issue.number);
      issueTitle = payload.issue.title;
      issueBody = payload.issue.body;
      issueUrl = payload.issue.html_url;
      issueCreatedAt = payload.issue.created_at;

      if (payload.repository?.full_name) {
        const parts = payload.repository.full_name.split('/');
        owner = parts[0];
        repo = parts[1];
      } else if (payload.issue.repository?.full_name) {
        const parts = payload.issue.repository.full_name.split('/');
        owner = parts[0];
        repo = parts[1];
      }
    }

    // 只处理 Issue 相关事件
    if (!issueNumber) {
      return NextResponse.json({ message: 'Not an issue event, ignored', eventType }, { status: 200 });
    }

    // 只处理新建 Issue（action = "open" 或 "opened"）
    // 参照 CPF-Manager：只处理 open/reopen
    if (action && action !== 'open' && action !== 'opened' && action !== 'reopen') {
      return NextResponse.json({ message: `Action "${action}" ignored, only "open/opened/reopen" triggers diagnosis` }, { status: 200 });
    }

    // 如果无法从 payload 解析 owner/repo，尝试从 URL 解析
    if (!owner || !repo) {
      const parsed = parseIssueUrl(issueUrl);
      if (parsed) {
        owner = parsed.owner;
        repo = parsed.repo;
      }
    }

    if (!owner || !repo) {
      return NextResponse.json({ error: 'Cannot determine repository owner/repo from webhook payload' }, { status: 400 });
    }

    console.log(`[webhook/gitcode] Issue #${issueNumber} received: ${issueTitle} (${owner}/${repo}), event: ${eventType}, action: ${action}`);

    // 获取默认用户
    const user = getDefaultUser();
    if (!user) {
      return NextResponse.json({ error: 'No default user configured. Set WEBHOOK_DEFAULT_USER_ID or ensure tokens.json has a valid user.' }, { status: 500 });
    }

    // 构造 globalContext
    const globalContext = `GitCode Issue 链接：${issueUrl}`;

    // 读取工作流配置
    const configPath = await getRuntimeWorkflowConfigPath(WEBHOOK_CONFIG_FILE);
    const raw = await readFile(configPath, 'utf-8');
    const config = parse(raw) as any;

    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    // 创建 run 记录
    await createRun({
      id: runId,
      configFile: WEBHOOK_CONFIG_FILE,
      configName: config?.workflow?.name || WEBHOOK_CONFIG_FILE,
      startTime: now,
      endTime: now,
      status: 'running',
      currentPhase: '信息采集',
      totalSteps: 0,
      completedSteps: 0,
    });

    // 为此 run 创建独立的 workflow manager 实例（支持多 Issue 并行）
    // 每个 run 拥有独立的引擎执行锁，不会互相阻塞
    const manager = await workflowRegistry.createManagerForRun(WEBHOOK_CONFIG_FILE, runId);

    // 设置用户信息
    (manager as any)._createdBy = user.id;
    (manager as any)._createdByName = user.username;
    (manager as any)._userPersonalDir = user.personalDir;
    (manager as any)._initialContexts = {
      globalContext,
      phaseContexts: {},
    };
    (manager as any)._rootRunId = runId;

    // 异步启动工作流
    Promise.resolve((manager as any).start(WEBHOOK_CONFIG_FILE, undefined, undefined, { globalContext, phaseContexts: {} }, runId))
      .catch((err: any) => {
        console.error(`[webhook/gitcode] Workflow start failed:`, err.message);
      });

    // 异步监控工作流完成并回写评论
    const issueInfo = { owner, repo, number: issueNumber, title: issueTitle, url: issueUrl };
    monitorAndComment(runId, WEBHOOK_CONFIG_FILE, issueInfo, user.id).catch((err: any) => {
      console.error(`[webhook/gitcode] Monitor error:`, err.message);
    });

    console.log(`[webhook/gitcode] Workflow started: runId=${runId}, issue=${owner}/${repo}#${issueNumber}`);

    return NextResponse.json({
      success: true,
      message: '诊断工作流已启动，完成后将自动回写报告到 Issue 评论',
      runId,
      issue: {
        number: issueNumber,
        title: issueTitle,
        url: issueUrl,
        repository: `${owner}/${repo}`,
      },
    });
  } catch (error: any) {
    console.error('[webhook/gitcode] Error:', error.message);
    return NextResponse.json({ error: 'Webhook 处理失败', message: error.message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return NextResponse.json({
    endpoint: '/api/webhook/gitcode',
    method: 'POST',
    description: 'GitCode Issue Webhook 接收端点，自动触发诊断工作流并回写报告',
    config: {
      webhookSecret: WEBHOOK_SECRET ? '已配置' : '未配置（开发模式）',
      gitcodeToken: GITCODE_ACCESS_TOKEN ? '已配置' : '未配置',
      configFile: WEBHOOK_CONFIG_FILE,
      defaultUserId: WEBHOOK_DEFAULT_USER_ID || '自动选择第一个用户',
    },
  });
}
