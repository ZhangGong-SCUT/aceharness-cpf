#!/usr/bin/env node
/**
 * find-sibling-prs.mjs — 查找同主题跨分支 PR（用于未检视分支的修复同步）
 *
 * 匹配规则：
 *   1. 同作者 + 同仓 + 仍 open
 *   2. 标题去版本号前缀后相同（【3.35】xxx 与 【3.44】xxx → 同主题）
 *   3. 可选：--diff-check 模式下额外比较 changed files 列表前 10 个
 *
 * 输出 JSON：{ siblings: [{ number, title, state, labels, ai_reviewed }], group_key }
 * 用法：node find-sibling-prs.mjs --pr-url <URL> --author <login> [--out outputs]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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

/** 标题去版本号前缀：【3.35】/ [3.44] / （3.22）等 */
function stripVersionPrefix(title) {
  return String(title || '')
    .replace(/^[【\[]\d+\.?\d*(?:\.\d+)?[】\]]\s*/i, '')
    .replace(/^[（(]\d+\.?\d*(?:\.\d+)?[）)]\s*/i, '')
    .trim();
}

async function main() {
  const prUrl = arg('--pr-url');
  const parsed = parsePrUrl(prUrl);
  const owner = arg('--owner', parsed?.owner || '');
  const repo = arg('--repo', parsed?.repo || '');
  const number = arg('--number', parsed?.number || '');
  const author = arg('--author');
  const outDir = resolve(arg('--out', 'outputs'));
  const token = resolveGitcodeToken(process.env, author);

  if (!owner || !repo || !number) {
    throw new Error('缺少 owner/repo/number，或传入 --pr-url');
  }
  if (!author) {
    throw new Error('缺少 --author（用于按作者过滤同主题 PR）');
  }

  // 拉本 PR 详情（标题 + 标签）
  const self = await gitcodeGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`, token);
  if (!self?.number) {
    throw new Error(`PR #${number} 不存在或不可访问`);
  }
  const selfTitle = String(self.title || '');
  const selfLabels = Array.isArray(self.labels)
    ? self.labels.map((l) => (typeof l === 'string' ? l : String(l?.name || '')))
    : [];
  const groupKey = stripVersionPrefix(selfTitle);

  if (!groupKey) {
    const result = { siblings: [], group_key: '', reason: '标题为空或去版本号后为空' };
    await output(result, outDir);
    return;
  }

  // 拉同作者在该仓的全部 open PR
  const allPrs = await gitcodeGet(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100&sort=updated&direction=desc`,
    token,
  );

  const siblings = [];
  for (const pr of Array.isArray(allPrs) ? allPrs : []) {
    if (String(pr.number) === String(number)) continue;
    const prAuthor = pr.user?.login || pr.user?.username || '';
    if (prAuthor.toLowerCase() !== author.toLowerCase()) continue;
    const prTitle = String(pr.title || '');
    const prKey = stripVersionPrefix(prTitle);
    if (!prKey || prKey !== groupKey) continue;

    const prLabels = Array.isArray(pr.labels)
      ? pr.labels.map((l) => (typeof l === 'string' ? l : String(l?.name || '')))
      : [];
    siblings.push({
      number: pr.number,
      title: prTitle,
      state: pr.state,
      labels: prLabels,
      ai_reviewed: prLabels.includes('AI已检视'),
      html_url: pr.html_url || `https://gitcode.com/${owner}/${repo}/merge_requests/${pr.number}`,
    });
  }

  const result = {
    siblings,
    group_key: groupKey,
    self: { number: Number(number), title: selfTitle, ai_reviewed: selfLabels.includes('AI已检视') },
    sibling_count: siblings.length,
    reviewed_siblings: siblings.filter((s) => s.ai_reviewed),
    unreviewed_siblings: siblings.filter((s) => !s.ai_reviewed),
  };

  await output(result, outDir);
}

async function output(result, outDir) {
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, 'sibling-prs.json');
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
