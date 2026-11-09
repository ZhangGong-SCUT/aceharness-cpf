#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDirectRun } from './script-path.mjs';
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

function authHeaders(token, accept) {
  const headers = { Accept: accept };
  if (!token) return headers;
  headers['private-token'] = token;
  headers.Authorization = `Bearer ${token}`;
  return headers;
}

function withToken(path, token) {
  const separator = path.includes('?') ? '&' : '?';
  return `${API_ROOT}${path}${token ? `${separator}access_token=${encodeURIComponent(token)}` : ''}`;
}

async function gitcodeGet(path, token) {
  const response = await fetch(withToken(path, token), {
    headers: authHeaders(token, 'application/json'),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new Error(`GitCode HTTP ${response.status}`);
  }
  return json;
}

/** GitCode 的 /pulls/{number} 只接受数字。1581.diff 会被当成参数类型并返回 HTTP 400。 */
export function pullDiffApiPath(owner, repo, number) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/diff`;
}

export function looksLikeDiff(text) {
  const body = String(text || '').replace(/^\uFEFF/, '').trimStart();
  return body.startsWith('diff --git ') || body.startsWith('--- ') || body.startsWith('@@');
}

function patchBody(file) {
  const patch = file?.patch;
  if (typeof patch === 'string' && patch.trim()) return patch;
  if (patch && typeof patch === 'object' && String(patch.diff || '').trim()) return String(patch.diff);
  const rows = file?.content?.text;
  if (!Array.isArray(rows) || rows.length === 0) return '';
  let oldCount = 0;
  let newCount = 0;
  const lines = [];
  for (const row of rows) {
    const text = String(row?.line_content ?? '');
    if (row?.type === 'old') {
      lines.push(`-${text}`);
      oldCount += 1;
    } else if (row?.type === 'new') {
      lines.push(`+${text}`);
      newCount += 1;
    } else {
      lines.push(` ${text}`);
      oldCount += 1;
      newCount += 1;
    }
  }
  const oldStart = Number(rows.find((row) => row?.old_line?.line_num)?.old_line.line_num || 0) || 1;
  const newStart = Number(rows.find((row) => row?.new_line?.line_num)?.new_line.line_num || 0) || 1;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join('\n')}`;
}

export function unifiedDiffFromPullFiles(files) {
  const list = Array.isArray(files) ? files : (Array.isArray(files?.diffs) ? files.diffs : []);
  const parts = [];
  for (const file of list) {
    const patch = patchBody(file).trimEnd();
    if (!patch) continue;
    if (patch.startsWith('diff --git ')) {
      parts.push(patch);
      continue;
    }
    const path = file.filename || file.new_path || file.path || file.statistic?.new_path || file.statistic?.path || '';
    const oldPath = file.previous_filename || file.old_path || file.statistic?.old_path || path;
    if (!path) continue;
    const status = String(file.status || '').toLowerCase();
    const added = status === 'added' || status === 'new';
    const removed = status === 'removed' || status === 'deleted';
    const header = [
      `diff --git a/${oldPath} b/${path}`,
      `--- ${added ? '/dev/null' : `a/${oldPath}`}`,
      `+++ ${removed ? '/dev/null' : `b/${path}`}`,
    ];
    const body = patch.split('\n').filter((line) => !line.startsWith('diff --git ') && !line.startsWith('--- ') && !line.startsWith('+++ ')).join('\n');
    parts.push(`${header.join('\n')}\n${body}`);
  }
  return parts.length ? `${parts.join('\n')}\n` : '';
}

async function main() {
  const prUrl = arg('--pr-url');
  const parsed = parsePrUrl(prUrl);
  const owner = arg('--owner', parsed?.owner || '');
  const repo = arg('--repo', parsed?.repo || '');
  const number = arg('--number', parsed?.number || '');
  const outDir = resolve(arg('--out', 'outputs'));
  const token = arg('--token', resolveGitcodeToken(process.env, arg('--author')));

  if (!owner || !repo || !number) {
    throw new Error('缺少 owner/repo/number，或传入 --pr-url');
  }

  const pull = await gitcodeGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`, token);
  let files = [];
  try {
    files = await gitcodeGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/files`, token);
  } catch {
    files = [];
  }

  let diff = '';
  try {
    const response = await fetch(withToken(pullDiffApiPath(owner, repo, number), token), {
      headers: authHeaders(token, 'text/plain'),
    });
    const text = await response.text();
    if (response.ok && looksLikeDiff(text)) diff = text;
  } catch {
    diff = '';
  }
  if (!looksLikeDiff(diff)) diff = unifiedDiffFromPullFiles(files);
  if (!looksLikeDiff(diff)) {
    throw new Error('拉取 diff 失败：GitCode 不接受 /pulls/{number}.diff，/pulls/{number}/diff 和 files 补丁都没有给出 diff');
  }

  const fileList = Array.isArray(files) ? files : (Array.isArray(files?.diffs) ? files.diffs : []);
  const changedFiles = fileList.map((item) => item.filename || item.file || item.path || item.statistic?.new_path || item.statistic?.path).filter(Boolean);
  const artifact = {
    owner,
    repo,
    number,
    pr_url: pull.html_url || prUrl || `https://gitcode.com/${owner}/${repo}/pull/${number}`,
    title: pull.title || '',
    state: pull.state || '',
    merged: Boolean(pull.merged),
    mergeable: pull.mergeable,
    head_ref: pull.head?.ref || pull.head_branch || '',
    base_ref: pull.base?.ref || pull.base_branch || '',
    head_sha: pull.head?.sha || '',
    author: pull.user?.login || '',
    changed_files: changedFiles,
    file_count: changedFiles.length,
    diff_bytes: Buffer.byteLength(diff, 'utf8'),
    fetched_at: new Date().toISOString(),
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'pr-meta.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  await writeFile(resolve(outDir, 'review.diff'), diff, 'utf8');
  await writeFile(resolve(outDir, 'changed-files.txt'), `${changedFiles.join('\n')}${changedFiles.length ? '\n' : ''}`, 'utf8');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    artifact_dir: outDir,
    meta_path: resolve(outDir, 'pr-meta.json'),
    diff_path: resolve(outDir, 'review.diff'),
    changed_files: changedFiles,
  }, null, 2)}\n`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}
