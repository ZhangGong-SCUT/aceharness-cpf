/** OpenHarmony DCP 门禁分类：标签 + openharmony_ci 评论，不用 commit status。 */

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
  'unknown',
];

export const CLASSIFY_ROUTES = {
  分类处置: {
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

export function isWelcomeComment(item) {
  return /感谢提交\s*pull\s*requests?|感谢提交合并请求/i.test(item.body || '');
}

export function isDcoFailWelcome(item) {
  return /未通过dco校验|dco校验失败|dco检查失败/i.test(item.body || '');
}

export function isStartBuildComment(item) {
  return /^\s*start\s+build\s*$/i.test(item.body || '');
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
  if (comments.some(isNeedIssueComment)) return false;
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
 * 优先级：DCO → 静态检查 → 编译 → AI 检视 → 测试（人工）
 * 静态检查失败且编译仍 pending 时，phase=static_failed，不能当成编译失败。
 */
export function classifyOhosPrGates(input = {}) {
  const labels = normalizeLabels(input.labels);
  const comments = normalizeComments(input.comments);
  const state = String(input.state || '').toLowerCase();
  const merged = Boolean(input.merged) || state === 'merged';
  const closed = Boolean(input.closed) || merged || state === 'closed';
  const ownPr = input.own_pr !== false;
  const latest = latestCiComment(comments);
  const reportUrl = extractReportUrl(latest?.body || comments.map((item) => item.body).join('\n'));
  const welcome = comments.some(isWelcomeComment);
  const startBuildPosted = comments.some(isStartBuildComment);
  const dcoFail = hasLabel(labels, LABEL_ALIASES.dco_fail) || comments.some(isDcoFailWelcome);
  const dcoOk = hasLabel(labels, LABEL_ALIASES.dco_ok) && !dcoFail;
  const staticFail = hasLabel(labels, LABEL_ALIASES.static_fail);
  const staticOk = hasLabel(labels, LABEL_ALIASES.static_ok) && !staticFail;
  const compileFail = hasLabel(labels, LABEL_ALIASES.compile_fail);
  const compileOk = hasLabel(labels, LABEL_ALIASES.compile_ok) && !compileFail;
  const testFail = hasLabel(labels, LABEL_ALIASES.test_fail);
  const testOk = hasLabel(labels, LABEL_ALIASES.test_ok) && !testFail;
  const aiPendingComments = Boolean(input.ai_actionable_count > 0);
  const issueOk = input.issue_associated !== false && hasAssociatedIssue(input.pull || {}, comments);

  let phase = 'unknown';
  let summary = '';

  if (closed) {
    phase = 'unknown';
    summary = merged ? 'PR 已合入' : 'PR 已关闭';
  } else if (!ownPr) {
    phase = 'unknown';
    summary = '不是白名单作者的 PR';
  } else if (dcoFail) {
    phase = 'dco_failed';
    summary = 'DCO 检查失败，只补 Signed-off-by，不改业务代码';
  } else if (!startBuildPosted && !welcome && !dcoOk && !staticFail && !compileFail && !testFail) {
    phase = 'running';
    summary = '还没有欢迎评论和 DCO 标签，挂起等 Webhook，不要抢先 start build';
  } else if (!startBuildPosted && comments.some(isNeedIssueComment) && !issueOk) {
    phase = 'blocked_no_issue';
    summary = 'CI 要求先关联 Issue，不能 start build';
  } else if (!startBuildPosted && welcome && dcoOk) {
    phase = 'need_start_build';
    summary = '已有欢迎评论且 DCO 通过，评论 start build；不要等 AI已检视';
  } else if (!startBuildPosted && welcome && !dcoOk && !dcoFail) {
    phase = 'running';
    summary = '已有欢迎评论，DCO 标签还没出来，继续等';
  } else if (staticFail) {
    phase = 'static_failed';
    summary = '静态检查失败。即使编译还在 pending，也只进静态修复';
  } else if (compileFail) {
    phase = 'compile_failed';
    summary = '编译失败，对着 DCP 编译日志改';
  } else if (testFail) {
    phase = 'test_failed';
    summary = '冒烟/测试失败，默认人工确认，不要自动改代码';
  } else if (startBuildPosted && !staticOk && !compileOk && (ciMentionsRunning(comments) || !staticFail)) {
    phase = 'running';
    summary = '已 start build，门禁还在跑';
  } else if (startBuildPosted && staticOk && !compileOk && !compileFail) {
    phase = 'running';
    summary = '静态检查已过，编译还在跑';
  } else if (startBuildPosted && compileOk && !testOk && !testFail && ciMentionsRunning(comments)) {
    phase = 'running';
    summary = '编译已过，测试还在跑';
  } else if (dcoOk && staticOk && compileOk && !testFail) {
    if (aiPendingComments) {
      phase = 'ai_review_pending';
      summary = '门禁标签已绿，还有未处理的 AI 检视意见';
    } else {
      phase = 'green';
      summary = 'DCO / 静态检查 / 编译已通过，不要自动 submit';
    }
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
    dco_ok: dcoOk,
    dco_fail: dcoFail,
    static_ok: staticOk,
    static_fail: staticFail,
    compile_ok: compileOk,
    compile_fail: compileFail,
    test_ok: testOk,
    test_fail: testFail,
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
