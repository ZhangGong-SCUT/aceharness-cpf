#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDirectRun } from './script-path.mjs';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 || index === process.argv.length - 1 ? fallback : process.argv[index + 1];
}

function clean(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

/** 折叠样式会把超长的 pr_url 折到下一行。拼回同一行后再取字段。 */
function unfoldFoldedLines(block) {
  const merged = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) {
      merged.push('');
      continue;
    }
    const startsField = /^\s*(?!https?:)[A-Za-z][\w-]*:/.test(line);
    const prev = merged.length ? merged[merged.length - 1] : '';
    if (!startsField && prev.trim()) {
      merged[merged.length - 1] = `${prev} ${line.trim()}`;
      continue;
    }
    merged.push(line);
  }
  return merged.join('\n');
}

export function parseContext(raw) {
  const block = /^globalContext:\s*[|>]\s*[+-]?\s*\n([\s\S]*?)(?=\n[^\s]|(?![\s\S]))/m.exec(raw)?.[1] || '';
  const fields = {};
  for (const line of unfoldFoldedLines(block).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (match) fields[match[1].toLowerCase()] = clean(match[2]);
  }
  return fields;
}

function parsePrUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!/^gitcode\.com$/i.test(url.hostname)) return null;
  const match = /^\/([^/]+)\/([^/]+)\/(?:pulls?|merge_requests)\/(\d+)\/?$/i.exec(url.pathname);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, ''), number: match[3] };
}

function list(value) {
  return String(value || '').split(/[,;\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function isWatchedRepo(owner, repo, watchedRepos) {
  if (watchedRepos.length === 0) return true;
  const ownerName = String(owner || '').trim().toLowerCase();
  const repoName = String(repo || '').trim().replace(/\.git$/i, '').toLowerCase();
  const full = `${ownerName}/${repoName}`;
  if (full === '/') return false;
  return watchedRepos.some((item) => {
    const rule = String(item || '').trim().toLowerCase().replace(/\.git$/i, '');
    if (rule.endsWith('/*')) return rule.slice(0, -2) === ownerName && Boolean(repoName);
    return rule === full;
  });
}

async function main() {
  const outDir = resolve(arg('--out', 'outputs'));
  let fields = {};
  try {
    fields = parseContext(await readFile(resolve(arg('--state', resolve(outDir, '..', 'state.yaml'))), 'utf8'));
  } catch {
    // Run context is mandatory; a direct invocation without state.yaml must fail closed.
  }

  const parsedUrl = parsePrUrl(fields.pr_url);
  const owner = fields.owner || parsedUrl?.owner || '';
  const repo = fields.repo || parsedUrl?.repo || '';
  const number = fields.number || parsedUrl?.number || '';
  const author = fields.author || '';
  const headRepo = fields.head_repo || '';
  const headRef = fields.head_ref || '';
  const baseRef = fields.base_ref || '';
  const manualStarter = fields['manual-start-by'] || '';
  const missing = [
    ['pr_url', fields.pr_url], ['owner', owner], ['repo', repo], ['number', number],
    ['author', author], ['head_repo', headRepo], ['head_ref', headRef], ['base_ref', baseRef],
  ].filter(([, value]) => !value).map(([name]) => name);
  const urlMatches = parsedUrl
    && parsedUrl.owner.toLowerCase() === owner.toLowerCase()
    && parsedUrl.repo.toLowerCase() === repo.toLowerCase()
    && parsedUrl.number === number;
  const allowedAuthors = list(process.env.ACE_GITCODE_PR_AUTHOR);
  const watchedRepos = list(process.env.ACE_GITCODE_WATCH_REPOS || 'CPF-Flutter/*');
  const manualAllowed = manualStarter && manualStarter.toLowerCase() === author.toLowerCase();
  // 手动开启时必须是开启者自己的 PR；Webhook 模式才按白名单准入。
  const authorAllowed = manualStarter
    ? Boolean(manualAllowed)
    : allowedAuthors.length === 0 || allowedAuthors.includes(author.toLowerCase());
  const repoAllowed = isWatchedRepo(owner, repo, watchedRepos);
  let verdict = 'pass';
  let summary = `PR ${owner}/${repo}#${number} 身份字段完整，作者准入及监听仓校验通过。`;
  if (missing.length) {
    verdict = 'fail';
    summary = `PR 运行上下文缺少必需字段：${missing.join(', ')}。请重新提交完整的监控任务。`;
  } else if (!urlMatches) {
    verdict = 'fail';
    summary = 'pr_url 与 owner/repo/number 不一致或不是 GitCode PR URL。';
  } else if (!authorAllowed) {
    verdict = 'fail';
    summary = `PR 作者 ${author} 不在准入白名单，且手动开启者不是该 PR 作者。`;
  } else if (!repoAllowed) {
    verdict = 'fail';
    summary = `仓库 ${owner}/${repo} 不在 ACE_GITCODE_WATCH_REPOS 监听范围。`;
  }

  const result = {
    verdict,
    summary,
    pr_url: fields.pr_url || '',
    owner,
    repo,
    number,
    author,
    head_repo: headRepo,
    head_ref: headRef,
    base_ref: baseRef,
    own_pr: Boolean(authorAllowed && repoAllowed && urlMatches && !missing.length),
    checked_at: new Date().toISOString(),
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'pr-identity.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  });
}
