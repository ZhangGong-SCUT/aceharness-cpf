/**
 * PR 提交草稿的纯判断：远程地址、分支名、Issue 关联和提交请求。
 * 不读磁盘、不访问 GitCode。
 */

const REF_RE = /^(?!\/)(?!.*\/\/)(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function redactRemote(url) {
  return String(url || '')
    .replace(/\/\/(?:[^/@\s]+@)/, '//')
    .replace(/\boauth2:[^@\s]+@/gi, '');
}

export function parseGitRemote(url) {
  const raw = redactRemote(url).trim();
  const cleaned = raw.replace(/\.git$/i, '');
  let match = cleaned.match(/^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)\/([^/]+)\/([^/]+)$/i);
  if (!match) match = cleaned.match(/^git@([^:]+):([^/]+)\/([^/]+)$/i);
  if (!match) return null;
  return { host: match[1], owner: match[2], repo: match[3] };
}

export function parseRemoteLines(text) {
  const byName = new Map();
  for (const line of String(text || '').split('\n')) {
    const match = line.replace(/\s+\[[^\]]+\]\s*$/, '').match(/^([^\s]+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match || match[3] !== 'fetch') continue;
    const parsed = parseGitRemote(match[2]);
    if (!parsed || byName.has(match[1])) continue;
    byName.set(match[1], { name: match[1], ...parsed });
  }
  return [...byName.values()];
}

export function isSafeRef(name) {
  return REF_RE.test(String(name || ''));
}

