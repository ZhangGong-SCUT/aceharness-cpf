export type PrReviewInputMode = 'pr' | 'event' | 'freeform' | 'empty';

export type PrReviewInput = {
  mode: PrReviewInputMode;
  prUrl: string | null;
  owner: string | null;
  repo: string | null;
  number: string | null;
  action: string | null;
  title: string | null;
  author: string | null;
  headRef: string | null;
  baseRef: string | null;
  headSha: string | null;
  headRepo: string | null;
};

const PR_URL_RE = /https?:\/\/[^\s`'\"<>]+\/(?:pulls?|merge_requests)\/(\d+)/i;
const OWNER_REPO_RE = /https?:\/\/(?:www\.)?(?:gitcode\.com|github\.com|gitee\.com)\/([^/\s]+)\/([^/\s?#]+)/i;

export const DEFAULT_PR_REVIEW_CONFIG = 'gitcode-pr-review.yaml';

export function prIdentityKey(
  owner?: string | null,
  repo?: string | null,
  number?: string | null,
): string {
  const normalizedOwner = String(owner || '').trim().toLowerCase();
  const normalizedRepo = String(repo || '').trim().toLowerCase().replace(/\.git$/i, '');
  const normalizedNumber = String(number || '').trim();
  if (!normalizedOwner || !normalizedRepo || !normalizedNumber) return '';
  return `${normalizedOwner}/${normalizedRepo}#${normalizedNumber}`;
}

export function emptyPrReviewInput(mode: PrReviewInputMode = 'empty'): PrReviewInput {
  return {
    mode,
    prUrl: null,
    owner: null,
    repo: null,
    number: null,
    action: null,
    title: null,
    author: null,
    headRef: null,
    baseRef: null,
    headSha: null,
    headRepo: null,
  };
}

const START_ACTIONS = new Set([
  'open',
  'opened',
  'update',
  'updated',
  'reopen',
  'reopened',
  'synchronize',
  'ready_for_review',
  'comment',
  'commented',
  'note',
  'reviewed',
]);

const SKIP_ACTIONS = new Set([
  'close',
  'closed',
  'merge',
  'merged',
  'assign',
  'unassign',
  'labeled',
  'unlabeled',
  'edited',
  'review_requested',
  'review_request_removed',
]);

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function asText(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return '';
}

function parseOwnerRepo(text: string): { owner: string; repo: string } | null {
  const match = text.match(OWNER_REPO_RE);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ''),
  };
}

function buildPrUrl(owner: string, repo: string, number: string, host = 'https://gitcode.com'): string {
  return `${host.replace(/\/+$/, '')}/${owner}/${repo}/pull/${number}`;
}

