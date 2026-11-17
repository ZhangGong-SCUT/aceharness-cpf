/**
 * 确认后的 PR 提交：读草稿、按目标分支推到 fork、创建 Issue（可选）和 PR。
 * 除草稿自己的基准分支外，其他目标分支都要先预演移植并完成核对。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { forkRemote, headBranchFor, issueLabel, skillPrBody } from '../../../scripts/pr-submit-plan.mjs';
import { collectRepo } from '../../../scripts/pr-submit-collect.mjs';
import { comparePort, rangeDiff, simulatePick } from '../../../scripts/pr-port.mjs';
import { readVerifications, saveVerification } from './store.js';

// 测试钩子：GITCODE_API_ROOT 可指向本地 GitCode 模拟器（默认线上地址，行为不变）。
const API = process.env.GITCODE_API_ROOT || 'https://gitcode.com/api/v5';
const DIFF_LIMIT = 300 * 1024;
const DESCRIPTION_DIFF_LIMIT = 100 * 1024;

async function draftDiff(draft, limit) {
  if (!draft?.trackingRef || !draft?.headSha) throw new Error('草稿没有对比基准，无法生成描述');
  let diff = '';
  try {
    diff = await git(draft.repoPath, [
      'diff', '--no-color', '--no-ext-diff', '-M', `${draft.trackingRef}...${draft.headSha}`,
    ]);
  } catch (error) {
    if (/bad revision|unknown revision|bad object|invalid symmetric difference/i.test(error.message)) {
      throw new Error('本地仓库里找不到这份草稿的提交，可能已经 rebase 或切换分支，请重新运行 ace pr');
    }
    throw error;
  }
  return { diff: diff.slice(0, limit), truncated: diff.length > limit };
}

export async function draftDescriptionDiff(draft) {
  return draftDiff(draft, DESCRIPTION_DIFF_LIMIT);
}

function scrub(text) {
  return String(text || '')
    .replace(/bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'bearer [redacted]')
    .replace(/oauth2:[^@\s]+/gi, 'oauth2:[redacted]')
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//')
    .slice(0, 500);
}

function gitOnce(cwd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(scrub(error.message))));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(scrub(stderr || stdout) || `git ${args[0]} 退出 ${code}`));
    });
  });
}

function gitcodeAlreadyRewritten(env) {
  const file = env.GIT_CONFIG_GLOBAL || '';
  if (!file) return false;
  try {
    return /insteadOf\s*=\s*https:\/\/gitcode\.com\//i.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

function git(cwd, args, token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!token || gitcodeAlreadyRewritten(env)) return gitOnce(cwd, args, env);
  // GitCode 的 git HTTP 不认 Authorization: Bearer，要把令牌放进 https 用户信息。
  // 只放在子进程环境里，失败信息里的 oauth2 凭据会被 scrub 掉。
  // 测试或本机已经把 gitcode.com 改写到本地地址时，沿用那份改写。
  env.GIT_CONFIG_COUNT = '2';
  env.GIT_CONFIG_KEY_0 = `url.https://oauth2:${token}@gitcode.com/.insteadOf`;
  env.GIT_CONFIG_VALUE_0 = 'https://gitcode.com/';
  env.GIT_CONFIG_KEY_1 = 'credential.helper';
  env.GIT_CONFIG_VALUE_1 = '';
  return gitOnce(cwd, args, env);
}

async function gitcode(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'AIWeb-PRSubmit/1.0',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text.slice(0, 300) }; }
  if (response.status < 200 || response.status >= 300) {
    const message = payload?.message || payload?.error || `HTTP ${response.status}`;
    throw new Error(scrub(message));
  }
  return payload;
}

function repoPathOf(full) {
  const [owner, repo] = String(full || '').split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export async function listBranches(token, full) {
  const names = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = await gitcode(token, 'GET', `${repoPathOf(full)}/branches?per_page=100&page=${page}`);
    const list = Array.isArray(payload) ? payload : [];
    for (const item of list) {
      const name = String(item?.name || '').trim();
      if (name) names.push(name);
    }
    if (list.length < 100) break;
  }
  return [...new Set(names)];
}

const loginCache = new Map();

export async function tokenLogin(token) {
  const cached = loginCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.login;
  const user = await gitcode(token, 'GET', '/user');
  const login = String(user?.login || '').trim();
  if (!login) throw new Error('无法确认 GitCode 令牌对应的账号');
  loginCache.set(token, { login, expires: Date.now() + 10 * 60 * 1000 });
  return login;
}

function isOwnIssue(issue, login) {
  return String(issue?.user?.login || '').toLowerCase() === login.toLowerCase();
}

export async function searchIssues(token, full, query) {
  const login = await tokenLogin(token);
  const q = String(query || '').trim();
  const number = q.match(/^(?:#)?(\d+)$/)?.[1]
    || q.match(/\/issues\/(\d+)/)?.[1]
    || '';
  if (number) {
    let issue = null;
    try {
      issue = await gitcode(token, 'GET', `${repoPathOf(full)}/issues/${encodeURIComponent(number)}`);
    } catch {
      return { login, issues: [], hidden: 0 };
    }
    return isOwnIssue(issue, login)
      ? { login, issues: [summarizeIssue(issue, full)], hidden: 0 }
      : { login, issues: [], hidden: 1 };
  }
  const payload = await gitcode(token, 'GET', `${repoPathOf(full)}/issues?state=all&per_page=100&sort=updated&creator=${encodeURIComponent(login)}`);
  const needle = q.toLowerCase();
  const issues = (Array.isArray(payload) ? payload : [])
    .filter((item) => isOwnIssue(item, login))
    .map((item) => summarizeIssue(item, full))
    .filter((item) => !needle || item.title.toLowerCase().includes(needle))
    .sort((a, b) => Number(a.state !== 'open') - Number(b.state !== 'open'))
    .slice(0, 30);
  return { login, issues, hidden: 0 };
}

function summarizeIssue(issue, full) {
  const number = String(issue?.number || '');
  return {
    number,
    title: String(issue?.title || ''),
    state: String(issue?.state || ''),
    author: String(issue?.user?.login || ''),
    url: issue?.html_url || `https://gitcode.com/${full}/issues/${number}`,
  };
}

function safeName(base) {
  return base.replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function fetchBase(draft, token, target, base) {
  const ref = `refs/ace-pr/${draft.id}/${safeName(base)}`;
  const [owner, repo] = target.split('/');
  await git(draft.repoPath, ['fetch', '--no-tags', `https://gitcode.com/${owner}/${repo}.git`, `+refs/heads/${base}:${ref}`], token);
  return git(draft.repoPath, ['rev-parse', ref]);
}

/** 草稿自己的对比基准分支：直接推；基准前进了就在最新基准上重放（冲突则失败）。 */
async function primaryCommit(draft, token, target, base) {
  const fetched = await fetchBase(draft, token, target, base);
  let parent = '';
  try { parent = await git(draft.repoPath, ['rev-parse', `${draft.commits[0].sha}^`]); } catch { parent = ''; }
  if (parent === fetched && draft.headSha === draft.commits.at(-1).sha) return draft.headSha;
  const picked = await simulatePick(draft.repoPath, fetched, draft.commits.map((item) => item.sha));
  if (!picked.ok) throw new Error(`cherry-pick 冲突：${picked.conflicts.join('、') || picked.reason}`);
  return picked.sha;
}

