/** OpenHarmony DCP 门禁分类：标签 + openharmony_ci 评论，不用 commit status。 */

import { describeGateLogVerdict } from './gate-log-analysis.mjs';

export const GATE_PHASES = [
  'running',
  'need_start_build',
  'static_failed',
  'compile_failed',
  'test_failed',
  'dco_failed',
  'ai_review_pending',
  'green',
  'blocked_no_issue',
  'blocked_rate_limit',
  'unknown',
];

export const CLASSIFY_ROUTES = {
  分类处置: {
    read_error: { verdict: 'conditional_pass', next_state: '挂起' },
    blocked_permission: { verdict: 'fail', next_state: '人工确认' },
    // R2：DCP 已明确拒绝触发（触发额度用尽）。优先于普通等待和再次触发，直接转人工确认。
    blocked_rate_limit: { verdict: 'fail', next_state: '人工确认' },
    user_fix: { verdict: 'fail', next_state: '检视修复' },
    review_pending_decision: { verdict: 'conditional_pass', next_state: '挂起' },
    dco_failed: { verdict: 'fail', next_state: 'DCO修复' },
    running: { verdict: 'conditional_pass', next_state: '挂起' },
    default: { verdict: 'pass', next_state: '分流静态' },
  },
  分流静态: {
    static_failed: { verdict: 'fail', next_state: '静态修复' },
    running: { verdict: 'conditional_pass', next_state: '挂起' },
    default: { verdict: 'pass', next_state: '分流编译' },
  },
  分流编译: {
    compile_failed: { verdict: 'fail', next_state: '编译修复' },
    running: { verdict: 'conditional_pass', next_state: '挂起' },
    default: { verdict: 'pass', next_state: '分流测试' },
  },
  分流测试: {
    test_failed: { verdict: 'fail', next_state: '人工确认' },
    blocked_no_issue: { verdict: 'fail', next_state: '人工确认' },
    unknown: { verdict: 'fail', next_state: '人工确认' },
    running: { verdict: 'conditional_pass', next_state: '挂起' },
    default: { verdict: 'pass', next_state: '分流检视' },
  },
  分流检视: {
    ai_review_pending: { verdict: 'fail', next_state: '检视修复' },
    ai_unreviewed: { verdict: 'fail', next_state: '同步修复' },
    review_pending_decision: { verdict: 'conditional_pass', next_state: '挂起' },
    running: { verdict: 'conditional_pass', next_state: '挂起' },
    default: { verdict: 'pass', next_state: '分流触发' },
  },
  分流触发: {
    need_start_build: { verdict: 'fail', next_state: '推送并触发' },
    running: { verdict: 'conditional_pass', next_state: '挂起' },
    default: { verdict: 'pass', next_state: '就绪' },
  },
};

const LABEL_ALIASES = {
  dco_ok: ['dco检查成功', 'dco校验成功'],
  dco_fail: ['dco检查失败', 'dco校验失败'],
  static_ok: ['静态检查成功'],
  static_fail: ['静态检查失败'],
  compile_ok: ['编译成功'],
  compile_fail: ['编译失败'],
  test_ok: ['冒烟测试成功', '测试成功'],
  test_fail: ['冒烟测试失败', '测试失败'],
  ai_done: ['AI已检视'],
  ai_running: ['AI检视中'],
  ai_skip: ['AI未检视'],
};

function compact(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

export function normalizeLabels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') return String(item.name || item.label || item.title || '').trim();
      return '';
    })
    .filter(Boolean);
}

export function normalizeComments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (!item || typeof item !== 'object') {
      return { author: '', body: String(item || ''), created_at: '' };
    }
    return {
      author: String(item.user?.login || item.user?.username || item.author?.username || item.author || '').trim(),
      body: String(item.body || item.note || '').trim(),
      created_at: String(item.created_at || item.updated_at || ''),
    };
  }).filter((item) => item.body);
}

/**
 * GitCode 的 Issue 号和 PR 号是两套序号。
 * GET issues/{n}/comments 可能是另一张 Issue，不能当成 PR 讨论区。
 */
export function commentBelongsToPull(item) {
  if (!item || typeof item !== 'object') return false;
  const type = String(item.comment_type || item.noteable_type || '').toLowerCase();
  if (['pr_comment', 'diffnote', 'diff_note', 'out_diffnote', 'review', 'reviewcomment'].includes(type)) {
    return true;
  }
  const target = item.target;
  if (target && typeof target === 'object') {
    if (target.pull || target.pull_request || target.merge_request) return true;
    if (target.issue) return false;
  }
  if (type === 'discussionnote' || type === 'discussion_note') return false;
  return true;
}

function hasLabel(labels, aliases) {
  const compactLabels = labels.map(compact);
  return aliases.some((name) => compactLabels.includes(compact(name)));
}

function commentText(item) {
  return `${item.author} ${item.body}`;
}

export function isCiBotComment(item) {
  return /openharmony_ci|harmony.*ci|dcp/i.test(item.author || '');
}

function commentBodyText(item) {
  return String(item?.body || '').replace(/<[^>]+>/g, ' ');
}

export function isWelcomeComment(item) {
  return /感谢提交\s*pull\s*requests?|感谢提交合并请求/i.test(commentBodyText(item));
}

export function isDcoFailWelcome(item) {
  return /未通过dco校验|dco校验失败|dco检查失败/i.test(item.body || '');
}

