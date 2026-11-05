#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { commentBelongsToPull, commentTimeLE, selectActionableReviews } from './ohos-pr-gates.mjs';
import { gitcodeRead, gitcodeReadPages } from './gitcode-read.mjs';
import { resolveGitcodeToken } from './gitcode-token.mjs';

export function assertReviewOutputDir(outDir) {
  const outputParent = basename(resolve(outDir, '..'));
  if (outputParent === '_template' || basename(resolve(outDir)) === '_template') {
    throw new Error('拒绝把检视产物写入共享模板 _template。本次 run 必须使用自己的隔离目录。');
  }
}

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

const gitcodeGet = gitcodeRead;
const gitcodeGetAll = (path, token) => gitcodeReadPages(path, token, { optional: true });

function normalizeComment(item, source) {
  return {
    source,
    id: item.id || item.node_id || '',
    author: item.user?.login || item.author?.username || '',
    path: item.path || item.filename || '',
    line: item.line || item.original_line || '',
    body: String(item.body || '').trim(),
    html_url: item.html_url || item.url || '',
    created_at: String(item.created_at || item.updated_at || ''),
    ai_review: false,
  };
}

function dedupeKey(item, index) {
  return item.id || `${item.source}:${index}:${item.author}:${item.body.slice(0, 40)}`;
}

function toArtifactComment(item) {
  return { ...item, ai_review: item.kind === 'ai_review' };
}

function markdownList(items, startIndex = 1) {
  return items.flatMap((item, index) => [
    `## ${startIndex + index}. ${item.kind === 'ai_review' ? '[AI 检视] ' : item.kind === 'diff_comment' ? '[行内评论] ' : ''}${item.path || 'PR 评论'}${item.line ? `:${item.line}` : ''}`,
    `- 作者：${item.author || 'unknown'}`,
    '',
    item.body,
    '',
  ]);
}

/**
 * 驳回标记检测：评论里存在【AI检视处理】开头的标记评论，且最新的标记晚于全部待处理意见
 * → { dismissed: true, dismissedAt }。驳回之后新出现的检视意见不受影响。
 */
export function detectReviewDismissal(comments, actionable = []) {
  const markers = (Array.isArray(comments) ? comments : []).filter((c) => /^\s*【AI检视处理】/.test(String(c?.body || '')));
  if (!markers.length) return { dismissed: false, dismissedAt: null };
  const latest = markers.reduce((a, b) => (commentTimeLE(String(a.created_at || ''), String(b.created_at || '')) ? b : a));
  const markerAt = String(latest.created_at || '');
  if (!markerAt) return { dismissed: false, dismissedAt: null };
  const pending = actionable.length ? actionable : comments;
  const dismissed = pending.every((c) => commentTimeLE(String(c.created_at || ''), markerAt));
  return { dismissed, dismissedAt: dismissed ? markerAt : null };
}