async function pushHead(draft, token, fork, sha, headBranch) {
  await git(draft.repoPath, ['push', `https://gitcode.com/${fork.owner}/${fork.repo}.git`, `${sha}:refs/heads/${headBranch}`], token);
}

export function isPortBase(draft, base) {
  return base !== draft.trackingBranch;
}

export function pickKey(draft, base, sha) {
  return `pick:${draft.id}:${base}:${sha}`;
}

/** 在目标分支最新代码上预演 cherry-pick 草稿里的 commit，结果留在 refs/ace-pr 下供核对和提交。 */
export async function previewBase(draft, token, target, base) {
  if (!draft.commits?.length) throw new Error('草稿没有 commit，无法移植');
  const baseSha = await fetchBase(draft, token, target, base);
  const picked = await simulatePick(draft.repoPath, baseSha, draft.commits.map((item) => item.sha));
  const preview = {
    base,
    target,
    baseSha,
    at: new Date().toISOString(),
    ok: picked.ok,
    empty: picked.ok && picked.sha === baseSha,
    sha: picked.sha || '',
    conflicts: picked.conflicts || [],
    conflictCommit: picked.conflictCommit || '',
    reason: picked.reason || '',
  };
  if (preview.ok && !preview.empty) await git(draft.repoPath, ['update-ref', `refs/ace-pr/${draft.id}/port/${safeName(base)}`, preview.sha]);
  return preview;
}