/**
 * DCO 失败信号按时间序判定：DCO 失败文本（欢迎评论内嵌或独立 check dco 评论）
 * 只有出现在最后一条欢迎评论之后才算当前状态——新 push 会发干净的新欢迎评论，
 * 历史失败文本（邮箱修掉/签署后）不能永远把 phase 钉在 dco_failed（1913 曾因此死锁 6 轮）。
 */
function dcoFailIsCurrent(comments) {
  let lastWelcomeIdx = -1;
  let lastDcoFailIdx = -1;
  for (let i = 0; i < comments.length; i++) {
    if (!isCiBotComment(comments[i])) continue;
    if (isWelcomeComment(comments[i]) || isRevisionResetComment(comments[i])) lastWelcomeIdx = i;
    if (isDcoFailWelcome(comments[i])) lastDcoFailIdx = i;
  }
  return lastDcoFailIdx !== -1 && lastDcoFailIdx >= lastWelcomeIdx;
}

export function isStartBuildComment(item) {
  return /^\s*start\s+build\s*$/i.test(item.body || '');
}

function isGateRateLimitedComment(item) {
  return isCiBotComment(item) && /限制提交|触发门禁次数已达到上限/.test(item.body || '');
}

function isGateFailComment(item) {
  return isCiBotComment(item) && /门禁未通过|noPass/i.test(item.body || '');
}

/** CI 拒绝触发（如非 PR 提交人发 start build、重复触发）：该次 start build 无效。
 *  注意不能匹配「当前正在执行的门禁任务已自动中止」——那是 push 中止构建的评论，不是触发被拒。 */
function isGateTriggerRejectedComment(item) {
  return isCiBotComment(item) && /不允许触发|无权限触发|触发.*失败|重复触发|请勿重复|已在构建/.test(item.body || '');
}

function isGateStartComment(item) {
  return isCiBotComment(item) && /门禁构建开始|开始构建|正在构建/.test(item.body || '');
}

/**
 * 测试失败是否为 DCP 平台抖动（ecotest timeout）：最近一条门禁失败评论里的失败详情
 * 全部是 timeout/基础设施类（含 failed(IGNORE)），无任何真实断言失败。
 * #1927/#1978 同款：全部 ecotest timeout，DCP 自己都给部分标了 IGNORE。
 * 解析不到失败原因或存在裸 failed（无原因）时保守返回 false——宁可人工确认，不烧重试预算。
 */
export function isFlakyTestFailure(comments) {
  const latest = comments.filter(isGateFailComment).at(-1);
  const body = String(latest?.body || '');
  if (!body) return false;
  // 存在无原因的裸 failed（如纯 <td>failed</td>）→ 无法归因为平台抖动，保守当真失败
  if (/\bfailed(?!\()/i.test(body)) return false;
  const causes = [...body.matchAll(/failed(?:\(IGNORE\))?\(([^)]+)\)/gi)].map((m) => m[1]);
  if (causes.length === 0) return false;
  return causes.every((cause) => /timeout|timed?\s*out|ecotest|infra(structure)?|internal\s*error/i.test(cause));
}

const INFRA_FAILURE_RE = /timeout|timed?\s*out|ecotest|infra(structure)?|internal\s*error|超时|环境|网络/i;

/**
 * R3：从最近一条门禁失败评论提取失败类别，先判原因再决定是否按环境抖动重试。
 * - infra：失败详情全部为 timeout/基础设施类（如 ecotest timeout）→ 确属 DCP 环境抖动，可重试
 * - deterministic：出现确定性原因（failed(compile failed) / noPass / 真实断言失败 / 裸 failed）→ 直接进对应修复
 * - unknown：拿不到失败详情（未获取到日志）→ 原因未知，不按"已确认抖动"重试
 * - none：当前没有门禁失败评论
 */
export function extractGateFailureCause(comments) {
  const latest = comments.filter(isGateFailComment).at(-1);
  const body = String(latest?.body || '');
  if (!body) return { kind: 'none', causes: [] };
  const causes = [...body.matchAll(/failed(?:\(IGNORE\))?\(([^)]+)\)/gi)].map((m) => m[1]);
  const bareFailed = /\bfailed(?!\()/i.test(body);
  const noPass = /noPass/i.test(body);
  if (causes.length > 0 && !bareFailed && !noPass && causes.every((cause) => INFRA_FAILURE_RE.test(cause))) {
    return { kind: 'infra', causes };
  }
  if (bareFailed || noPass || causes.some((cause) => !INFRA_FAILURE_RE.test(cause))) {
    return { kind: 'deterministic', causes };
  }
  return { kind: 'unknown', causes };
}

/**
 * 真正的 push 确认评论（版本边界）：「监测到PR…代码有更新…已自动中止」或「代码有更新,重置PR验证状态」。
 * CI 对 start build 的响应（「本地或库上代码有更新…门禁构建开始」）不是版本边界——
 * 同一份代码，若当边界会把紧邻其前的 start build 挤出窗口，误判 need_start_build 重复触发。
 */
export function isRevisionResetComment(item) {
  return isCiBotComment(item)
    && /代码有更新|重置.*验证状态/.test(item.body || '')
    && !/门禁构建开始|正在构建/.test(item.body || '');
}

export const DEFAULT_START_BUILD_MAX = 3;
// 平台抖动（ecotest timeout 等，无断言失败）的独立重试上限：
// 抖动重跑期望收益高（环境恢复即绿），真失败重跑纯浪费，故分账计预算。
export const DEFAULT_JITTER_RETRY_MAX = 5;

