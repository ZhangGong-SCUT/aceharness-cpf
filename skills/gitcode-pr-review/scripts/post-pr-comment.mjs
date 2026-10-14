#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { countStartBuildAttempts, normalizeComments } from './ohos-pr-gates.mjs';
import { gitcodeReadPages } from './gitcode-read.mjs';

const API_ROOT = process.env.GITCODE_API_ROOT || 'https://gitcode.com/api/v5';
const FORBIDDEN = new Set(['submit']);

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

async function main() {
  const prUrl = arg('--pr-url');
  const parsed = parsePrUrl(prUrl);
  const owner = arg('--owner', parsed?.owner || '');
  const repo = arg('--repo', parsed?.repo || '');
  const number = arg('--number', parsed?.number || '');
  const body = arg('--body', 'start build').trim();
  const outDir = resolve(arg('--out', 'outputs'));
  const token = arg('--token', process.env.GITCODE_TOKEN || process.env.ACE_GITCODE_TOKEN || '');

  if (!owner || !repo || !number) {
    throw new Error('缺少 owner/repo/number，或传入 --pr-url');
  }
  if (!token) {
    throw new Error('缺少 GITCODE_TOKEN / ACE_GITCODE_TOKEN，无法评论');
  }
  if (FORBIDDEN.has(body.toLowerCase())) {
    throw new Error(`禁止自动评论 ${body}。合入仍由人评论 submit`);
  }

  const url = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}/comments?access_token=${encodeURIComponent(token)}`;
  if (/^start\s+build$/i.test(body)) {
    // Re-read immediately before the side effect; a model may still be acting on an older gate snapshot.
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/comments`;
    const comments = await gitcodeReadPages(path, token);
    if (countStartBuildAttempts(normalizeComments(comments)).rate_limited) {
      await mkdir(outDir, { recursive: true });
      await writeFile(resolve(outDir, 'pr-comment.json'), JSON.stringify({ ok: false, body,
        phase: 'blocked_rate_limit', comment_id: null, posted_at: null,
        checked_at: new Date().toISOString(), error: 'DCP 当前限流，未发送 start build' }));
      throw new Error('DCP 当前限流，停止发送 start build；请先恢复额度');
    }
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${url.replace(/access_token=[^&]+/, 'access_token=***')} ${text.slice(0, 300)}`);
  }

  const result = {
    ok: true,
    body,
    comment_id: json?.id || null,
    html_url: json?.html_url || json?.url || '',
    posted_at: new Date().toISOString(),
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'pr-comment.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
});