const CHECK_TEXT_LIMIT = 200 * 1024;

function capFiles(files) {
  return files.map((file) => ({
    ...file,
    source: file.source.length > CHECK_TEXT_LIMIT ? `${file.source.slice(0, CHECK_TEXT_LIMIT)}\n…（太长，已截断）` : file.source,
    target: file.target.length > CHECK_TEXT_LIMIT ? `${file.target.slice(0, CHECK_TEXT_LIMIT)}\n…（太长，已截断）` : file.target,
  }));
}

/**
 * 移植核对：源改动 vs 目标分支上的改动。
 * 不传 base 或 base 是草稿自己的基准：核对 ace pr port 出来的移植分支本身；
 * 其他 base：核对 previewBase 预演出来的结果。
 */
export async function portCheck(draft, base = '') {
  const verifications = await readVerifications();
  const ownBranch = !base || !isPortBase(draft, base);
  if (ownBranch) {
    if (!draft.port) throw new Error('这份草稿不是从其他分支移植过来的，不需要核对');
    const sourceDiff = await rangeDiff(draft.repoPath, draft.port.sourceBase, draft.port.sourceHead);
    const mergeBase = await git(draft.repoPath, ['merge-base', draft.trackingRef, draft.headSha]);
    const targetDiff = await rangeDiff(draft.repoPath, mergeBase, draft.headSha);
    const key = `sha:${draft.headSha}`;
    const result = comparePort(sourceDiff, targetDiff);
    return { kind: 'port', from: draft.port.fromBranch, to: draft.trackingBranch, key, ...result, files: capFiles(result.files), verification: verifications[key] || null };
  }
  const preview = draft.previews?.[base];
  if (!preview) throw new Error(`${base} 还没有预演移植`);
  if (!preview.ok || preview.empty) {
    return { kind: 'pick', from: draft.headBranch, to: base, key: '', preview, files: [], summary: null, verification: null };
  }
  const mergeBase = await git(draft.repoPath, ['merge-base', draft.trackingRef, draft.headSha]);
  const sourceDiff = await rangeDiff(draft.repoPath, mergeBase, draft.headSha);
  const targetDiff = await rangeDiff(draft.repoPath, preview.baseSha, preview.sha);
  const key = pickKey(draft, base, preview.sha);
  const result = comparePort(sourceDiff, targetDiff);
  return { kind: 'pick', from: draft.headBranch, to: base, key, preview, ...result, files: capFiles(result.files), verification: verifications[key] || null };
}

export async function verifyPort(draft, base, key, note, by) {
  const check = await portCheck(draft, base);
  if (!check.key) throw new Error('这个分支没有可核对的移植结果');
  if (check.key !== key) throw new Error('移植内容已经变化，请刷新后重新核对');
  const text = String(note || '').trim().slice(0, 500);
  const differs = check.summary.adapted + check.summary.missing + check.summary.extra;
  if (differs && !text) throw new Error('有和源分支不一致的文件，请写一句说明（例如：3.41 上这个接口改名了）');
  return saveVerification(key, { at: new Date().toISOString(), by, note: text, summary: check.summary, from: check.from, to: check.to });
}