/** AI 检视机器人白名单：默认 cpf-manager，可用 ACE_GITCODE_REVIEW_BOTS 扩展（逗号分隔）。 */
export function parseReviewBots(extra = '') {
  const raw = `${process.env.ACE_GITCODE_REVIEW_BOTS || ''},${extra || ''}`;
  return Array.from(new Set(
    ['cpf-manager', ...raw.split(/[,;\s]+/)]
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  ));
}

/**
 * AI 检视意见判定（1913/1914 事故修复）：
 * 旧正则 `AI\s*检视|AI Review` 认不出「【AI-Review】」（连字符），cpf-manager 也不匹配
 * 旧的 login 正则——真意见 ai_review=false，全靠 source==='diff' 的假规则兜底。
 * 现在白名单作者优先；其他账号正文带 AI-Review/AI检视 标记的也算（换机器人不用改代码）。
 */
export function isAiReviewComment(item) {
  const login = String(item?.author || '').trim().toLowerCase();
  if (parseReviewBots().includes(login)) return true;
  return /【AI[-\s]?Review】|AI[-\s]?检视|AI\s*Review|AI评审|generated by|code review bot/i
    .test(String(item?.body || ''));
}

/** PR 口令/刷屏评论（start build / check dco / submit / 纯数字）不是检视意见。 */
export function isPrCommandComment(item) {
  const body = String(item?.body || '').trim();
  if (/^(start\s+build|check\s+dco|submit)$/i.test(body)) return true;
  return /^\d+$/.test(body);
}

/**
 * CI/系统播报账号（openharmony_ci / openharmony_dcp 等）。只用于剔除检视意见噪声；
 * 比 isCiBotComment 的模糊匹配严格，避免误伤人名里含 dcp/ci 的贡献者。
 */
export function isCiBroadcastComment(item) {
  return /^openharmony[_-]/i.test(String(item?.author || '').trim());
}

/** GitCode 系统事件播报（加/删标签、推送、审批等），若以评论形态返回也不是检视意见。 */
export function isSystemEventComment(item) {
  return /^(added|removed) label\b|^set .+ as (approver|reviewer|tester|merger)\b|^approval (passed|request changes)\b|^pushed \d+ commits?\b|^force-pushed\b|^reset test status\b|^set as a draft\b|^draft state\b|^associated issue\b|^closed associated issue\b|^merged pull request\b/i
    .test(String(item?.body || '').trim());
}

/**
 * 单条 PR 评论分类（在 normalizeComments/normalizeComment 之后调用）：
 * system | command | ci | ai_review | diff_comment | conversation
 * 顺序敏感：系统事件先于 ai_review（cpf-manager 也会发「Added label: AI已检视」）。
 */
export function classifyPrComment(comment) {
  if (isSystemEventComment(comment)) return 'system';
  if (isPrCommandComment(comment)) return 'command';
  if (isCiBroadcastComment(comment)) return 'ci';
  if (isAiReviewComment(comment)) return 'ai_review';
  if (comment?.path || comment?.diff_hunk || comment?.inline) return 'diff_comment';
  return 'conversation';
}

/**
 * 评论/提交时间比较。GitCode 评论是 +08:00 偏移、commit 时间可能是 Z 格式，
 * 字典序比较会错（'07:44Z' < '14:08+08:00' 但实际 07:44Z=15:44+08:00 更晚），
 * 必须解析成时间戳比。解析失败回退字典序。
 */
function compareCommentTime(a, b) {
  const left = String(a.created_at || '');
  const right = String(b.created_at || '');
  const delta = Date.parse(left) - Date.parse(right);
  return Number.isFinite(delta) ? delta : left.localeCompare(right);
}

export function commentTimeLE(a, b) {
  const ta = Date.parse(String(a || ''));
  const tb = Date.parse(String(b || ''));
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta <= tb;
  return String(a || '') <= String(b || '');
}

/**
 * 从 PR 评论里筛出「需按意见修改」的检视意见（1913/1914 事故修复）。
 *
 * 背景：GitCode 的 pulls/comments 返回整个 PR 会话（不只行内评论），旧规则把
 * source==='diff' 全当意见 → spam「1」/CI 播报/「start build」共 20 条全算「需修改」，
 * 而真意见反而漏报。现在只认 AI 检视意见和带行内上下文的人工评论。
 *
 * stale（针对旧代码的意见，不计入 actionable）有两条等价边界，取并集：
 * 1. reset 评论边界：最后一次「代码有更新」CI 评论（isRevisionResetComment）之前
 * 2. push 时间边界（last_pushed_at，由 fetch-ai-review 从 pulls/{n}/commits 传入）：
 *    最后一次 commit 之前。DCP 限流期间的 push 不会产生 reset 评论（1914 实测：
 *    15:34 限流 → 15:44 push b47ff35a → 无 reset 评论），只有这条边界能看见。
 * push 后检视机器人会重审，旧意见已被新代码覆盖；--include-stale 可合并回来兜底。
 */