async function main() {
  const prUrl = arg('--pr-url');
  const parsed = parsePrUrl(prUrl);
  const owner = arg('--owner', parsed?.owner || '');
  const repo = arg('--repo', parsed?.repo || '');
  const number = arg('--number', parsed?.number || '');
  const outDir = resolve(arg('--out', 'outputs'));
  const token = arg('--token', resolveGitcodeToken(process.env, arg('--author')));
  const includeStale = process.argv.includes('--include-stale');
  const includeConversation = process.argv.includes('--include-conversation');

  if (!owner || !repo || !number) {
    throw new Error('缺少 owner/repo/number，或传入 --pr-url');
  }

  let snapshot = null;
  try {
    const saved = JSON.parse(await readFile(resolve(outDir, 'gate-source.json'), 'utf8'));
    const age = Date.now() - Date.parse(saved.checked_at);
    if (saved.owner === owner && saved.repo === repo && String(saved.number) === String(number)
      && age >= 0 && age < 15000) snapshot = saved;
  } catch { /* fetch a fresh snapshot */ }
  const [reviewComments, issueComments, reviews, commits, pullDetail] = await Promise.all([
    snapshot ? snapshot.pullComments : gitcodeGetAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/comments`, token),
    snapshot ? snapshot.issueComments : gitcodeGetAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}/comments`, token),
    gitcodeGetAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/reviews`, token),
    gitcodeGetAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/commits`, token),
    snapshot ? snapshot.pull : gitcodeGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`, token),
  ]);

  // AI 检视覆盖判断：PR 标签是否含「AI已检视」（区分"未检视"与"检视无问题"）
  const pullLabels = Array.isArray(pullDetail?.labels)
    ? pullDetail.labels.map((l) => (typeof l === 'string' ? l : String(l?.name || '')))
    : [];
  const aiReviewed = pullLabels.includes('AI已检视');

  // 最后一次 push 时间：DCP 限流期间的 push 不产生「代码有更新」评论，只有这条边界能识别
  // （1914：15:34 限流 → 15:44 push b47ff35a → 14:08 的检视意见已修但无 reset 评论）。
  // GitCode 的 commits 接口没有 committer.date，只有 author.date；对 cherry-pick 的旧 author.date
  // 最多让边界偏早（保守方向：宁可多留一条意见给人工/LLM 复核，不会漏掉新意见）。
  let lastPushedAt = '';
  for (const commit of Array.isArray(commits) ? commits : []) {
    const at = String(commit?.commit?.committer?.date || commit?.commit?.author?.date || '');
    if (at && (!lastPushedAt || commentTimeLE(lastPushedAt, at))) lastPushedAt = at;
  }

  // 三个端点在 GitCode 上可能重叠（PR 会话评论同时出现在 pulls 与 issues 端点），按 id 去重
  const merged = new Map();
  const normalized = [
    ...(Array.isArray(reviewComments) ? reviewComments.map((item) => normalizeComment(item, 'diff')) : []),
    ...(Array.isArray(issueComments) ? issueComments.filter(commentBelongsToPull).map((item) => normalizeComment(item, 'issue')) : []),
    ...(Array.isArray(reviews) ? reviews.map((item) => normalizeComment(item, 'review')) : []),
  ];
  normalized.forEach((item, index) => {
    if (!item.body) return;
    const key = dedupeKey(item, index);
    if (!merged.has(key)) merged.set(key, item);
  });
  const comments = [...merged.values()];

  let { actionable, stale, noise, counts } = selectActionableReviews(comments, {
    include_stale: includeStale,
    include_conversation: includeConversation,
    last_pushed_at: lastPushedAt,
  });

  // 驳回标记：AIWeb 用户在面板「驳回」后发的处理评论（【AI检视处理】开头）。
  // 晚于全部待处理意见 → 本轮意见视为已处理（用户不采纳），不再生成建议修复。
  // 驳回后又出现的新检视意见（重新检视）不受影响，仍正常处理。
  const dismissal = detectReviewDismissal(comments, actionable);
  let dismissed = dismissal.dismissed;
  let dismissedAt = dismissal.dismissedAt;
  if (dismissed) {
    actionable = [];
    counts.actionable_count = 0;
    counts.ai_review_count = 0;
    counts.human_diff_comment_count = 0;
  }

  const summary = dismissed
    ? `检视意见已被用户在 AIWeb 面板驳回（${dismissedAt}），用户自行处理代码，不要据此修改。`
    : counts.actionable_count
    ? `共 ${counts.actionable_count} 条检视意见需按意见修改（AI 检视 ${counts.ai_review_count} 条、人工行内评论 ${counts.human_diff_comment_count} 条）。`
    : aiReviewed
      ? '没有需要处理的检视意见，无需按检视改代码。'
      : '本 PR 尚未被 AI 检视（无 AI已检视 标签）。可能存在同主题已检视分支的修复未同步到本分支。';
  const filteredLine = `另有 ${counts.stale_count} 条针对旧代码的意见已按 push 边界过滤、噪声 ${counts.noise_filtered_count} 条（CI 播报/口令/系统事件），均不要据此修改。`;

  const lines = [
    `# AI 检视意见 ${owner}/${repo}#${number}`,
    '',
    summary,
    filteredLine,
    '',
    ...markdownList(actionable),
    ...(stale.length ? ['', '# 已按 push 边界过滤的旧代码意见（仅供参考，不要据此改代码）', '', ...markdownList(stale)] : []),
  ];

  const artifact = {
    owner,
    repo,
    number,
    ai_reviewed: aiReviewed,
    comment_count: comments.length,
    actionable_count: counts.actionable_count,
    ai_review_count: counts.ai_review_count,
    human_diff_comment_count: counts.human_diff_comment_count,
    stale_count: counts.stale_count,
    noise_filtered_count: counts.noise_filtered_count,
    last_pushed_at: lastPushedAt || null,
    dismissed,
    dismissed_at: dismissedAt,
    comments: actionable.map(toArtifactComment),
    stale_comments: stale.map(toArtifactComment),
    fetched_at: new Date().toISOString(),
  };

  assertReviewOutputDir(outDir);
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'ai-review-comments.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  await writeFile(resolve(outDir, 'ai-review.md'), `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    ai_reviewed: aiReviewed,
    comment_count: comments.length,
    actionable_count: counts.actionable_count,
    stale_count: counts.stale_count,
    noise_filtered_count: counts.noise_filtered_count,
    last_pushed_at: lastPushedAt || null,
    md_path: resolve(outDir, 'ai-review.md'),
  }, null, 2)}\n`);
}

function isDirectRun() {
  // R6：realpath 双向解析符号链接，避免经 .aceharness 链接调用时 main 不执行却 exit 0
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
