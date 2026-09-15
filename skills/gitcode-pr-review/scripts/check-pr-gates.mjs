#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { classifyOhosPrGates, commentBelongsToPull, DEFAULT_START_BUILD_MAX, DEFAULT_JITTER_RETRY_MAX, normalizeComments, normalizeLabels } from './ohos-pr-gates.mjs';
import { resolveGitcodeToken } from './gitcode-token.mjs';

const API_ROOT = process.env.GITCODE_API_ROOT || 'https://gitcode.com/api/v5';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

function parsePrUrl(url) {
  const match = String(url || '').match(/https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/(?:pulls?|merge_requests)\/(\d+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, ''), number: match[3] };
}

function parseNameList(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function repoFullName(repo) {
  if (!repo || typeof repo !== 'object') return '';
  return String(repo.full_name || repo.path_with_namespace || repo.full_path || repo.path || '').replace(/\.git$/i, '');
}

/**
 * 从 CI 评论正文里提取带 taskId 的 DCP codeCheck 报告链接（明细入口）。
 */
function extractCodecheckReportUrl(comments) {
  const blob = comments.map((item) => String(item.body || '')).join('\n');
  const withTask = blob.match(/https?:\/\/dcp\.openharmony\.cn[^\s)'"<>]*taskId=[A-Za-z0-9_]+/i);
  return withTask ? withTask[0] : '';
}

function hasStaticFailLabel(labels) {
  return labels.some((item) => /静态检查失败/.test(String(item || '')));
}

/**
 * 静态失败时先拉 DCP codeCheck 明细（fetch-dcp-report.mjs 过 WAF）。
 * 拉到 defect_count>0 → 真实缺陷，跳过抖动重试直接进静态修复；
 * 拉不到（无 taskId 链接 / 网络失败 / ACE_GITCODE_DCP_REPORT=0）→ 保持重试回退。
 */
async function fetchDcpDefectCount(comments, labels, outDir) {
  if (process.env.ACE_GITCODE_DCP_REPORT === '0') return 0;
  if (!hasStaticFailLabel(labels)) return 0;
  const reportUrl = extractCodecheckReportUrl(comments);
  if (!reportUrl) return 0;
  try {
    const script = resolve(new URL(import.meta.url).pathname, '../fetch-dcp-report.mjs');
    await new Promise((fulfil, reject) => {
      const child = spawn(process.execPath, [script, '--report-url', reportUrl, '--out', outDir], {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 90000,
      });
      let err = '';
      child.stderr?.on('data', (chunk) => { err += String(chunk); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) fulfil(undefined);
        else reject(new Error(`fetch-dcp-report 退出 ${code}: ${err.slice(0, 200)}`));
      });
    });
    const raw = await readFile(resolve(outDir, 'dcp-codecheck-defects.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Number(parsed?.defect_count || 0);
  } catch {
    return 0;
  }
}

async function gitcodeGet(path, token) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${API_ROOT}${path}${token ? `${separator}access_token=${encodeURIComponent(token)}` : ''}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const error = new Error(`${response.status} ${url} ${text.slice(0, 300)}`);
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

async function gitcodeGetOptional(path, token) {
  try {
    return await gitcodeGet(path, token);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function collectLabels(...sources) {
  const labels = [];
  for (const source of sources) {
    if (!source) continue;
    if (Array.isArray(source)) labels.push(...source);
    else if (Array.isArray(source.labels)) labels.push(...source.labels);
    else if (Array.isArray(source.issue_labels)) labels.push(...source.issue_labels);
  }
  return normalizeLabels(labels);
}

async function fetchCommentPages(path, token) {
  const pages = [];
  for (const page of [1, 2, 3]) {
    const batch = await gitcodeGetOptional(`${path}?page=${page}&per_page=100`, token);
    if (!Array.isArray(batch) || batch.length === 0) break;
    pages.push(...batch);
    if (batch.length < 100) break;
  }
  return pages;
}

function mergeComments(...groups) {
  const seen = new Set();
  const out = [];
  for (const item of groups.flat()) {
    if (!item || typeof item !== 'object') continue;
    const key = String(
      item.id
      || item.node_id
      || `${item.user?.login || item.user?.username || ''}|${item.body || ''}|${item.created_at || ''}`,
    );
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function main() {
  const prUrl = arg('--pr-url');
  const parsed = parsePrUrl(prUrl);
  const owner = arg('--owner', parsed?.owner || '');
  const repo = arg('--repo', parsed?.repo || '');
  const number = arg('--number', parsed?.number || '');
  const outDir = resolve(arg('--out', 'outputs'));
  const authorHint = arg('--author');
  const token = arg('--token', resolveGitcodeToken(process.env, authorHint));
  const allowedAuthors = parseNameList(process.env.ACE_GITCODE_PR_AUTHOR);

  if (!owner || !repo || !number) {
    throw new Error('缺少 owner/repo/number，或传入 --pr-url');
  }

  const pullPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`;
  const issuePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}`;
  const pull = await gitcodeGet(pullPath, token);
  const issue = await gitcodeGetOptional(issuePath, token);
  const labelPayload = await gitcodeGetOptional(`${issuePath}/labels`, token);
  const [issueComments, pullComments] = await Promise.all([
    fetchCommentPages(`${issuePath}/comments`, token),
    fetchCommentPages(`${pullPath}/comments`, token),
  ]);
  const commentPages = mergeComments(issueComments, pullComments).filter(commentBelongsToPull);

  const author = String(pull.user?.login || pull.user?.username || pull.author?.username || '').trim();
  // manual-start-by 豁免：AIWeb 手动开启的监控（globalContext 注入标记，从 run 的 state.yaml 读取）
  // 白名单（ACE_GITCODE_PR_AUTHOR）只约束 webhook 自动启动；手动模式校验"PR 作者 = 手动开启者"。
  let manualStartBy = '';
  try {
    const stateRaw = await readFile(resolve(outDir, '..', 'state.yaml'), 'utf8');
    // 允许缩进（globalContext 下的嵌套键），但排除列表项 "- " 前缀
    const m = stateRaw.match(/^(?!- )[ \t]*manual-start-by:[ \t]*(\S+)[ \t]*$/m);
    if (m) manualStartBy = m[1].toLowerCase();
  } catch { /* state.yaml 不存在（直跑脚本）时无豁免 */ }
  // AIWeb 用户人工指令检测：globalContext 含 user_fix_feedback:/user_revert: 行 → phase 覆盖为 user_fix
  // （只在 globalContext 段内匹配，避免误中步骤结论文本里的字样）
  let phaseOverride = '';
  try {
    const stateRaw = await readFile(resolve(outDir, '..', 'state.yaml'), 'utf8');
    const gc = /^globalContext: >-\n([\s\S]*?)(?=\n[^\s])/m.exec(stateRaw)?.[1] || '';
    if (/^\s*user_(?:fix_feedback|revert):/m.test(gc)) phaseOverride = 'user_fix';
  } catch { /* 直跑脚本时无指令 */ }
  const ownPr = manualStartBy
    ? manualStartBy === author.toLowerCase()      // 手动模式：PR 作者必须 = 手动开启者
    : (allowedAuthors.length === 0
        ? true
        : allowedAuthors.includes(author.toLowerCase()));
  const state = String(pull.state || '').toLowerCase();
  const merged = Boolean(pull.merged) || state === 'merged';
  const closed = state === 'closed' || merged;
  const headRepo = repoFullName(pull.head?.repo)
    || repoFullName(pull.head)
    || repoFullName(pull.source)
    || '';
  const labels = collectLabels(pull, issue, labelPayload);
  const dcpDefectCount = await fetchDcpDefectCount(normalizeComments(commentPages), labels, outDir);
  const classified = classifyOhosPrGates({
    labels,
    comments: normalizeComments(commentPages),
    pull,
    state,
    merged,
    closed,
    own_pr: ownPr,
    dcp_defect_count: dcpDefectCount,
    start_build_max: Number(process.env.ACE_GITCODE_START_BUILD_MAX || 0)
      || DEFAULT_START_BUILD_MAX,
    jitter_retry_max: Number(process.env.ACE_GITCODE_JITTER_RETRY_MAX || 0)
      || DEFAULT_JITTER_RETRY_MAX,
  });

  if (phaseOverride && !closed && ownPr) {
    classified.phase = phaseOverride;
    classified.summary = 'AIWeb 用户人工指令（按反馈修改/回退修复），跳过门禁分类直达检视修复';
  }

  const result = {
    ...classified,
    pr_url: prUrl || `https://gitcode.com/${owner}/${repo}/merge_requests/${number}`,
    owner,
    repo,
    number,
    author,
    head_repo: headRepo,
    head_ref: pull.head?.ref || pull.head_branch || pull.source_branch || '',
    head_sha: pull.head?.sha || pull.head?.id || '',
    base_ref: pull.base?.ref || pull.base_branch || pull.target_branch || '',
    checked_at: new Date().toISOString(),
    source: 'labels+comments',
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'gate-check.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.verdict === 'fail' && (closed || !ownPr)) process.exit(2);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
});