export function headBranchFor(draftId, base) {
  const id = String(draftId || '').replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase() || 'draft';
  const tail = String(base || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'base';
  return `submit/${id}/${tail}`;
}

export function parseIssueRef(text) {
  const raw = String(text || '').trim();
  const url = raw.match(/https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i);
  if (url) return { owner: url[1], repo: url[2].replace(/\.git$/i, ''), number: url[3] };
  const num = raw.match(/^#?(\d+)$/);
  if (num) return { owner: '', repo: '', number: num[1] };
  return null;
}

export function suggestedTarget(remotes) {
  const list = Array.isArray(remotes) ? remotes : [];
  const picked = list.find((item) => item.name === 'upstream' && item.owner && item.repo)
    || list.find((item) => item.name === 'origin' && item.owner && item.repo);
  return picked ? `${picked.owner}/${picked.repo}` : '';
}

/** 推送目标是当前用户名下、与目标仓库同名的 fork。 */
export function forkRemote(remotes, login, target) {
  const repoName = String(target || '').split('/')[1] || '';
  const targetOwner = String(target || '').split('/')[0] || '';
  const wantLogin = String(login || '').toLowerCase();
  const list = (Array.isArray(remotes) ? remotes : []).filter((item) => item.owner && item.repo);
  const sameRepo = (item) => item.repo.toLowerCase() === repoName.toLowerCase();
  return list.find((item) => sameRepo(item) && item.owner.toLowerCase() === wantLogin)
    || list.find((item) => sameRepo(item) && item.owner.toLowerCase() !== targetOwner.toLowerCase())
    || null;
}

export function prBody(description, issueNumber) {
  const text = String(description || '').trim();
  const number = String(issueNumber || '').replace(/\D/g, '');
  if (!number) return text;
  if (new RegExp(`(?:^|\\s)#${number}\\b`).test(text)) return text;
  return `${text}${text ? '\n\n' : ''}#${number}`;
}

const ISSUE_LABELS = {
  feat: 'feature',
  fix: 'bug',
  docs: 'documentation',
  perf: 'performance',
  test: 'test',
  chore: 'CICD',
};

/** commit 标题的 type 前缀对应公仓 label。对不上就留空，不猜。 */
export function issueLabel(title) {
  const type = String(title || '').match(/^([a-z]+)(?:\([^)]+\))?:/i)?.[1].toLowerCase() || '';
  return ISSUE_LABELS[type] || '';
}

/**
 * PR 说明按 ohos-flutter-submit-code 的英文模板。
 * 用户已经按这个模板写过时不再套一层。签名行去掉。末尾保留本次 Issue 编号，供门禁识别。
 */
export function generatedPrBody(body, issueNumber) {
  return /^## Why are these changes being made\?/m.test(String(body || ''))
    ? prBody(body, issueNumber)
    : '';
}

export function skillPrBody({ description, issueNumber, base }) {
  const text = String(description || '').replace(/^Signed-off-by:.*$/gm, '').trim();
  const generated = generatedPrBody(text, issueNumber);
  if (generated) return generated;
  const why = text.split(/\n\s*\n/)[0] || 'TBD';
  const branch = String(base || '').trim();
  const body = [
    '## Why are these changes being made?',
    '',
    why,
    '',
    '## Changelog',
    '',
    text || 'TBD',
    '',
    '## Test Plan',
    '',
    'TBD',
    '',
    '### Test Run Result Summary',
    '',
    'TBD',
    '',
    '## Checklist',
    '- [x] No illegal compatibility changes are involved; if any are, they have passed the corresponding review.',
    '- [x] No performance issues are present or have been tested and there is no performance degradation.',
    '- [x] Compliant with the corresponding coding standards.',
    '- [x] No document updates are required, or the documents have been updated.',
    '- [x] In terms of testability requirements, necessary self-test cases have been added.',
    '- [x] No illegal file introductions exist, including images and code, etc.',
    '- [x] The branches that need to be merged have been confirmed.',
    branch ? `  - [x] ${branch}` : '',
  ].filter((line, index, list) => line !== '' || list[index - 1] !== '').join('\n');
  return prBody(body, issueNumber);
}

export function validateSubmitRequest(draft, body) {
  const errors = [];
  if (!draft) errors.push('草稿不存在');
  else if (draft.status === 'submitted') errors.push('这份草稿已经提交完成');
  if (draft && !draft.commits?.length) errors.push('相对对比基准没有可提交的 commit');
  const target = String(body?.target || '').trim();
  if (!REPO_RE.test(target)) errors.push('目标仓库格式应为 owner/repo');
  const bases = [...new Set((Array.isArray(body?.bases) ? body.bases : []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (!bases.length) errors.push('至少选择一个目标分支');
  if (bases.length > 8) errors.push('一次最多选择 8 个目标分支');
  for (const base of bases) {
    if (!isSafeRef(base)) errors.push(`目标分支不合法：${base}`);
  }
  const title = String(body?.title || '').trim();
  if (!title) errors.push('PR 标题不能为空');
  if (title.length > 200) errors.push('PR 标题不能超过 200 字');
  const description = String(body?.body || '').slice(0, 20000);
  const mode = body?.issue?.mode;
  if (!['none', 'existing', 'create'].includes(mode)) errors.push('Issue 选项无效');
  let issue = { mode: mode || '' };
  if (mode === 'existing') {
    const ref = parseIssueRef(body.issue.url || body.issue.number || '');
    if (!ref) errors.push('请填写已有 Issue 的地址或编号');
    else issue = { mode, ...ref };
  }
  if (mode === 'create') {
    const issueTitle = String(body.issue.title || '').trim();
    if (!issueTitle) errors.push('新建 Issue 需要标题');
    if (issueTitle.length > 200) errors.push('Issue 标题不能超过 200 字');
    issue = { mode, title: issueTitle, body: String(body.issue.body || '').slice(0, 20000) };
  }
  const done = new Set((draft?.results?.pulls || []).filter((item) => item?.url).map((item) => item.base));
  const pending = bases.filter((base) => !done.has(base));
  return {
    ok: errors.length === 0,
    errors,
    target,
    bases,
    pending,
    title,
    description,
    issue,
    existingIssue: draft?.results?.issue?.number ? draft.results.issue : null,
  };
}
