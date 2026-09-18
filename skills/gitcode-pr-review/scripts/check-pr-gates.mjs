#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
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

/**
 * 检视建议等待决策判定：建议标记存在（mode=suggestion）且记录的 head_sha 与 PR 当前 head 一致。
 * head 漂移（用户等待期间又推送）→ false，走正常流程（意见可能已 stale）。
 */
export function detectReviewPendingDecision(suggestion, currentHead) {
  return Boolean(
    suggestion
    && suggestion.mode === 'suggestion'
    && suggestion.head_sha
    && currentHead
    && String(suggestion.head_sha).trim() === String(currentHead).trim()
  );
}

/**
 * 测试人已通过判定：GitCode PR 的 testers 非空且全部 accept=true（网页上"测试人 ✓ 已通过"）。
 * 测试人通过 = PR 已验证等待合入——监控推送代码会重置测试状态，不应再监控/修改。
 */
export function isTesterApproved(testers) {
  const list = Array.isArray(testers) ? testers : [];
  return list.length > 0 && list.every((t) => Boolean(t && t.accept));
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
  // AIWeb 用户人工指令检测：globalContext 含 user_fix_feedback:/user_revert:/user_apply_patch: 行 → phase 覆盖为 user_fix
  // （只在 globalContext 段内匹配，避免误中步骤结论文本里的字样；块样式 |- / >- 均可）
  let phaseOverride = '';
  try {
    const stateRaw = await readFile(resolve(outDir, '..', 'state.yaml'), 'utf8');
    const gc = /^globalContext:\s*[|>][+-]?\n([\s\S]*?)(?=\n[^\s])/m.exec(stateRaw)?.[1] || '';
    if (/^\s*user_(?:fix_feedback|revert|apply_patch):/m.test(gc)) phaseOverride = 'user_fix';
  } catch { /* 直跑脚本时无指令 */ }
  // 检视建议等待决策检测：本 run 已生成建议（review-suggestion.json）且 PR head 未变 → 等用户决策，不重新生成
  // （仅在正常分类为 ai_review_pending 时生效：用户自己推送过修复 → 意见已 stale → 走正常流程）
  let reviewSuggestion = null;
  try {
    reviewSuggestion = JSON.parse(await readFile(resolve(outDir, 'review-suggestion.json'), 'utf8'));
  } catch { /* 无建议标记 → 正常流程 */ }
  const reviewPendingDecision = detectReviewPendingDecision(reviewSuggestion, String(pull?.head?.sha || pull?.head?.id || '').trim());
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
    classified.summary = 'AIWeb 用户人工指令（按反馈修改/回退修复/应用建议），跳过门禁分类直达检视修复';
  }

  // 检视建议等待决策：建议已生成且 PR head 未变 → 挂起等用户在 AIWeb 决策，不要重新生成建议
  // （不依赖 phase=ai_review_pending：检视路由由分流检视步骤的 fetch-ai-review 驱动，
  //   check-pr-gates 的 phase 可能是 green/running 等；此处直接覆盖为 review_pending_decision，
  //   由 等待门禁→挂起 一步收口，避免唤醒后重走分流链重新生成建议烧 token）
  if (!phaseOverride && reviewPendingDecision && !closed && ownPr) {
    classified.phase = 'review_pending_decision';
    classified.summary = '检视建议修复已生成（未推送），等待用户在 AIWeb 面板决策：应用 / 驳回 / 反馈';
  }

  // 测试人已通过（网页"测试人 ✓ 已通过"）：PR 已验证等待合入，监控推送代码会重置测试状态 → 终止。
  // 排序在 review_pending_decision 之后：已生成建议挂起的 run，用户应用建议属知情选择（应用后测试重置），
  // 不被此规则阻断；新 run（无建议）则直接终止，不再生成建议。
  const testerApproved = isTesterApproved(pull?.testers);
  if (!phaseOverride && !reviewPendingDecision && testerApproved && !closed && ownPr) {
    classified.phase = 'tester_approved';
    classified.verdict = 'fail';
    classified.summary = `测试人已全部通过（${(Array.isArray(pull?.testers) ? pull.testers : []).map((t) => t?.login).filter(Boolean).join('、')}），等待合入即可——监控推送代码会重置测试状态`;
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

function isDirectRun() {
  // realpath 双向解析符号链接（skills 目录经 .aceharness 链接调用时 argv 与 import.meta.url 路径不一致）
  try {
    return realpathSync(resolve(process.argv[1] || '')) === realpathSync(resolve(new URL(import.meta.url).pathname));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}
