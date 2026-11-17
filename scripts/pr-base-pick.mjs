/**
 * 当前分支没有可用的跟踪分支时，找出它是从哪个远程分支拉出来的。
 */
import { git } from './pr-commit-assist.mjs';

const MAX_WALK = 60;

function remoteRank(ref) {
  const remote = ref.split('/')[0];
  if (remote === 'upstream') return 0;
  if (remote === 'origin') return 1;
  return 2;
}

async function remoteRefsContaining(root, rev) {
  const out = await git(root, ['for-each-ref', '--contains', rev, '--format=%(refname)', 'refs/remotes']);
  return out.split('\n')
    .map((line) => line.trim().replace(/^refs\/remotes\//, ''))
    .filter((ref) => ref && ref.includes('/') && !ref.endsWith('/HEAD'));
}

export async function refExists(root, ref) {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export async function aheadCount(root, ref) {
  return Number((await git(root, ['rev-list', '--count', `${ref}..HEAD`])).trim()) || 0;
}

export async function savedBase(root, branch) {
  try {
    const ref = (await git(root, ['config', '--get', `branch.${branch}.acePrBase`])).trim();
    return ref && await refExists(root, ref) ? ref : '';
  } catch {
    return '';
  }
}

export async function saveBase(root, branch, ref) {
  await git(root, ['config', `branch.${branch}.acePrBase`, ref]);
}

/**
 * 候选按可信度排序：编辑器记下的分叉基准，然后是包含分叉点的远程分支（upstream、origin 优先）。
 * 已经包含 HEAD 的远程分支是推过的同一条特性分支，不算基准。
 */
export async function baseCandidates(root, branch, limit = 6) {
  const found = [];
  const add = async (ref, source) => {
    if (!ref || found.some((item) => item.ref === ref) || !await refExists(root, ref)) return;
    found.push({ ref, source, ahead: 0 });
  };
  for (const key of ['vscode-merge-base', 'gh-merge-base']) {
    try {
      await add((await git(root, ['config', '--get', `branch.${branch}.${key}`])).trim(), 'editor');
    } catch { /* 没有配置 */ }
  }
  const pushed = new Set(await remoteRefsContaining(root, 'HEAD'));
  for (let k = 1; k <= MAX_WALK; k += 1) {
    let refs;
    try {
      refs = await remoteRefsContaining(root, `HEAD~${k}`);
    } catch {
      break;
    }
    const usable = refs.filter((ref) => !pushed.has(ref)).sort((a, b) => remoteRank(a) - remoteRank(b));
    if (!usable.length) continue;
    for (const ref of usable) await add(ref, 'fork-point');
    break;
  }
  const top = found.filter((item) => !pushed.has(item.ref)).slice(0, limit);
  for (const item of top) item.ahead = await aheadCount(root, item.ref);
  return top;
}

export async function searchRemoteRefs(root, text, limit = 15) {
  const out = await git(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes']);
  const needle = String(text || '').toLowerCase();
  return out.split('\n')
    .map((line) => line.trim().replace(/^refs\/remotes\//, ''))
    .filter((ref) => ref && !ref.endsWith('/HEAD') && ref.toLowerCase().includes(needle))
    .slice(0, limit);
}