/** 不联网就能判断的拦截原因：移植分支和预演分支都必须核对过。 */
export function portBlocker(draft, base, verifications, target) {
  if (!isPortBase(draft, base)) {
    return draft.port && !verifications[`sha:${draft.headSha}`] ? `还没有完成移植核对（${draft.port.fromBranch} → ${base}）` : '';
  }
  const preview = draft.previews?.[base];
  if (!preview || preview.target !== target) return `${base} 还没有预演移植，不能提交`;
  if (!preview.ok) return `${base} 预演有冲突，不能直接移植，请用 ace pr port ${base} 在独立目录里移植`;
  if (preview.empty) return `${base} 已经包含这些改动，不需要再提 PR`;
  if (!verifications[pickKey(draft, base, preview.sha)]) return `${base} 还没有完成移植核对`;
  return '';
}

async function readyCommit(draft, token, target, base, verifications) {
  const blocker = portBlocker(draft, base, verifications, target);
  if (blocker) throw new Error(blocker);
  if (!isPortBase(draft, base)) return primaryCommit(draft, token, target, base);
  const preview = draft.previews[base];
  const fetched = await fetchBase(draft, token, target, base);
  if (fetched !== preview.baseSha) throw new Error(`${base} 有新的提交，请重新预演并核对`);
  return preview.sha;
}

/** git numstat 对重命名写成 "src/{a => b}.dart" 或 "a => b"，diff 需要两侧真实路径。 */
export function renamePaths(path) {
  const braced = String(path).match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braced) {
    const [, head, from, to, tail] = braced;
    const join = (middle) => `${head}${middle}${tail}`.replace(/\/{2,}/g, '/').replace(/^\//, '');
    return [join(from), join(to)];
  }
  const plain = String(path).split(' => ');
  return plain.length === 2 ? plain : [String(path)];
}

export async function draftFileDiff(draft, path) {
  if (!(draft.files || []).some((item) => item.path === path)) throw new Error('这个文件不在本次改动里');
  if (!draft.trackingRef || !draft.headSha) throw new Error('草稿没有对比基准，无法生成 diff');
  let text = '';
  try {
    text = await git(draft.repoPath, [
      'diff', '--no-color', '--no-ext-diff', '-M',
      `${draft.trackingRef}...${draft.headSha}`, '--', ...renamePaths(path),
    ]);
  } catch (error) {
    if (/bad revision|unknown revision|bad object|invalid symmetric difference/i.test(error.message)) {
      throw new Error('本地仓库里找不到这份草稿的提交，可能已经 rebase 或切换分支，请重新运行 ace pr');
    }
    throw error;
  }
  const truncated = text.length > DIFF_LIMIT;
  return { path, diff: truncated ? text.slice(0, DIFF_LIMIT) : text, truncated };
}

function relatedIssues(pull) {
  return [
    ...(Array.isArray(pull?.related_issues) ? pull.related_issues : []),
    ...(Array.isArray(pull?.issues) ? pull.issues : []),
  ];
}

/**
 * PR 创建成功后核对 Issue，并评论 start build。这两步失败不撤销已创建的 PR。
 * GitCode 认的是说明里的 #编号；/pulls/:number/issues 是 PR 自己的镜像 Issue，不能拿来关联。
 */
async function finishPull(token, target, row, issueNumber) {
  const number = String(issueNumber || '').replace(/\D/g, '');
  if (number && row.number) {
    try {
      const pull = await gitcode(token, 'GET', `${repoPathOf(target)}/pulls/${encodeURIComponent(row.number)}`);
      const related = relatedIssues(pull);
      const extras = related.filter((item) => String(item?.number || '') !== number);
      const mentioned = new RegExp(`(?:^|\\s)#${number}\\b`).test(`${pull?.title || ''}\n${pull?.body || pull?.description || ''}`);
      const linked = related.some((item) => String(item?.number || '') === number);
      if (extras.length) {
        row.linkWarning = `还关联了其他 Issue：${extras.map((item) => `#${item.number}`).join('、')}。请到 PR 页面手动核对`;
      } else if (!mentioned && !linked) {
        row.linkWarning = `PR 说明里没有 #${number}，门禁可能认不出这次关联`;
      }
    } catch (error) {
      row.linkWarning = `核对 Issue 关联失败：${scrub(error.message || error)}`;
    }
  }
  try {
    await gitcode(token, 'POST', `${repoPathOf(target)}/pulls/${encodeURIComponent(row.number)}/comments`, { body: 'start build' });
    row.build = 'started';
  } catch (error) {
    row.build = 'failed';
    row.buildError = scrub(error.message || error);
  }
}

