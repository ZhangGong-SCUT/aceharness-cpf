#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { classifyOhosPrGates, normalizeComments, normalizeLabels } from './ohos-pr-gates.mjs';

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

async function main() {
  const prUrl = arg('--pr-url');
  const parsed = parsePrUrl(prUrl);
  const owner = arg('--owner', parsed?.owner || '');
  const repo = arg('--repo', parsed?.repo || '');
  const number = arg('--number', parsed?.number || '');
  const outDir = resolve(arg('--out', 'outputs'));
  const token = arg('--token', process.env.GITCODE_TOKEN || process.env.ACE_GITCODE_TOKEN || '');
  const allowedAuthors = parseNameList(process.env.ACE_GITCODE_PR_AUTHOR);

  if (!owner || !repo || !number) {
    throw new Error('缺少 owner/repo/number，或传入 --pr-url');
  }

  const pullPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`;
  const issuePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}`;
  const pull = await gitcodeGet(pullPath, token);
  const issue = await gitcodeGetOptional(issuePath, token);
  const labelPayload = await gitcodeGetOptional(`${issuePath}/labels`, token);
  const commentPages = [];
  for (const page of [1, 2, 3]) {
    const batch = await gitcodeGetOptional(`${issuePath}/comments?page=${page}&per_page=100`, token);
    if (!Array.isArray(batch) || batch.length === 0) break;
    commentPages.push(...batch);
    if (batch.length < 100) break;
  }

  const author = String(pull.user?.login || pull.user?.username || pull.author?.username || '').trim();
  const ownPr = allowedAuthors.length === 0
    ? true
    : allowedAuthors.includes(author.toLowerCase());
  const state = String(pull.state || '').toLowerCase();
  const merged = Boolean(pull.merged) || state === 'merged';
  const closed = state === 'closed' || merged;
  const headRepo = repoFullName(pull.head?.repo)
    || repoFullName(pull.head)
    || repoFullName(pull.source)
    || '';
  const classified = classifyOhosPrGates({
    labels: collectLabels(pull, issue, labelPayload),
    comments: normalizeComments(commentPages),
    pull,
    state,
    merged,
    closed,
    own_pr: ownPr,
  });

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
