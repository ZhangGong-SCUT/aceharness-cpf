#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { commentBelongsToPull, commentTimeLE, selectActionableReviews } from './ohos-pr-gates.mjs';
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

async function gitcodeGet(path, token) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${API_ROOT}${path}${token ? `${separator}access_token=${encodeURIComponent(token)}` : ''}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`${response.status} ${url} ${text.slice(0, 300)}`);
  }
  try {
    return text ? JSON.parse(text) : [];
  } catch {
    return [];
  }
}

/** GitCode 默认每页 20 条，不翻页会漏早期检视意见（1914 实际 69+ 条只取到 20 条）。 */
async function gitcodeGetAll(path, token) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gitcodeGet(`${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=100`, token);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

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

  const [reviewComments, issueComments, reviews, commits, pullDetail] = await Promise.all([
    gitcodeGetAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/comments`, token),
    gitcodeGetAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}/comments`, token),
    gitcodeGetAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/reviews`, token),
    gitcodeGetAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/commits`, token),
    gitcodeGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`, token),
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

  const { actionable, stale, noise, counts } = selectActionableReviews(comments, {
    include_stale: includeStale,
    include_conversation: includeConversation,
    last_pushed_at: lastPushedAt,
  });

  const summary = counts.actionable_count
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
    comments: actionable.map(toArtifactComment),
    stale_comments: stale.map(toArtifactComment),
    fetched_at: new Date().toISOString(),
  };

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
  return resolve(process.argv[1] || '') === resolve(new URL(import.meta.url).pathname);
}

if (isDirectRun()) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}