export function selectActionableReviews(comments, options = {}) {
  const sorted = [...(Array.isArray(comments) ? comments : [])]
    .sort((a, b) => compareCommentTime(a, b));
  const includeStale = Boolean(options.include_stale);
  const includeConversation = Boolean(options.include_conversation);
  const lastPushedAt = String(options.last_pushed_at || '');

  const classified = sorted.map((comment) => ({ ...comment, kind: classifyPrComment(comment) }));
  const lastReset = classified.filter((item) => isRevisionResetComment(item)).at(-1);
  const lastResetAt = lastReset ? String(lastReset.created_at || '') : '';
  const isStale = (item) => {
    const at = String(item.created_at || '');
    if (!at) return '';
    if (lastResetAt && commentTimeLE(at, lastResetAt)) return 'code_updated';
    if (lastPushedAt && commentTimeLE(at, lastPushedAt)) return 'pushed_after';
    return '';
  };

  const actionable = [];
  const stale = [];
  const noise = [];
  for (const item of classified) {
    if (item.kind === 'system' || item.kind === 'command' || item.kind === 'ci') {
      noise.push(item);
      continue;
    }
    const isOpinion = item.kind === 'ai_review' || item.kind === 'diff_comment'
      || (includeConversation && item.kind === 'conversation');
    if (!isOpinion) {
      noise.push(item);
      continue;
    }
    const staleReason = isStale(item);
    if (staleReason) {
      const marked = { ...item, stale: true, stale_reason: staleReason };
      if (includeStale) actionable.push(marked);
      else stale.push(marked);
      continue;
    }
    actionable.push({ ...item, stale: false, stale_reason: '' });
  }

  return {
    actionable,
    stale,
    noise,
    counts: {
      actionable_count: actionable.length,
      ai_review_count: actionable.filter((item) => item.kind === 'ai_review').length,
      human_diff_comment_count: actionable.filter((item) => item.kind === 'diff_comment').length,
      stale_count: stale.length,
      noise_filtered_count: noise.length,
    },
  };
}

/**
 * 统计当前代码版本内被 CI 实际接受的 start build 次数与门禁状态。
 *
 * 计数只认「PR 作者本人的有效触发」：作者评论 start build 且其后 CI 回复「门禁构建开始」才 +1。以下不计：
 * - 别人评论的（即使被 CI 接受也不占作者的重试预算；但门禁在跑的事实由 start_build_posted 保留）
 * - CI 明确拒绝（非 PR 提交人评论 →「不允许触发门禁」）
 * - 重复触发（构建已在跑，CI 不再起新构建）
 * - 被 push 吞掉（start build 后 CI 只回「代码有更新，重置PR验证状态」没有构建开始——
 *   重置使触发失效，需要重新评论）
 */
export function countStartBuildAttempts(comments, author = '') {
  const authorKey = String(author || '').trim().toLowerCase();
  const isAuthorComment = (item) => !authorKey
    || String(item?.author || '').trim().toLowerCase() === authorKey;
  let lastStartIdx = -1;       // 最近一次 start build 评论（任何人，跨全历史）
  let lastAcceptedIdx = -1;    // 最近的「门禁构建开始」响应
  let lastCiFailIdx = -1;
  let lastAbortIdx = -1;
  let lastRateLimitIdx = -1;
  let lastTriggerRejectIdx = -1;
  let lastPushResetIdx = -1;   // 最近的真 push 确认（版本边界）

  for (let i = 0; i < comments.length; i++) {
    const item = comments[i];
    if (isGateRateLimitedComment(item)) lastRateLimitIdx = i;
    if (isGateFailComment(item)) lastCiFailIdx = i;
    if (isCiBotComment(item) && /已自动中止|任务已中止/.test(item.body || '')) lastAbortIdx = i;
    if (isGateTriggerRejectedComment(item)) lastTriggerRejectIdx = i;
    if (isRevisionResetComment(item)) lastPushResetIdx = i;
    if (isGateStartComment(item)) lastAcceptedIdx = i;
    if (isStartBuildComment(item) && !isCiBotComment(item)) lastStartIdx = i;
  }

  // 版本窗口内的 start build：全部（判 pending）与作者本人的（计预算）分开
  const startsAll = [];
  const startsByAuthor = [];
  for (let i = lastPushResetIdx + 1; i < comments.length; i++) {
    if (isStartBuildComment(comments[i]) && !isCiBotComment(comments[i])) {
      startsAll.push(i);
      if (isAuthorComment(comments[i])) startsByAuthor.push(i);
    }
  }
  // 作者的每次 start build，向后找到「任何人」的下一次 start build 为止，
  // 期间出现「门禁构建开始」才算被接受
  let acceptedCount = 0;
  for (const sIdx of startsByAuthor) {
    const nextStart = startsAll.find((x) => x > sIdx) ?? comments.length;
    for (let j = sIdx + 1; j < nextStart; j++) {
      if (isGateStartComment(comments[j])) { acceptedCount += 1; break; }
    }
  }
  const lastAcceptedStart = startsAll.length ? startsAll[startsAll.length - 1] : -1;
  const postedWindow = startsAll.length > 0;
  const acceptedInWindow = lastAcceptedIdx > lastPushResetIdx;
  const rejectionIdx = Math.max(lastTriggerRejectIdx, lastRateLimitIdx);
  const startBuildRejected = rejectionIdx !== -1 && rejectionIdx > lastStartIdx && rejectionIdx > lastAcceptedIdx;
  const latestAttemptAccepted = acceptedInWindow && lastAcceptedIdx > lastStartIdx && lastAcceptedIdx > rejectionIdx;

  // 抖动失败单独计预算：当前代码版本窗口内，每轮「门禁未通过」评论若是平台抖动
  // （全部 timeout/基础设施类失败），计入 jitter_fail_count——与真失败的 start_build_count 分账。
  let jitterFailCount = 0;
  for (let i = lastPushResetIdx + 1; i < comments.length; i++) {
    if (!isGateFailComment(comments[i])) continue;
    // 该轮失败之后若 CI 又开始过构建（下一轮 start build 已发），说明这轮失败已被重试过
    const body = String(comments[i].body || '');
    if (/\bfailed(?!\()/i.test(body)) continue;   // 裸 failed / 含断言失败 → 真失败
    const causes = [...body.matchAll(/failed(?:\(IGNORE\))?\(([^)]+)\)/gi)].map((m) => m[1]);
    if (causes.length > 0 && causes.every((cause) => /timeout|timed?\s*out|ecotest|infra(structure)?|internal\s*error/i.test(cause))) {
      jitterFailCount += 1;
    }
  }

  return {
    start_build_count: acceptedCount,
    start_build_posted: acceptedInWindow || (postedWindow && acceptedCount > 0),
    // R2：把「评论已发送」「CI 已接受」拆成两个独立事实，避免"发出 start build"被当成"构建已通过"。
    comment_sent: postedWindow,
    ci_accepted: latestAttemptAccepted,
    trigger_rejected: startBuildRejected,
    pending_start_build: postedWindow && !latestAttemptAccepted && !startBuildRejected,
    gate_fail_after_last_start: lastCiFailIdx > lastAcceptedStart && lastCiFailIdx !== -1 && lastCiFailIdx > lastPushResetIdx,
    gate_running_after_last_start: lastAcceptedIdx > lastCiFailIdx && lastAcceptedIdx > lastStartIdx,
    gate_aborted_after_ci_start: lastAbortIdx !== -1 && lastAbortIdx > lastAcceptedIdx,
    // 限流是历史评论、不是实时状态：其后 CI 又开始过构建即视为已解除
    rate_limited: lastRateLimitIdx !== -1 && lastRateLimitIdx > lastAcceptedIdx,
    reset_at_index: lastPushResetIdx,
    jitter_fail_count: jitterFailCount,
  };
}