export function parseNameList(value: string | null | undefined): string[] {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function isOwnPrAuthor(author: string | null | undefined, allowedAuthors: string[]): boolean {
  const login = String(author || '').trim().toLowerCase();
  if (!login || allowedAuthors.length === 0) return false;
  return allowedAuthors.some((item) => item === login);
}

export function isWatchedRepo(owner: string | null | undefined, repo: string | null | undefined, watchedRepos: string[]): boolean {
  if (watchedRepos.length === 0) return true;
  const ownerName = String(owner || '').trim().toLowerCase();
  const repoName = String(repo || '').trim().replace(/\.git$/i, '').toLowerCase();
  const full = `${ownerName}/${repoName}`;
  if (full === '/') return false;
  return watchedRepos.some((item) => {
    const rule = String(item || '').trim().toLowerCase().replace(/\.git$/i, '');
    if (rule.endsWith('/*')) return rule.slice(0, -2) === ownerName && Boolean(repoName);
    return rule === full || rule === repoName;
  });
}

export function describeIgnoredPr(input: {
  author?: string | null;
  owner?: string | null;
  repo?: string | null;
  allowedAuthors: string[];
  watchedRepos: string[];
}): string | null {
  if (input.allowedAuthors.length === 0) {
    return '未配置 ACE_GITCODE_PR_AUTHOR，只处理自己账号的 PR，已忽略';
  }
  if (!isOwnPrAuthor(input.author, input.allowedAuthors)) {
    return `忽略他人 PR author=${input.author || 'unknown'}`;
  }
  if (!isWatchedRepo(input.owner, input.repo, input.watchedRepos)) {
    return `忽略未监听仓库 ${input.owner || '?'}/${input.repo || '?'}`;
  }
  return null;
}

export function parsePrUrl(text: string | null | undefined): PrReviewInput | null {
  const raw = String(text || '').trim();
  const match = raw.match(PR_URL_RE);
  if (!match) return null;
  const number = match[1];
  const parsed = parseOwnerRepo(match[0]);
  return {
    mode: 'pr',
    prUrl: match[0],
    owner: parsed?.owner || null,
    repo: parsed?.repo || null,
    number,
    action: null,
    title: null,
    author: null,
    headRef: null,
    baseRef: null,
    headSha: null,
    headRepo: null,
  };
}

export function classifyPrReviewInput(globalContext: string | null | undefined): PrReviewInput {
  const text = String(globalContext || '').trim();
  if (!text) {
    return emptyPrReviewInput('empty');
  }

  const fromUrl = parsePrUrl(text);
  const owner = firstText(text.match(/^owner:\s*(.+)$/im)?.[1], fromUrl?.owner);
  const repo = firstText(text.match(/^repo:\s*(.+)$/im)?.[1], fromUrl?.repo);
  const number = firstText(text.match(/^(?:number|pr_number):\s*(\d+)\s*$/im)?.[1], fromUrl?.number);
  const action = firstText(text.match(/^action:\s*(.+)$/im)?.[1]);
  const title = firstText(text.match(/^title:\s*(.+)$/im)?.[1]);
  const author = firstText(text.match(/^author:\s*(.+)$/im)?.[1]);
  const headRef = firstText(text.match(/^head_ref:\s*(.+)$/im)?.[1]);
  const baseRef = firstText(text.match(/^base_ref:\s*(.+)$/im)?.[1]);
  const headSha = firstText(text.match(/^head_sha:\s*(.+)$/im)?.[1]);
  const headRepo = firstText(text.match(/^head_repo:\s*(.+)$/im)?.[1]);
  const prUrl = firstText(text.match(/^pr_url:\s*(.+)$/im)?.[1], fromUrl?.prUrl);

  if (fromUrl || (owner && repo && number) || prUrl) {
    const resolvedNumber = number || fromUrl?.number || null;
    const resolvedOwner = owner || fromUrl?.owner || null;
    const resolvedRepo = repo || fromUrl?.repo || null;
    return {
      mode: action || title || headRef || author ? 'event' : 'pr',
      prUrl: prUrl || (resolvedOwner && resolvedRepo && resolvedNumber
        ? buildPrUrl(resolvedOwner, resolvedRepo, resolvedNumber)
        : fromUrl?.prUrl || null),
      owner: resolvedOwner,
      repo: resolvedRepo,
      number: resolvedNumber,
      action: action || null,
      title: title || null,
      author: author || null,
      headRef: headRef || null,
      baseRef: baseRef || null,
      headSha: headSha || null,
      headRepo: headRepo || null,
    };
  }

  return emptyPrReviewInput('freeform');
}

export function shouldStartPrReview(action: string | null | undefined, extra?: { merged?: boolean; state?: string }): boolean {
  const normalized = String(action || '').trim().toLowerCase();
  if (!normalized) return true;
  if (extra?.merged === true || extra?.state === 'merged') return false;
  if (SKIP_ACTIONS.has(normalized) && !START_ACTIONS.has(normalized)) return false;
  if (START_ACTIONS.has(normalized)) return true;
  return !SKIP_ACTIONS.has(normalized);
}

export function formatPrReviewContext(input: {
  owner: string;
  repo: string;
  number: string | number;
  prUrl?: string;
  action?: string;
  title?: string;
  body?: string;
  state?: string;
  headRef?: string;
  baseRef?: string;
  headSha?: string;
  headRepo?: string;
  author?: string;
  event?: string;
}): string {
  const number = String(input.number);
  const prUrl = input.prUrl || buildPrUrl(input.owner, input.repo, number);
  return [
    'GitCode 自己的 PR 自修任务',
    `event: ${input.event || 'manual'}`,
    `action: ${input.action || 'open'}`,
    `pr_url: ${prUrl}`,
    `owner: ${input.owner}`,
    `repo: ${input.repo}`,
    `number: ${number}`,
    `title: ${input.title || ''}`,
    `state: ${input.state || 'open'}`,
    `head_ref: ${input.headRef || ''}`,
    `head_repo: ${input.headRepo || ''}`,
    `base_ref: ${input.baseRef || ''}`,
    `head_sha: ${input.headSha || ''}`,
    `author: ${input.author || ''}`,
    input.body ? `body:\n${input.body}` : '',
  ].filter(Boolean).join('\n');
}

export function formatPrReviewInputPrompt(globalContext: string | null | undefined): string {
  const input = classifyPrReviewInput(globalContext);
  if (input.mode === 'empty') {
    return [
      '# PR 自修输入形态',
      'mode=empty',
      'globalContext 为空。向人类确认自己账号的 GitCode PR 链接后再继续，不要编造 PR 号。',
    ].join('\n');
  }
  if (input.mode === 'freeform') {
    return [
      '# PR 自修输入形态',
      'mode=freeform',
      '没有可解析的 GitCode PR 链接。禁止编造 PR 号。只处理自己账号提交的 PR。',
    ].join('\n');
  }
  return [
    '# PR 自修输入形态',
    `mode=${input.mode}`,
    input.prUrl ? `prUrl=${input.prUrl}` : '',
    input.owner ? `owner=${input.owner}` : '',
    input.repo ? `repo=${input.repo}` : '',
    input.number ? `number=${input.number}` : '',
    input.author ? `author=${input.author}` : '',
    input.action ? `action=${input.action}` : '',
    '只处理自己账号提交的 PR。按 gitcode-pr-review Skill：识别 → 等待门禁 → 按 phase 分流修复 → 推 fork 并评论 start build → 再等。不要自动 submit，不要处理别人的 PR。',
  ].filter(Boolean).join('\n');
}

export function extractPullRequest(payload: unknown): Record<string, any> | null {
  const body = asRecord(payload);
  if (!body) return null;
  const mergeRequest = Array.isArray(body.merge_request)
    ? body.merge_request[0]
    : body.merge_request;
  return asRecord(body.pull_request)
    || asRecord(mergeRequest)
    || asRecord(body.object_attributes)
    || null;
}

export function parseGitcodeWebhookPayload(payload: unknown, options: { includeClosed?: boolean } = {}): {
  accepted: boolean;
  reason: string;
  context: string;
  input: PrReviewInput;
  action: string;
  event: string;
} {
  const body = asRecord(payload) || {};
  const pull = extractPullRequest(body);
  const repository = asRecord(body.repository) || {};
  const project = asRecord(body.project) || {};
  const head = asRecord(pull?.head) || asRecord(pull?.source) || {};
  const base = asRecord(pull?.base) || asRecord(pull?.target) || {};
  const action = firstText(body.action, pull?.action, body.object_attributes?.action).toLowerCase();
  const event = firstText(body.hook_name, body.object_kind, body.event, 'merge_request');
  const prUrl = firstText(pull?.html_url, pull?.url, pull?.web_url, pull?.target_url);
  const fromUrl = parsePrUrl(prUrl);
  const number = firstText(pull?.number, pull?.iid, fromUrl?.number);
  const repoPath = firstText(
    repository.full_name,
    repository.path_with_namespace,
    repository.full_path,
    project.full_name,
    project.path_with_namespace,
    project.full_path,
    project.path,
  );
  const parsedRepo = repoPath.includes('/')
    ? { owner: repoPath.split('/')[0], repo: repoPath.split('/').slice(1).join('/') }
    : parseOwnerRepo(prUrl) || {
      owner: firstText(
        asRecord(repository.namespace)?.path,
        asRecord(project.namespace)?.path,
        repository.namespace,
        repository.owner?.login,
        repository.owner?.path,
        project.namespace,
        fromUrl?.owner,
        body.owner,
      ),
      repo: firstText(repository.path, repository.name, project.path, project.name, fromUrl?.repo, body.repo),
    };
  const owner = parsedRepo.owner;
  const repo = String(parsedRepo.repo || '').replace(/\.git$/i, '');
  const title = firstText(pull?.title);
  const author = firstText(
    pull?.user?.login,
    pull?.user?.username,
    pull?.author?.username,
    pull?.author?.login,
    body.user?.login,
    body.user?.username,
    body.user_username,
  );
  const state = firstText(pull?.state, pull?.merge_status);
  const merged = pull?.merged === true || state === 'merged' || action === 'merge' || action === 'merged';
  const sourceRepo = asRecord(head.repo) || asRecord(pull?.source) || asRecord(body.source) || {};
  const headRepo = firstText(
    sourceRepo.full_name,
    sourceRepo.path_with_namespace,
    sourceRepo.full_path,
    head.full_name,
    pull?.source_path_with_namespace,
  ).replace(/\.git$/i, '') || null;
  const input: PrReviewInput = {
    mode: owner && repo && number ? 'event' : 'freeform',
    prUrl: prUrl || (owner && repo && number ? buildPrUrl(owner, repo, number) : null),
    owner: owner || null,
    repo: repo || null,
    number: number || null,
    action: action || null,
    title: title || null,
    author: author || null,
    headRef: firstText(head.ref, pull?.head_branch, pull?.source_branch) || null,
    baseRef: firstText(base.ref, pull?.base_branch, pull?.target_branch) || null,
    // merge_commit_sha identifies a merge result, never the source branch tip.
    headSha: firstText(head.sha, head.id, pull?.last_commit?.id, pull?.diff_refs?.head_sha) || null,
    headRepo,
  };

  if (!pull || !owner || !repo || !number) {
    return {
      accepted: false,
      reason: `payload 缺少 pull_request / owner / repo / number owner=${owner || '-'} repo=${repo || '-'} number=${number || '-'}`,
      context: '',
      input,
      action,
      event,
    };
  }

  if (!shouldStartPrReview(action, { merged, state }) && !(options.includeClosed && (merged || state === 'closed' || /^(close|closed)$/.test(action)))) {
    return {
      accepted: false,
      reason: `忽略事件 action=${action || 'unknown'} state=${state || 'unknown'}`,
      context: '',
      input,
      action,
      event,
    };
  }

  return {
    accepted: true,
    reason: 'ok',
    context: formatPrReviewContext({
      owner,
      repo,
      number,
      prUrl: input.prUrl || undefined,
      action,
      title,
      body: firstText(pull.body, pull.description),
      state,
      headRef: input.headRef || undefined,
      headRepo: input.headRepo || undefined,
      baseRef: input.baseRef || undefined,
      headSha: input.headSha || undefined,
      author: author || undefined,
      event,
    }),
    input,
    action,
    event,
  };
}