export async function submitDraft(draft, plan, token, login) {
  const fork = forkRemote(draft.remotes, login, plan.target);
  if (!fork) throw new Error(`没有找到 ${login} 名下、与 ${plan.target} 同名的 fork remote。请先 fork，并把该地址加到本地仓库。`);
  const live = await collectRepo(draft.repoPath, draft.id, { baseRef: draft.trackingRef, baseSource: draft.baseSource });
  if (live.headSha !== draft.headSha || live.commits.map((item) => item.sha).join() !== draft.commits.map((item) => item.sha).join()) {
    throw new Error('本地提交已经变化，请重新运行 ace pr');
  }
  const verifications = await readVerifications();
  const blocked = plan.pending.map((base) => portBlocker(draft, base, verifications, plan.target)).filter(Boolean);
  if (blocked.length && blocked.length === plan.pending.length) throw new Error(blocked[0]);
  const next = {
    ...draft,
    results: {
      issue: draft.results?.issue || null,
      pulls: [...(draft.results?.pulls || [])],
    },
  };
  if (plan.issue.mode === 'create' && !next.results.issue) {
    const title = plan.issue.title;
    const body = plan.issue.body || plan.description;
    const label = issueLabel(title);
    const payload = { title, body };
    if (label) payload.labels = label;
    let created;
    try {
      created = await gitcode(token, 'POST', `${repoPathOf(plan.target)}/issues`, payload);
    } catch (error) {
      if (!label) throw error;
      created = await gitcode(token, 'POST', `${repoPathOf(plan.target)}/issues`, { title, body });
      next.results.issueLabelError = scrub(error.message || error);
    }
    next.results.issue = summarizeIssue(created, plan.target);
    if (label) next.results.issue.label = label;
  } else if (plan.issue.mode === 'existing' && !next.results.issue) {
    const owner = plan.issue.owner || plan.target.split('/')[0];
    const repo = plan.issue.repo || plan.target.split('/')[1];
    const found = await gitcode(token, 'GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(plan.issue.number)}`);
    const me = await tokenLogin(token);
    if (!isOwnIssue(found, me)) throw new Error(`#${plan.issue.number} 不是 ${me} 创建的 Issue，只能关联自己的 Issue`);
    next.results.issue = summarizeIssue(found, `${owner}/${repo}`);
  }
  const issueNumber = next.results.issue?.number || '';
  for (const base of plan.pending) {
    const row = { base, repo: plan.target, headBranch: headBranchFor(draft.id, base), url: '', number: '', error: '', build: '', linkWarning: '' };
    try {
      const sha = await readyCommit(next, token, plan.target, base, verifications);
      await pushHead(next, token, fork, sha, row.headBranch);
      const pull = await gitcode(token, 'POST', `${repoPathOf(plan.target)}/pulls`, {
        title: plan.title,
        body: skillPrBody({ description: plan.description, issueNumber, base }),
        head: `${fork.owner}:${row.headBranch}`,
        base,
      });
      row.number = String(pull?.iid || pull?.number || '');
      row.url = pull?.web_url || pull?.html_url || `https://gitcode.com/${plan.target}/pull/${row.number}`;
      await finishPull(token, plan.target, row, issueNumber);
    } catch (error) {
      row.error = scrub(error.message || error);
    }
    const previous = next.results.pulls.findIndex((item) => item.base === base);
    if (previous >= 0) next.results.pulls.splice(previous, 1, row);
    else next.results.pulls.push(row);
  }
  const failed = next.results.pulls.some((item) => item.error);
  const created = next.results.pulls.some((item) => item.url);
  next.status = created && !failed ? 'submitted' : (created ? 'partial' : 'draft');
  return next;
}