export function isSubmitComment(item) {
  return /^\s*submit\s*$/i.test(item.body || '');
}

export function isNeedIssueComment(item) {
  return /未关联.*issue|必须关联.*issue|请关联.*issue|associated with an issue|associate.*issue/i.test(item.body || '');
}

export function extractReportUrl(text) {
  const match = String(text || '').match(/https?:\/\/dcp\.openharmony\.cn[^\s)\]'"]+/i);
  return match ? match[0] : '';
}

export function hasAssociatedIssue(pull, comments) {
  if (pull?.issue || pull?.issue_id || pull?.issue_iid || pull?.issue_url) return true;
  if (Array.isArray(pull?.issues) && pull.issues.length > 0) return true;
  if (Array.isArray(pull?.related_issues) && pull.related_issues.length > 0) return true;
  const blob = `${pull?.title || ''}\n${pull?.body || pull?.description || ''}`;
  return /#\d+/.test(blob);
}

function latestCiComment(comments) {
  const ci = comments.filter(isCiBotComment);
  return ci.length ? ci[ci.length - 1] : null;
}

function ciMentionsRunning(comments) {
  return comments.some((item) => (
    isCiBotComment(item)
    && /开始构建|已触发构建|正在构建|构建任务已|排队中|running|in progress|静态检查中|编译中/i.test(item.body || '')
    && !/未通过|失败|noPass|failed/i.test(item.body || '')
  ));
}

/**
 * 本轮门禁构建是否包含测试任务。
 * 只看**最新一条「门禁构建开始」CI 评论**是否列出测试任务——
 * 不能扫全部历史评论：历史轮次（或「代码门禁通过」报告正文）里出现
 * 「测试」字样，会把本轮纯编译门禁误判成「测试还在跑」
 * （pr1536/1537 教训：engine 仓门禁只含静态+编译，四绿却因旧评论
 * 含「测试」被判 running 永不收口）。
 * 含测试的门禁必须五项全绿（DCO/静态/编译/AI/冒烟测试）才算 green；
 * 测试没出终态前禁止提前判绿收口（#1958 教训）。
 */
function ciMentionsTests(comments) {
  const sorted = [...comments].sort((a, b) => compareCommentTime(a, b));
  const startComments = sorted.filter((item) => (
    isCiBotComment(item)
    && /门禁构建开始|开始构建|已触发构建/.test(commentBodyText(item))
  ));
  const latestStart = startComments[startComments.length - 1];
  if (!latestStart) return false;
  return /测试/i.test(commentBodyText(latestStart));
}

/**
 * 优先级：DCO → 静态检查 → 编译 → AI 检视 → 测试（人工）
 * 静态检查失败且编译仍 pending 时，phase=static_failed，不能当成编译失败。
 */
