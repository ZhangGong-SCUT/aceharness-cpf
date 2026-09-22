#!/usr/bin/env node
/**
 * 拉取 DCP 门禁 codeCheck 失败明细（文件/行号/规则/代码片段）。
 *
 * 背景：dcp.openharmony.cn 被华为云 WAF 拦截（jsagent JS 挑战），
 * 纯 HTTP 请求全部返回 404 壳页；且门禁详情页路径不在服务器路由上（hash 路由 SPA）。
 * 但 WAF 挑战过掉后，codecheckAccess 族后端 API 是匿名可访问的。
 * 方案：用 playwright 无头浏览器执行 WAF JS 挑战，然后在页面上下文里直接调 API。
 *
 * 用法：
 *   node fetch-dcp-report.mjs --report-url <CI 评论里的 DCP 报告链接> --out outputs
 *   node fetch-dcp-report.mjs --event <eventId> --task <taskId> --out outputs
 *
 * 输出：outputs/dcp-codecheck-defects.json
 *   { ok, event_id, task_id, event_status, result, defect_count, defects: [{filepath, line, rule, message, fragment}] }
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DCP_ORIGIN = process.env.DCP_ORIGIN || 'https://dcp.openharmony.cn';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

function parseReportUrl(url) {
  const raw = String(url || '');
  const m = raw.match(/detail\/([0-9a-f]+)\/runlist(?:\?.*?taskId=([A-Za-z0-9_]+))?/);
  if (!m) return null;
  return { eventId: m[1], taskId: m[2] || '' };
}

async function main() {
  let eventId = String(arg('--event', ''));
  let taskId = String(arg('--task', ''));
  const reportUrl = String(arg('--report-url', ''));
  if (!eventId && reportUrl) {
    const parsed = parseReportUrl(reportUrl);
    if (parsed) {
      eventId = parsed.eventId;
      taskId = taskId || parsed.taskId;
    }
  }
  const outDir = resolve(arg('--out', 'outputs'));

  if (!eventId) {
    throw new Error('缺少 --report-url（CI 评论里的 DCP 链接）或 --event <eventId>');
  }

  const { chromium } = await import('playwright-core').catch(() => ({}));
  if (!chromium) {
    throw new Error('缺少 playwright-core 依赖，无法过华为云 WAF JS 挑战');
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(DCP_ORIGIN + '/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);

    const data = await page.evaluate(async ({ eventId, taskId }) => {
      const get = async (path) => {
        const res = await fetch(path, { headers: { Accept: 'application/json' } });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { }
        return { status: res.status, code: json?.code, data: json?.data ?? null };
      };
      const post = async (path, body) => {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { }
        return { status: res.status, code: json?.code, data: json?.data ?? null };
      };

      const event = await get(`/api/codecheckAccess/ci-portal/v1/event/${eventId}`);
      const uuid = event?.data?.uuid || '';
      const prMsg = Array.isArray(event?.data?.prMsg) ? event.data.prMsg[0] : null;
      let defects = null;
      let summary = null;
      if (uuid && taskId) {
        const body = {
          pageNum: 1,
          pageSize: 100,
          date: '',
          defectLevel: '',
          filePath: '',
          fileName: '',
          defectStatus: '0',
          ruleSystemTags: '',
          checkType: '',
          rule: '',
          trigger: '',
          defectContent: '',
          ruleName: '',
        };
        const task = await post(`/api/codecheckAccess/ci-portal/v1/event/${uuid}/codecheck/task/${taskId}`, body);
        defects = task?.data?.defects ?? null;
        summary = await post(`/api/codecheckAccess/ci-portal/v1/codecheck/event/${uuid}/task/${taskId}/issues/report`, { ...body, defectStatus: '' });
      }
      return {
        event_status: event.status,
        event_code: event.code,
        uuid,
        result: event?.data?.result ?? null,
        trigger_user: event?.data?.triggerUser ?? null,
        repo_branch: event?.data?.repoBranch ?? null,
        pr_url: prMsg?.url ?? null,
        head_commit: prMsg?.headCommitId ?? null,
        defects,
        summary: summary?.data ?? null,
      };
    }, { eventId, taskId });

    const flat = [];
    for (const defect of data.defects || []) {
      for (const detail of defect.defectDetailList || []) {
        flat.push({
          filepath: detail.filepath,
          line: Number(detail.lineNumber) || null,
          rule: detail.ruleName || detail.defectCheckerName || '',
          message: detail.defectContent || '',
          fragment: (detail.fragment || []).map((f) => ({ line: Number(f.line_num), text: f.line_content })),
        });
      }
    }

    const result = {
      ok: true,
      fetched_at: new Date().toISOString(),
      origin: DCP_ORIGIN,
      event_id: eventId,
      task_id: taskId || null,
      event_result: data.result,
      trigger_user: data.trigger_user,
      repo_branch: data.repo_branch,
      pr_url: data.pr_url,
      head_commit: data.head_commit,
      defect_count: flat.length,
      defects: flat,
      raw_summary: data.summary,
    };

    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, 'dcp-codecheck-defects.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
});
