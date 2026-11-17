/**
 * 从本地仓库采集 PR 草稿。只读 git，不推送。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseRemoteLines, suggestedTarget } from './pr-submit-plan.mjs';
import { parsePorcelainZ } from './pr-commit-assist.mjs';
import { savedBase } from './pr-base-pick.mjs';
import { groupOf, portInfo } from './pr-port.mjs';

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout).trim().slice(0, 400) || `git ${args[0]} 退出 ${code}`));
    });
  });
}

function parseNumstat(text) {
  const files = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const [added, removed, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    files.push({
      path,
      added: added === '-' ? 0 : Number(added) || 0,
      removed: removed === '-' ? 0 : Number(removed) || 0,
    });
  }
  return files;
}

export async function repoRoot(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new Error(`当前目录不是 git 仓库：${cwd}\n[ACE] 先 cd 到改完代码的仓库，再运行 ace pr。`);
  }
}

export async function currentBranch(root) {
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!branch || branch === 'HEAD') throw new Error('当前是游离 HEAD，请先切到一个分支');
  return branch;
}

export async function upstreamRef(root) {
  try {
    return (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim();
  } catch {
    return '';
  }
}

/**
 * baseRef 是 PR 的对比基准（如 origin/oh-3.35.7-release）。不传时用上游跟踪分支，
 * 再退到 ace pr 上次为这个分支记下的基准。
 */
export async function collectRepo(cwd, id = '', { baseRef = '', baseSource = '' } = {}) {
  const root = await repoRoot(cwd);
  const branch = await currentBranch(root);
  const dirtyFiles = parsePorcelainZ(await git(root, ['status', '--porcelain=v1', '-z'])).map((entry) => entry.path);
  let trackingRef = baseRef;
  let source = baseRef ? (baseSource || 'chosen') : '';
  if (!trackingRef) {
    trackingRef = await upstreamRef(root);
    source = trackingRef ? 'upstream' : '';
  }
  if (!trackingRef) {
    trackingRef = await savedBase(root, branch);
    source = trackingRef ? 'saved' : '';
  }
  const trackingBranch = trackingRef.includes('/') ? trackingRef.split('/').slice(1).join('/') : '';
  const remotes = parseRemoteLines(await git(root, ['remote', '-v']));
  const baseRemote = remotes.find((remote) => remote.name === trackingRef.split('/')[0]);
  const target = source !== 'upstream' && baseRemote ? `${baseRemote.owner}/${baseRemote.repo}` : suggestedTarget(remotes);
  let commits = [];
  let files = [];
  let diffStat = '';
  let body = '';
  if (trackingRef) {
    const log = await git(root, ['log', '--reverse', '--format=%H%x09%s', `${trackingRef}..HEAD`]);
    commits = log.split('\n').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
    files = parseNumstat(await git(root, ['diff', '--numstat', `${trackingRef}...HEAD`]));
    diffStat = (await git(root, ['diff', '--stat', `${trackingRef}...HEAD`])).trim().slice(0, 4000);
    body = (await git(root, ['log', '--reverse', '--format=%B%x1e', `${trackingRef}..HEAD`]))
      .split('\u001e').map((part) => part.trim()).filter(Boolean).join('\n\n').slice(0, 8000);
  }
  const port = await portInfo(root, branch);
  let title = commits.at(-1)?.subject || commits[0]?.subject || '';
  if (port) title = (await git(root, ['log', '-1', '--format=%s', port.sourceHead]).catch(() => '')).trim() || title;
  return {
    id: id || `prd-${randomBytes(4).toString('hex')}`,
    createdAt: new Date().toISOString(),
    status: 'draft',
    repoPath: root,
    headBranch: branch,
    headSha: (await git(root, ['rev-parse', 'HEAD'])).trim(),
    groupId: await groupOf(root, branch),
    port,
    trackingRef,
    trackingBranch,
    baseSource: source,
    remotes,
    suggestedTarget: target,
    dirty: dirtyFiles.length > 0,
    dirtyFiles: dirtyFiles.slice(0, 200),
    commits,
    files: files.slice(0, 200),
    diffStat,
    title,
    body,
    results: null,
  };
}