export function classifyOhosPrGates(input = {}) {
  const labels = normalizeLabels(input.labels);
  const rawComments = normalizeComments(input.comments);
  const comments = [...rawComments].sort((a, b) => compareCommentTime(a, b));
  const state = String(input.state || '').toLowerCase();
  const merged = Boolean(input.merged) || state === 'merged';
  const closed = Boolean(input.closed) || merged || state === 'closed';
  const ownPr = input.own_pr !== false;
  const latest = latestCiComment(comments);
  const reportUrl = extractReportUrl(latest?.body || comments.map((item) => item.body).join('\n'));
  const welcome = comments.some(isWelcomeComment);
  // 重试预算只认 PR 作者本人的 start build；别人的触发不占预算（但门禁在跑的事实仍生效）
  const pullAuthor = String(
    input.pull?.user?.login
    || input.pull?.user?.username
    || input.pull?.author?.username
    || '',
  ).trim();
  const attempts = countStartBuildAttempts(comments, pullAuthor);
  // 已触发判定按当前代码版本隔离：push（代码有更新/重置验证状态）前的 start build 不算，
  // 否则会把「push 后门禁被中止、未重新触发」误判成 running，导致永远等不到结果。
  const startBuildPosted = attempts.start_build_posted;
  // 能从 DCP 报告拉到真实缺陷（文件/行/规则）时，失败不是抖动，重试无意义，直接进修复。
  const knownRealDefects = Number(input.dcp_defect_count || 0) > 0;
  const dcoFail = hasLabel(labels, LABEL_ALIASES.dco_fail)
    || (!hasLabel(labels, LABEL_ALIASES.dco_ok) && dcoFailIsCurrent(comments));
  const dcoOk = hasLabel(labels, LABEL_ALIASES.dco_ok) && !dcoFail;
  const staticFail = hasLabel(labels, LABEL_ALIASES.static_fail);
  const staticOk = hasLabel(labels, LABEL_ALIASES.static_ok) && !staticFail;
  const compileFail = hasLabel(labels, LABEL_ALIASES.compile_fail);
  const compileOk = hasLabel(labels, LABEL_ALIASES.compile_ok) && !compileFail;
  const testFail = hasLabel(labels, LABEL_ALIASES.test_fail);
  const testOk = hasLabel(labels, LABEL_ALIASES.test_ok) && !testFail;
  const flakyTestFail = testFail && isFlakyTestFailure(comments);
  // R3：先判定失败类别。只有明确 timeout/基础设施证据才允许按环境抖动重试。
  const failureCause = extractGateFailureCause(comments);
  // 日志核对（可选输入，由 fetch-gate-logs.mjs 产出）：把"疑似抖动"升级为有证据的结论，
  // 或明确降级为"未验证"，避免仅凭评论字符串就断言平台抖动。
  const logAnalysis = input.log_analysis && typeof input.log_analysis === 'object' ? input.log_analysis : null;
  const logVerdict = logAnalysis ? String(logAnalysis.verdict || 'unknown') : '';
  const logVerified = Boolean(logAnalysis?.root_cause_verified);
  // 日志已给出确定性证据（编译错误 / 真实断言失败）→ 不烧抖动重试预算，直接进修复。
  const logDeterministic = logVerdict === 'compile_error' || logVerdict === 'test_assertion';
  const aiPendingComments = Boolean(input.ai_actionable_count > 0);
  const issueOk = input.issue_associated !== false && hasAssociatedIssue(input.pull || {}, comments);

  const startBuildMax = Number(input.start_build_max || DEFAULT_START_BUILD_MAX);
  // 抖动独立预算（方案B）：真失败占 start_build_count（普通上限），
  // 平台抖动失败占 jitter_fail_count（独立上限）——两者分账，各自封顶。
  const jitterRetryMax = Number(input.jitter_retry_max || DEFAULT_JITTER_RETRY_MAX);
  const jitterFailCount = Number(attempts.jitter_fail_count || 0);
  const jitterRetryLeft = jitterFailCount > 0 && jitterFailCount < jitterRetryMax;

  const gateRetryLeft = !attempts.rate_limited
    && !knownRealDefects
    && !logDeterministic
    && attempts.gate_fail_after_last_start
    && attempts.start_build_count > 0
    && (
      (attempts.start_build_count < startBuildMax)
      || (flakyTestFail && jitterRetryLeft)   // 普通预算尽但本轮失败是抖动 → 用抖动预算续命
    );

  // 重试预算是否已“用完”（只数次数，与是否值得重试无关）：用完且不像代码问题 → 需人工 + 请门禁维护介入。
  const startBudgetUsedUp = attempts.start_build_count >= startBuildMax;
  const jitterBudgetUsedUp = jitterFailCount >= jitterRetryMax;
  const retryBudgetExhausted = attempts.gate_fail_after_last_start
    && attempts.start_build_count > 0
    && startBudgetUsedUp
    && (!flakyTestFail || jitterBudgetUsedUp);
  const logPlatformSide = logVerified && (logVerdict === 'infra_failure' || logVerdict === 'harness_env_failure');
  const needsMaintainer = retryBudgetExhausted && !logDeterministic;
  const budgetText = `已触发 start build ${attempts.start_build_count} 次 · 普通上限 ${startBuildMax} · 抖动失败 ${jitterFailCount}/${jitterRetryMax}`;
  // 只有"日志已核实属门禁/平台侧"时才敢说"不是 PR 代码问题"；其余（含未验证）一律只说"根因未核实，需协助排查"。
  const maintainerHint = needsMaintainer
    ? (logPlatformSide
      ? `重试预算已用尽（${budgetText}），日志核对确认根因在门禁/平台侧、非 PR 代码（${logVerdict}）——请携带门禁报告链接联系门禁维护人员排查`
      : `重试预算已用尽（${budgetText}），门禁根因未核实（日志未能定位根因，不能据此排除 PR 代码）——请携带门禁报告链接联系门禁维护人员协助排查`)
    : '';

  let phase = 'unknown';
  let summary = '';

  if (closed) {
    phase = 'unknown';
    summary = merged ? 'PR 已合入' : 'PR 已关闭';
  } else if (!ownPr) {
    phase = 'unknown';
    summary = '不是白名单作者的 PR';
  } else if (attempts.rate_limited) {
    // 当前限流优先于旧失败标签及自动修复；后续 CI 接受事件会在 attempts 中解除限流。
    phase = 'blocked_rate_limit';
    summary = `DCP 触发门禁次数已达到上限并拒绝了最近一次 start build（评论已发送=${attempts.comment_sent}、CI 已接受=${attempts.ci_accepted}），停止自动修复、重试与重复评论。需人工到 OpenHarmony 数字化协作平台申请恢复额度，恢复后重新检查门禁。`;
  } else if (dcoFail) {
    phase = 'dco_failed';
    summary = 'DCO 检查失败，只补 Signed-off-by，不改业务代码';
  } else if (!startBuildPosted && !welcome && !dcoOk && !staticFail && !compileFail && !testFail) {
    phase = 'running';
    summary = '还没有欢迎评论和 DCO 标签，挂起等 Webhook，不要抢先 start build';
  } else if (!startBuildPosted && comments.some(isNeedIssueComment) && !issueOk) {
    phase = 'blocked_no_issue';
    summary = 'CI 要求先关联 Issue，不能 start build';
  } else if ((staticFail || compileFail || testFail) && attempts.gate_running_after_last_start) {
    phase = 'running';
    summary = '静态/编译/测试失败标签是旧结果，CI 已开始重跑，继续等';
  } else if ((staticFail || compileFail) && gateRetryLeft && failureCause.kind === 'infra') {
    phase = 'need_start_build';
    summary = `${staticFail ? '静态检查' : '编译'}失败第 ${attempts.start_build_count} 次（上限 ${startBuildMax}），失败详情为 timeout/基础设施类（${failureCause.causes.join('、')}），确属 DCP 环境抖动，重发 start build 再试，不改代码`;
  } else if (staticFail) {
    phase = 'static_failed';
    summary = failureCause.kind === 'deterministic'
      ? `静态检查失败（确定性原因：${failureCause.causes.length ? failureCause.causes.join('、') : 'noPass/真实失败'}），不按环境抖动重试，先拉 DCP codeCheck 明细再改`
      : failureCause.kind === 'unknown'
        ? '静态检查失败但未取到失败详情，原因未知，不按"已确认抖动"重试；先拉 DCP codeCheck 明细再改'
        : '静态检查失败。即使编译还在 pending，也只进静态修复';
  } else if (compileFail) {
    phase = 'compile_failed';
    summary = failureCause.kind === 'deterministic'
      ? `编译失败（失败类别：${failureCause.causes.length ? failureCause.causes.join('、') : '确定性失败'}），对着 DCP 编译日志改，不按环境抖动重试`
      : failureCause.kind === 'unknown'
        ? '编译失败但未取到失败详情，原因未知，不按"已确认抖动"重试；对着 DCP 编译日志改'
        : '编译失败，对着 DCP 编译日志改';
  } else if (flakyTestFail && gateRetryLeft) {
    phase = 'need_start_build';
    summary = logVerdict === 'harness_env_failure'
      ? `测试失败第 ${attempts.start_build_count} 次（普通上限 ${startBuildMax}，抖动失败 ${jitterFailCount}/${jitterRetryMax}）：跑测报告已确认是测试环境准备失败（用例未执行到断言），属平台/环境侧、不是 PR 代码问题，重发 start build 再试，不改代码`
      : logAnalysis
        ? (logPlatformSide
          ? `测试失败第 ${attempts.start_build_count} 次（普通上限 ${startBuildMax}，抖动失败 ${jitterFailCount}/${jitterRetryMax}）：日志核对确认失败在平台/基础设施侧（${logVerdict}），不是 PR 代码问题，重发 start build 再试，不改代码`
          : `测试失败第 ${attempts.start_build_count} 次（普通上限 ${startBuildMax}，抖动失败 ${jitterFailCount}/${jitterRetryMax}）：日志核对未确认根因（${logVerdict}），按抖动预算重试但不得断言为平台抖动，重发 start build 再试，不改代码`)
        : `测试失败第 ${attempts.start_build_count} 次（普通上限 ${startBuildMax}，抖动失败 ${jitterFailCount}/${jitterRetryMax}），失败详情全部为 ecotest timeout——DCP 平台抖动而非代码问题（#1927/#1978 同款），重发 start build 再试，不改代码`;
  } else if (testFail) {
    phase = 'test_failed';
    summary = logVerdict === 'harness_env_failure'
      ? `测试失败：跑测报告已确认为测试环境准备失败（用例未执行到断言，如切换/同步 Flutter 代码时失败），属平台/环境侧，不是 PR 代码问题；抖动重试预算 ${jitterFailCount}/${jitterRetryMax}，用完则停下人工确认并反馈 DCP`
      : logDeterministic
        ? `测试失败：日志核对确认为确定性失败（${logVerdict}），不按环境抖动重试，人工确认后再改`
        : logAnalysis
          ? (logPlatformSide
            ? `测试失败：日志核对确认失败在平台/基础设施侧（${logVerdict}），不是 PR 代码问题；抖动重试预算 ${jitterFailCount}/${jitterRetryMax}，用完则停下人工确认并反馈 DCP`
            : `测试失败：日志核对未确认根因（${logVerdict}），不按"已确认抖动"重试；抖动重试预算 ${jitterFailCount}/${jitterRetryMax}，用完则停下人工确认`)
          : flakyTestFail
            ? `测试失败为平台抖动（ecotest timeout）且抖动重试预算也用完（普通 ${startBuildMax} + 抖动 ${jitterRetryMax}，当前抖动 ${jitterFailCount} 次），持续抖动疑似环境故障，停下人工确认并考虑反馈 DCP`
            : '冒烟/测试失败，默认人工确认，不要自动改代码';
  } else if (dcoOk && staticOk && compileOk && !testFail) {
    if (!testOk && ciMentionsTests(comments)) {
      phase = 'running';
      summary = '编译已过，冒烟测试还在跑——含测试的门禁须五项全绿（DCO/静态/编译/AI/冒烟）才算完成，继续等，不要提前收口';
    } else if (aiPendingComments) {
      phase = 'ai_review_pending';
      summary = '门禁标签已绿，还有未处理的 AI 检视意见';
    } else {
      phase = 'green';
      summary = 'DCO / 静态检查 / 编译已通过，不要自动 submit';
    }
  } else if (attempts.pending_start_build) {
    phase = 'running';
    summary = 'start build 已评论但 CI 尚未回「门禁构建开始」（可能在途/被 push 重置吞掉/重复触发被忽略），继续等，不要重复评论';
  } else if (!startBuildPosted && welcome && dcoOk) {
    phase = 'need_start_build';
    summary = '已有欢迎评论且 DCO 通过，评论 start build；不要等 AI已检视';
  } else if (!startBuildPosted && welcome && !dcoOk && !dcoFail) {
    phase = 'running';
    summary = '已有欢迎评论，DCO 标签还没出来，继续等';
  } else if (startBuildPosted && !staticOk && !compileOk && (ciMentionsRunning(comments) || !staticFail)) {
    phase = 'running';
    summary = '已 start build，门禁还在跑';
  } else if (startBuildPosted && staticOk && !compileOk && !compileFail) {
    phase = 'running';
    summary = '静态检查已过，编译还在跑';
  } else if (startBuildPosted && compileOk && !testOk && !testFail && ciMentionsRunning(comments)) {
    phase = 'running';
    summary = '编译已过，测试还在跑';
  } else if (aiPendingComments) {
    phase = 'ai_review_pending';
    summary = '有未处理的 AI 检视意见';
  } else if (startBuildPosted || ciMentionsRunning(comments)) {
    phase = 'running';
    summary = '门禁仍在进行';
  } else {
    phase = 'unknown';
    summary = '标签和评论还不够判断，禁止假装通过';
  }

  // 日志核对结论追加到 summary：让"抖动"不再是无依据的断言。
  if (logAnalysis && summary) {
    summary = `${summary}；日志核对：${describeGateLogVerdict(logAnalysis)}`;
  }
  // 重试用尽且非代码问题：明确"是什么原因 + 请门禁维护人员介入"。
  if (needsMaintainer && maintainerHint) {
    summary = `${summary}；${maintainerHint}`;
  }

  const waiting = phase === 'running';
  const verdict = closed || !ownPr
    ? 'fail'
    : waiting
      ? 'conditional_pass'
      : 'pass';

  return {
    verdict,
    phase,
    summary,
    labels,
    latest_ci_comment: latest?.body || '',
    report_url: reportUrl,
    welcome,
    start_build_posted: startBuildPosted,
    start_build_count: attempts.start_build_count,
    start_build_max: startBuildMax,
    jitter_fail_count: jitterFailCount,
    jitter_retry_max: jitterRetryMax,
    dcp_defect_count: Number(input.dcp_defect_count || 0),
    gate_rate_limited: attempts.rate_limited,
    rate_limit_blocked: phase === 'blocked_rate_limit',
    trigger_rejected: attempts.trigger_rejected,
    pending_start_build: attempts.pending_start_build,
    // R2：三个独立事实——评论是否发出、CI 是否接受、构建是否已通过。
    comment_sent: attempts.comment_sent,
    ci_accepted: attempts.ci_accepted,
    build_passed: dcoOk && staticOk && compileOk && !testFail && (!ciMentionsTests(comments) || testOk),
    // R3：失败类别（infra / deterministic / unknown / none），用于解释是否按环境抖动重试。
    failure_cause: failureCause.kind,
    failure_cause_detail: failureCause.causes,
    // R7：门禁日志核对（fetch-gate-logs.mjs）。root_cause_verified=false 时禁止断言"平台抖动"。
    log_verdict: logVerdict || null,
    root_cause_verified: logVerified,
    log_evidence: Array.isArray(logAnalysis?.evidence) ? logAnalysis.evidence.slice(0, 3) : [],
    log_reasons: Array.isArray(logAnalysis?.reasons) ? logAnalysis.reasons.slice(0, 3) : [],
    // R8：重试预算用尽且非代码问题 → 前端展示原因并提示联系门禁维护人员。
    retry_budget_exhausted: retryBudgetExhausted,
    needs_maintainer: needsMaintainer,
    // 仅当日志已核实属门禁/平台侧时才为 true；前端据此决定是否敢说"不是 PR 代码问题"。
    log_platform_verified: needsMaintainer && logPlatformSide,
    maintainer_hint: maintainerHint,
    dco_ok: dcoOk,
    dco_fail: dcoFail,
    static_ok: staticOk,
    static_fail: staticFail,
    compile_ok: compileOk,
    compile_fail: compileFail,
    test_ok: testOk,
    test_fail: testFail,
    test_flaky: flakyTestFail,
    issue_associated: issueOk,
    closed,
    merged,
    own_pr: ownPr,
  };
}

export function routeClassifyState(fromState, phase) {
  const table = CLASSIFY_ROUTES[fromState];
  if (!table) {
    throw new Error(`未知分流状态: ${fromState}`);
  }
  return table[phase] || table.default;
}
