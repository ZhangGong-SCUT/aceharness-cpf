#!/usr/bin/env node
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
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${url} ${text.slice(0, 300)}`);
  }
  return json;
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

  const diffUrl = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}.diff${token ? `?access_token=${encodeURIComponent(token)}` : ''}`;
  const diffResponse = await fetch(diffUrl, { headers: { Accept: 'text/plain' } });
  const diff = await diffResponse.text();
  if (!diffResponse.ok) {
    throw new Error(`拉取 diff 失败 ${diffResponse.status}: ${diff.slice(0, 300)}`);
  }

  const changedFiles = Array.isArray(files)
    ? files.map((item) => item.filename || item.file || item.path).filter(Boolean)
    : [];
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

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
});
