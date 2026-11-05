#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { countStartBuildAttempts, normalizeComments } from './ohos-pr-gates.mjs';
import { gitcodeReadPages } from './gitcode-read.mjs';
import { firstAvailableGitcodeToken, hasPerUserGitcodeTokens, resolveGitcodeToken } from './gitcode-token.mjs';

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

function pullAuthor(pull) {
  return String(pull?.user?.login || pull?.user?.username || pull?.author?.username || '').trim();
}

function isCiAuthor(login) {
  return /openharmony_ci|openharmony_dcp/i.test(String(login || ''));
}

function isPushAckComment(item) {
  const author = String(item?.user?.login || item?.user?.username || '').trim();
  if (!isCiAuthor(author)) return false;
  return /代码有更新|感谢提交|监测到PR|重置.*验证状态/.test(String(item?.body || ''));
}

function commentKey(item) {
  return String(item?.id || item?.node_id || `${item?.created_at || ''}|${String(item?.body || '').slice(0, 40)}`);
}

async function fetchPullComments(owner, repo, number, token) {
  const list = await gitcodeGet(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/comments?per_page=50`,
    token,
  );
  return Array.isArray(list) ? list : [];
}

/**
 * push 后 GitCode 的 MR 更新事件是异步处理的（实测可滞后 ~70s），
 * 若在它送达 DCP 前评论 start build，构建会被「代码有更新」事件按规则中止。
 * 等 GitCode 在 PR 上冒出 push 的确认评论（监测到PR/代码有更新/感谢提交）再发。
 */
async function waitForPushAck(input) {
  const { owner, repo, number, token, since, timeoutMs, pollMs = 5000 } = input;
  const sinceMs = since ? Date.parse(since) : NaN;
  const deadline = Date.now() + timeoutMs;
  let baseline = Number.isFinite(sinceMs) ? sinceMs : null;
  let first = true;
  while (Date.now() < deadline) {
    const comments = await fetchPullComments(owner, repo, number, token);
    const acks = comments.filter(isPushAckComment);
    if (baseline === null) {
      const newest = acks.reduce((max, item) => Math.max(max, Date.parse(String(item.created_at || '')) || 0), 0);
      baseline = newest;
      if (first && Number.isFinite(sinceMs)) {
        const matched = acks.find((item) => Date.parse(String(item.created_at || '')) > sinceMs);
        if (matched) {
          return { status: 'acked', acked_at: String(matched.created_at || ''), polls: 1 };
        }
      }
      first = false;
    } else {
      const matched = acks.find((item) => (Date.parse(String(item.created_at || '')) || 0) > baseline);
      if (matched) {
        return { status: 'acked', acked_at: String(matched.created_at || ''), polls: 1 };
      }
    }
    if (Date.now() + pollMs >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { status: 'timeout', acked_at: '', polls: 0 };
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
    throw new Error(`${response.status} ${url.replace(/access_token=[^&]+/, 'access_token=***')} ${text.slice(0, 300)}`);
  }
  return json;
}

async function main() {
  const prUrl = arg('--pr-url');
  const parsed = parsePrUrl(prUrl);
  const owner = arg('--owner', parsed?.owner || '');
  const repo = arg('--repo', parsed?.repo || '');
  const number = arg('--number', parsed?.number || '');
  const body = arg('--body', 'start build').trim();
  const outDir = resolve(arg('--out', 'outputs'));
  let author = arg('--author');
  let token = arg('--token');

  if (!owner || !repo || !number) {
    throw new Error('缺少 owner/repo/number，或传入 --pr-url');
  }
  if (!token && !author) {
    const readToken = firstAvailableGitcodeToken(process.env);
    if (readToken) {
      const pull = await gitcodeGet(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`,
        readToken,
      );
      author = pullAuthor(pull);
    }
  }
  if (!token) token = resolveGitcodeToken(process.env, author);
  if (!token) {
    if (author && hasPerUserGitcodeTokens(process.env)) {
      throw new Error(`缺少 GITCODE_TOKEN_${author}，不能用其他人的密钥评论 start build`);
    }
    throw new Error('缺少 GITCODE_TOKEN / ACE_GITCODE_TOKEN，无法评论');
  }
  if (FORBIDDEN.has(body.toLowerCase())) {
    throw new Error(`禁止自动评论 ${body}。合入仍由人评论 submit`);
  }

  let waitAck = { status: 'skipped', acked_at: '', polls: 0 };
  if (process.argv.includes('--wait-push-ack')) {
    const timeoutSeconds = Number(arg('--wait-timeout', '120')) || 120;
    waitAck = await waitForPushAck({
      owner,
      repo,
      number,
      token,
      since: arg('--since') || '',
      timeoutMs: timeoutSeconds * 1000,
    });
  }

  // GitCode Issue 号和 PR 号独立。POST issues/{n}/comments 会写到同号 Issue，网页上看不见。
  const url = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/comments?access_token=${encodeURIComponent(token)}`;
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
    author: author || null,
    comment_id: json?.id || null,
    comment_type: json?.comment_type || 'pr_comment',
    html_url: json?.html_url || json?.url || '',
    posted_at: new Date().toISOString(),
    endpoint: 'pulls',
    wait_ack: waitAck.status,
    push_ack_at: waitAck.acked_at || null,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'pr-comment.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
});
