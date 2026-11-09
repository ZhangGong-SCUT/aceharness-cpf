/* ── PR 监控模块（AceHarness 只读代理，按 AceHarness 账号隔离） ── */

/*
 * 模式：PR 监控工作流（gitcode-pr-review.yaml）由用户在 AceHarness 侧启动，
 * 本页面用 AceHarness 账号登录（js/auth.js 共享登录态）后实时读取自己启动的 run 状态。
 *
 * 界面结构：统计概览 → 状态筛选 → run 卡片列表（展开显示步骤时间线/评审/输出文件）
 */

const PR_REFRESH_INTERVAL_MS = 10000; // 列表自动刷新间隔

/* AceHarness run 状态 → 展示元数据
 * 注意：completed 指「AI 监控任务生命周期结束」（通常=门禁当时全绿），
 * 不代表 PR 可合入——评审人/测试人人工审批 + 评论 submit 仍需作者本人完成。 */
const PR_STATUS_META = {
  preparing:  { label: '准备中',   icon: '🔄', badge: 'b-running' },
  running:    { label: '监控中',   icon: '🔀', badge: 'b-running' },
  paused:     { label: '已暂停',   icon: '⏸️', badge: 'b-running' },
  pending:    { label: '等待中',   icon: '⏳', badge: 'b-running' },
  completed:  { label: '监控完成·待评审', icon: '✅', badge: 'b-completed' },
  failed:     { label: '失败',     icon: '❌', badge: 'b-failed' },
  crashed:    { label: '已崩溃',   icon: '💥', badge: 'b-failed' },
  stopped:    { label: '已停止',   icon: '⏹️', badge: 'b-stopped' },
  idle:       { label: '空闲',     icon: '💤', badge: 'b-stopped' },
};

/* 终态集合 */
const PR_TERMINAL = new Set(['completed', 'failed', 'crashed', 'stopped']);
/* 需人工确认的 phase */
const PR_HUMAN_PHASE = '__human_approval__';

let _prRefreshTimer = null;
let _prOvAutoRefreshTicks = 0;
let _prRunCache = {};        // runId -> run 数据
let _prFilter = 'all';       // 当前筛选：all / running / approval / completed / failed
let _prOpenSet = new Set();  // 已展开的 runId（刷新后保持展开态）
let _prOpenOutputs = new Set(); // 已打开输出区的 runId（刷新后自动恢复，避免被自动刷新打断）
let _prViewingFile = {};       // runId -> 正在查看的输出文件索引（刷新后恢复阅读位置）
let _prOpenReviewFix = new Set(); // 已打开「检视修复」区的 runId（刷新后自动恢复）
let _prApprovalKind = {};      // runId -> 'suspended' | 'human'（需人工确认的细分：挂起等 CI / 真需人处理）
let _prApprovalCheckedAt = {};
let _prApprovalRequests = {};

function _approvalKindFromStatus(status) {
  return status?.approvalKind === 'suspended' ? 'suspended' : 'human';
}

/* 判断"需人工确认"的细分类型：
   挂起状态进入的等待（等 CI 门禁，自动继续）→ 'suspended'；
   其余（测试失败/推送无权限等）→ 'human'。
   使用服务端 approvalKind（绑定当前待回答问题及建议产物）；文案和历史来源不能证明在等 CI。 */
async function _classifyApproval(runId) {
  if (_prApprovalKind[runId] && Date.now() - (_prApprovalCheckedAt[runId] || 0) < 10000) return _prApprovalKind[runId];
  if (_prApprovalRequests[runId]) return _prApprovalRequests[runId];
  const pending = (async () => { try {
    const r = await _prApi('GET', `/api/pr-review/runs/${encodeURIComponent(runId)}/status`, null, 15000);
    if (r.status !== 200 || !r.data?.success) throw new Error('审批状态暂不可用');
    const st = r.data?.status;
    const kind = _approvalKindFromStatus(st);
    _prApprovalKind[runId] = kind;
    _prApprovalCheckedAt[runId] = Date.now();
    return kind;
  } catch {
    _prApprovalKind[runId] = 'human';
    delete _prApprovalCheckedAt[runId];
    return 'human';   // 判断失败按需人处理显示（醒目优先，避免漏处理）
  } })().finally(() => delete _prApprovalRequests[runId]);
  _prApprovalRequests[runId] = pending;
  return pending;
}

/* 异步纠正卡片上的"需人工确认"徽章（挂起等 CI 的显示为等待 CI） */
function _refineApprovalBadge(runId) {
  _classifyApproval(runId).then(kind => {
    const run = _prRunCache[runId];
    if (!run || run.currentPhase !== PR_HUMAN_PHASE || PR_TERMINAL.has(run.status)) return;
    const card = document.getElementById(`pr-card-${runId}`);
    _renderPrStats(Object.values(_prRunCache));
    _renderApprovalBanner(Object.values(_prRunCache));
    if (!!card !== _prMatchFilter(run)) {
      _renderPrRunList(Object.values(_prRunCache));
      return;
    }
    if (!card) return;
    const badge = card.querySelector('.pr-badge.b-approval, .pr-badge.b-waiting');
    if (!badge) return;
    if (kind === 'suspended') {
      badge.className = 'pr-badge b-waiting';
      badge.textContent = '⏳ 等待 CI 门禁';
      const dot = card.querySelector('.pr-dot');
      if (dot) dot.className = 'pr-dot d-running';
      card.classList.remove('need-approval');
    } else {
      badge.className = 'pr-badge b-approval';
      badge.textContent = '⚠️ 需人工确认';
      const dot = card.querySelector('.pr-dot');
      if (dot) dot.className = 'pr-dot d-approval';
      card.classList.add('need-approval');
    }
  });
}
let _prLoadingDetail = {};   // runId -> 详情加载中
let _prLastRefreshAt = 0;    // 上次刷新时间戳
let _prRunsReqSeq = 0;       // run 列表请求序号（并发防抖：旧响应丢弃）

/* ── token 失效/退出登录时：重置面板为登录引导 ── */
onAuthExpired = function () {
  _stopPrAutoRefresh();
  _prRunCache = {};
  _prOpenSet = new Set();
  _prOpenOutputs = new Set();
  _prViewingFile = {};
  _prLoadingDetail = {};
  _prApprovalKind = {};
  _prApprovalCheckedAt = {};
  _prApprovalRequests = {};
  _prFilter = 'all';
  _syncPrAuthViews(false);
};

/* ── 视图切换 ── */
function _syncPrAuthViews(loggedIn) {
  $('pr-login-box').style.display = loggedIn ? 'none' : '';
  $('pr-user-bar').style.display = loggedIn ? 'flex' : 'none';
  $('pr-stats-bar').style.display = loggedIn ? '' : 'none';
  $('pr-overview-bar').style.display = loggedIn ? '' : 'none';
  $('pr-filters').style.display = loggedIn ? 'flex' : 'none';
  $('pr-runs-section').style.display = loggedIn ? '' : 'none';
  if (loggedIn) {
    const u = getAuth()?.user || {};
    $('pr-user-name').textContent = u.username || '未知用户';
    $('pr-user-role').textContent = getAuth()?.local ? '本机' : (u.role === 'admin' ? '管理员' : '普通用户');
    const switchAccount = $('pr-switch-account');
    if (switchAccount) switchAccount.style.display = getAuth()?.local ? 'none' : '';
    const avatar = $('pr-user-avatar');
    if (avatar) avatar.textContent = (u.username || '?').slice(0, 1).toUpperCase();
    $('pr-error').style.display = 'none';
  }
}

/* ── 使用说明折叠面板 ── */
function togglePrHelp() {
  const panel = $('pr-help-panel');
  const btn = $('pr-help-btn');
  if (!panel) return;
  const show = panel.style.display === 'none';
  panel.style.display = show ? '' : 'none';
  if (btn) btn.classList.toggle('active', show);
}

/* ── 初始化：检查共享登录态 ── */
async function initPrReviewHistory() {
  if (getAuth()?.token) {
    _syncPrAuthViews(true);
    initPrOverview();
    await _loadPrRuns(true);
    _startPrAutoRefresh();
  }
}

/* ── 面板可见性：切走时停轮询省资源，切回时恢复并立即刷新 ── */
window.addEventListener('panelswitch', (e) => {
  if (e.detail?.panelId === 'p-prreview') {
    if (getAuth()?.token && !_prRefreshTimer) {
      _startPrAutoRefresh();
      manualRefreshPr();   // 切回立即刷新，不等 10s 轮询
    }
  } else if (_prRefreshTimer) {
    _stopPrAutoRefresh();
  }
});
document.addEventListener('visibilitychange', () => {
  // 浏览器标签页切到后台：暂停轮询；切回：立即恢复
  if (document.hidden) {
    if (_prRefreshTimer) { _stopPrAutoRefresh(); _prPausedByHidden = true; }
  } else if (_prPausedByHidden) {
    _prPausedByHidden = false;
    if (getAuth()?.token) {
      _startPrAutoRefresh();
      manualRefreshPr();
    }
  }
});
let _prPausedByHidden = false;

/* ═══════════ GitCode PR 总览 + 监控人工开关 ═══════════ */

let _prOvAuthor = '';      // 仅 scope=self 时代表当前绑定的 GitCode 身份
let _prOvIdentitySource = '';
let _prOvIdentities = [];
let _prOvIsAdmin = false;
let _prOvCache = [];       // PR 列表缓存
let _prOvLoading = false;
let _prOvReloadPending = false;
let _prOvPendingFresh = false;
let _prOvFresh = false;    // 手动刷新时绕过服务端缓存
let _prOvScope = '';       // ''=组织所有 PR；'self'=当前用户自己的 PR
let _prOvStateFilter = 'all';
let _prOvRepoFilter = 'all';
let _prOvRepos = [];
let _prOvPage = 1;
let _prOvPerPage = 20;
let _prOvHasMore = false;
let _prOvSearchMode = 'organization';
let _prOvRenderFlags = { degraded: false, stale: false };

/* 状态筛选使用 GitCode 服务端条件，保持分页结果正确。 */
function setPrOvStateFilter(state) {
  if (_prOvStateFilter === state) return;
  _prOvStateFilter = state;
  _prOvPage = 1;
  document.querySelectorAll('#pr-ov-filters .pr-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.ovstate === state);
  });
  loadGitcodePrs();
}

/* 仓库筛选切换到该仓库的分页 API。 */
function setPrOvRepoFilter(repo) {
  if (_prOvRepoFilter === repo) return;
  _prOvRepoFilter = repo;
  _prOvPage = 1;
  const select = $('pr-ov-repo-select');
  if (select) select.value = repo;
  loadGitcodePrs();
}

/* 组织 API 搜索标题/描述；选定仓库时在当前页内搜索。 */
let _prOvSearch = '';
let _prOvSearchTimer = null;

function setPrOvSearch(q) {
  const v = String(q || '').trim();
  if (v === _prOvSearch) return;
  _prOvSearch = v;
  _prOvPage = 1;
  clearTimeout(_prOvSearchTimer);
  _prOvSearchTimer = setTimeout(() => loadGitcodePrs(), 300);
}

function _personalPrScope() {
  return getAuth()?.user?.prScope === 'self';
}

/* admin 视图切换：全部用户 ↔ 只看自己。个人部署固定只看自己。 */
function toggleAdminScope() {
  if (_personalPrScope() || !_prOvIsAdmin) return;
  _prOvScope = _prOvScope === 'self' ? '' : 'self';
  _prOvPage = 1;
  loadGitcodePrs(true, _prOvScope);
}

/* 同步切换按钮显隐与文案 */
function _syncAdminScopeBtn() {
  const btn = document.getElementById('pr-admin-scope-btn');
  if (!btn) return;
  const show = _prOvIsAdmin && !_personalPrScope();
  btn.style.display = show ? '' : 'none';
  btn.textContent = _prOvScope === 'self' ? '👤 只看自己' : '🌐 组织全部 PR';
  btn.title = _prOvScope === 'self' ? '切换回 CPF-Flutter 组织全部 PR' : '切换为只看自己绑定身份的 PR';
}

function initPrOverview() {
  refreshGitcodeTokenStatus(false);
  refreshEmailNotifyStatus();
  loadGitcodePrs();
}

/* ── GitCode 令牌管理 ── */

let _prTokenConfigured = false;
let _prTokenUsername = '';
let _prEmailEnabled = false;
let _prEmailConfigured = false;

/* ── 邮件通知开关 ── */
function _renderEmailBtn() {
  const dot = $('pr-email-dot');
  if (!dot) return;
  if (_prEmailEnabled) {
    dot.className = 'pr-dot d-completed';
    $('pr-email-btn').title = '邮件通知已开启（点击关闭）';
  } else {
    dot.className = 'pr-dot d-stopped';
    $('pr-email-btn').title = _prEmailConfigured
      ? '邮件通知已关闭（点击开启）'
      : 'SMTP 尚未配置，开启后也不会发信（点击开启）';
  }
}

async function refreshEmailNotifyStatus() {
  if (!getAuth()) return;
  try {
    const r = await _prApi('GET', '/api/pr-review/email-notify', null, 15000);
    if (r.status === 200 && r.data?.success) {
      _prEmailEnabled = !!r.data.enabled;
      _prEmailConfigured = !!r.data.configured;
    }
  } catch { /* 状态拉不到时保持按钮灰色，不阻塞页面 */ }
  _renderEmailBtn();
}

async function toggleEmailNotify() {
  if (!getAuth()) return;
  const btn = $('pr-email-btn');
  const target = !_prEmailEnabled;
  if (target && _prEmailConfigured === false && !confirm('SMTP 邮箱配置尚未完成，开启后不会实际发信。\n仍要开启吗？')) return;
  if (btn) btn.style.opacity = '.5';
  try {
    const r = await _prApi('POST', '/api/pr-review/email-notify', { enabled: target }, 15000);
    if (r.status === 200 && r.data?.success) {
      _prEmailEnabled = !!r.data.enabled;
      _prEmailConfigured = !!r.data.configured;
      _renderEmailBtn();
    } else {
      alert('切换失败：' + (r.data?.message || 'HTTP ' + r.status));
    }
  } catch (e) {
    alert('切换失败：' + e.message);
  } finally {
    if (btn) btn.style.opacity = '';
  }
}

function toggleTokenPanel() {
  const panel = $('pr-token-panel');
  const show = panel.style.display === 'none';
  panel.style.display = show ? '' : 'none';
  if (show) refreshGitcodeTokenStatus(true);
}

async function refreshGitcodeTokenStatus(showError) {
  if (!getAuth()) return;
  try {
    const r = await _prApi('GET', '/api/pr-review/gitcode-token', null, 15000);
    if (r.status !== 200 || !r.data?.success) throw new Error(r.data?.message || 'HTTP ' + r.status);
    _prTokenConfigured = !!r.data.configured;
    const t = (r.data.tokens || [])[0];
    _prTokenUsername = t?.gitcodeUsername || '';
    const statusEl = $('pr-token-status');
    const dot = $('pr-token-dot');
    if (_prTokenConfigured) {
      statusEl.innerHTML = `✅ 已配置：<b>${escHtml(_prTokenUsername)}</b>（${escHtml(t.masked)}）— 监控将以此身份访问 GitCode`;
      statusEl.className = 'pr-token-row ok';
      dot.className = 'pr-dot d-completed';
      $('pr-token-clear').style.display = '';
    } else {
      statusEl.textContent = '⚠️ 尚未配置 GitCode 令牌 — 开启监控前建议先配置，否则工作流可能无法访问你的 PR';
      statusEl.className = 'pr-token-row warn';
      dot.className = 'pr-dot d-failed';
      $('pr-token-clear').style.display = 'none';
    }
  } catch (e) {
    if (showError) {
      const statusEl = $('pr-token-status');
      statusEl.textContent = '查询令牌状态失败：' + e.message;
      statusEl.className = 'pr-token-row warn';
    }
  }
}

async function saveGitcodeToken() {
  if (!getAuth()) return;
  const input = $('pr-token-input');
  const value = (input?.value || '').trim();
  if (!value) { alert('请先粘贴 GitCode 个人访问令牌'); return; }
  const btn = document.querySelector('a.pr-ov-btn[onclick*="saveGitcodeToken"]');
  const clearBtn = $('pr-token-clear');
  if (btn) { btn.classList.add('busy'); btn.textContent = '⏳ 校验中…'; }
  try {
    const r = await _prApi('POST', '/api/pr-review/gitcode-token', { token: value }, 30000);
    if (r.status === 200 && r.data?.success) {
      input.value = '';
      await refreshGitcodeTokenStatus(false);
      // 保存令牌后刷新组织 PR 列表与本人监控权限。
      await loadGitcodePrs();
    } else {
      alert('保存失败：' + (r.data?.message || 'HTTP ' + r.status));
    }
  } catch (e) {
    alert('保存失败：' + e.message);
  } finally {
    if (btn) { btn.classList.remove('busy'); btn.textContent = '✓ 校验并保存'; }
    clearBtn.style.display = _prTokenConfigured ? '' : 'none';
  }
}

async function clearGitcodeToken() {
  if (!getAuth()) return;
  if (!confirm('确认清除已保存的 GitCode 令牌？清除后 PR 总览将回落到邮箱绑定的身份（如有）。')) return;
  try {
    const r = await _prApi('DELETE', '/api/pr-review/gitcode-token', null, 15000);
    if (r.status === 200 && r.data?.success) {
      await refreshGitcodeTokenStatus(false);
      await loadGitcodePrs();   // 身份回落邮箱映射，PR 列表随之刷新
    } else {
      alert('清除失败：' + (r.data?.message || 'HTTP ' + r.status));
    }
  } catch (e) {
    alert('清除失败：' + e.message);
  }
}

async function loadGitcodePrs(fresh = false, scope) {
  if (!getAuth()) return;
  if (_personalPrScope()) _prOvScope = 'self';
  else if (scope !== undefined) _prOvScope = scope;
  if (_prOvLoading) {
    _prOvReloadPending = true;
    _prOvPendingFresh = _prOvPendingFresh || fresh;
    return;
  }
  _prOvLoading = true;
  _prOvFresh = fresh;

  const list = $('pr-ov-list');
  // 首次加载显示提示；轮询/刷新时静默（避免闪烁），失败时才更新提示
  if (!list.children.length || !list.querySelector('.pr-ov-row')) {
    list.innerHTML = `<div class="pr-ov-loading">正在加载 ${_personalPrScope() ? '本人的' : 'CPF-Flutter 组织'} PR…</div>`;
  }
  try {
    // 组织总览默认跨作者；管理员可切换到自己的绑定身份。服务端按页读取，30 秒轮询复用短缓存。
    // 网络层错误（Failed to fetch，多为公网隧道波动）自动重试一次
    let r = null, lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const query = new URLSearchParams({ page: String(_prOvPage), perPage: String(_prOvPerPage), state: _prOvStateFilter });
        if (_prOvFresh) query.set('fresh', '1');
        if (_prOvScope === 'self') query.set('scope', 'self');
        if (_prOvRepoFilter !== 'all') query.set('repo', _prOvRepoFilter);
        if (_prOvSearch) query.set('search', _prOvSearch);
        r = await _prApi('GET', '/api/pr-review/gitcode-prs?' + query.toString(), null, 90000);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt === 0 && /fetch|abort|network/i.test(e.name + e.message)) {
          list.innerHTML = '<div class="pr-ov-loading">网络波动，重试中…</div>';
          await new Promise(res => setTimeout(res, 1500));
          continue;
        }
        break;
      }
    }
    if (lastErr) throw lastErr;
    if (r.status === 422) {
      _prOvAuthor = '';
      _prOvIdentitySource = 'self';
      $('pr-ov-pagination').style.display = 'none';
      list.innerHTML = _personalPrScope()
        ? `<div class="pr-ov-loading" style="color:#d8b06a">个人部署只能查看本人 PR。当前账号尚未绑定 GitCode 身份，请先配置 GitCode 令牌。</div>`
        : `
        <div class="pr-ov-loading" style="color:#d8b06a">
          🔗 当前账号尚未绑定 GitCode 身份，无法筛选本人 PR。CPF-Flutter 组织总览仍可查看；启动本人 PR 监控前，请先配置 GitCode 令牌或联系管理员配置邮箱映射。
        </div>`;
      _updateOvIdentity();
      return;
    }
    if (r.status !== 200 || !r.data?.success) {
      $('pr-ov-pagination').style.display = 'none';
      list.innerHTML = `<div class="pr-ov-loading" style="color:var(--err)">加载失败：${escHtml(r.data?.message || 'HTTP ' + r.status)}</div>`;
      return;
    }
    _prOvCache = r.data.prs || [];
    _prOvRepos = r.data.repos || [];
    _prOvAuthor = r.data.author || '';
    _prOvIdentitySource = r.data.identitySource || '';
    _prOvIdentities = r.data.identities || [];
    _prOvIsAdmin = getAuth()?.user?.role === 'admin';
    _prOvPage = Number(r.data.page) || _prOvPage;
    _prOvPerPage = Number(r.data.perPage) || _prOvPerPage;
    _prOvHasMore = Boolean(r.data.hasMore);
    _prOvSearchMode = r.data.searchMode || 'organization';
    _syncAdminScopeBtn();
    // 仓库目录可能因权限或 API 暂时不可用而不完整，至少使用当前页的真实仓库补全筛选项。
    const repoEl = $('pr-ov-repo');
    const repoList = [...new Set([..._prOvRepos, ..._prOvCache.map(p => p.repoFull)].filter(Boolean))];
    repoEl.textContent = `CPF-Flutter · ${repoList.length} 个代码仓`;
    _updateOvIdentity();
    _renderPrOverview(!!r.data.degraded, false);
    _updatePrOvPagination();
  } catch (e) {
    $('pr-ov-pagination').style.display = 'none';
    list.innerHTML = `<div class="pr-ov-loading" style="color:var(--err)">加载失败：${escHtml(e.message)}</div>`;
  } finally {
    _prOvLoading = false;
    if (_prOvReloadPending) {
      const pendingFresh = _prOvPendingFresh;
      _prOvReloadPending = false;
      _prOvPendingFresh = false;
      void loadGitcodePrs(pendingFresh);
    }
  }
}

function setPrOvPage(page) {
  const next = Math.max(1, Number.parseInt(page, 10) || 1);
  if (next === _prOvPage || (next > _prOvPage && !_prOvHasMore)) return;
  _prOvPage = next;
  loadGitcodePrs();
}

function _updatePrOvPagination() {
  const el = $('pr-ov-pagination');
  if (!el) return;
  el.style.display = '';
  el.innerHTML = `
    <button class="pr-ov-btn start" type="button" onclick="setPrOvPage(${Math.max(1, _prOvPage - 1)})"${_prOvPage <= 1 ? ' disabled' : ''}>‹ 上一页</button>
    <span>第 ${_prOvPage} 页 · 每页 ${_prOvPerPage} 条 · ${_prOvCache.length} 条</span>
    <button class="pr-ov-btn start" type="button" onclick="setPrOvPage(${_prOvPage + 1})"${_prOvHasMore ? '' : ' disabled'}>下一页 ›</button>`;
}

function _showPrOvMsg(msg) {
  $('pr-ov-list').innerHTML = `<div class="pr-ov-loading">${escHtml(msg)}</div>`;
}

/* 身份徽章：显示当前绑定的 GitCode 身份及来源 */
function _updateOvIdentity() {
  const el = $('pr-ov-identity');
  if (!el) return;
  if (_prOvIdentitySource === 'organization') {
    el.textContent = '🌐 全部作者 · CPF-Flutter 组织';
    el.className = 'pr-ov-identity admin';
    el.title = '展示 CPF-Flutter 组织的 PR，跨仓库、跨作者分页读取';
    return;
  }
  if (!_prOvAuthor) {
    el.textContent = '本人身份未绑定';
    el.className = 'pr-ov-identity none';
    el.title = '组织 PR 列表可查看；启动本人 PR 监控需要绑定 GitCode 身份';
    return;
  }
  el.textContent = `👤 ${_prOvAuthor} · 本人 PR`;
  el.className = 'pr-ov-identity';
  el.title = `当前筛选：GitCode 用户「${_prOvAuthor}」的 PR`;
}

const PR_OV_STATE_META = {
  open:   { label: '开放中', cls: 'ov-open' },
  merged: { label: '已合入', cls: 'ov-merged' },
  closed: { label: '已关闭', cls: 'ov-closed' },
};

/* ── DCP 门禁标签（与工作流 ohos-pr-gates LABEL_ALIASES 同一套语义） ── */
const PR_GATE_LABEL_META = [
  { key: 'ai',    label: 'AI',   ok: ['AI已检视'],                       warn: ['AI检视中'] },
  { key: 'dco',   label: 'DCO',  ok: ['dco检查成功', 'dco校验成功'],      fail: ['dco检查失败', 'dco校验失败'] },
  { key: 'static',label: '静态', ok: ['静态检查成功'],                    fail: ['静态检查失败'] },
  { key: 'build', label: '编译', ok: ['编译成功'],                        fail: ['编译失败'] },
  { key: 'test',  label: '冒烟', ok: ['冒烟测试成功', '测试成功'],        fail: ['冒烟测试失败', '测试失败'] },
];

/**
 * 渲染 DCP 门禁标签组：五个检查项（AI/DCO/静态/编译/冒烟）每项一个小标签。
 * 绿=通过 红=失败 灰=未验证（进行中视为未验证，黄点仅 title 提示）。
 * 样式规格与 .pr-ov-state 一致。labels 缺失（旧缓存）返回空。
 */
function _gateBadges(labels) {
  const list = Array.isArray(labels) ? labels : [];
  if (!list.length) return '';
  const has = (names) => list.some(l => names.includes(l));
  const states = PR_GATE_LABEL_META.map(g => ({
    label: g.label,
    state: has(g.fail || []) ? 'fail' : has(g.ok) ? 'ok' : (g.warn && has(g.warn)) ? 'warn' : 'none',
  }));
  if (states.every(s => s.state === 'none')) return '';
  return `<span class="pr-gate-group" title="${escHtml(list.join('、'))}">`
    + states.map(s => {
      const cls = s.state === 'ok' ? 'ok' : s.state === 'fail' ? 'fail' : 'pending';
      const mark = s.state === 'ok' ? '✓' : s.state === 'fail' ? '✗' : s.state === 'warn' ? '…' : '';
      return `<span class="pr-gate-tag ${cls}">${mark}${escHtml(s.label)}</span>`;
    }).join('')
    + '</span>';
}

/* 单条 PR 行模板（showRepoBadge：分组渲染时由组标题承载仓库信息，行内徽章省略） */
/* 同主题跨分支标识：只要同一问题存在 ≥2 个分支就展示，部分检视时升级为警告。
   numbers/repos 由后端 groupSiblingPrs 计算（同作者下分支 slug 相同或标题去版本前缀后相同）。 */
function _siblingBadgeHtml(p) {
  const g = p.siblingGroup;
  if (!g || !(g.total > 1)) return '';
  const nums = (g.numbers || []).map(n => '#' + n).join('、');
  const repos = Array.isArray(g.repos) && g.repos.length > 1 ? `跨 ${g.repos.length} 个仓库` : '同仓';
  const base = `同主题跨分支共 ${g.total} 个：${nums}（${repos}；${g.reviewedCount} 已检视 / ${g.unreviewedCount} 未检视）`;
  if (g.inconsistent) {
    return `<span class="pr-ov-sibling-warn" title="${escHtml(base)}。本分支${p.labels?.includes('AI已检视') ? '已检视' : '未检视'}（未检视分支不会自动修复）">⚠️ 同分支 ${g.total}</span>`;
  }
  return `<span class="pr-ov-sibling" title="${escHtml(base)}">⇄ 同主题 ${g.total}</span>`;
}

function _prOvRowHtml(p, showRepoBadge = true) {
  const st = PR_OV_STATE_META[p.state] || { label: p.state || '-', cls: 'ov-closed' };
  const isActive = p.monitorStatus === 'running';
  const activeRun = (p.monitorRuns || []).find(r => !['completed', 'failed', 'crashed', 'stopped'].includes(r.status));
  // 外链协议白名单：仅允许 http(s)，防止 javascript: 等危险协议注入
  const safeUrl = /^https?:\/\//i.test(String(p.htmlUrl || '')) ? p.htmlUrl : '#';
  // 防呆：已合入/已关闭的 PR 不提供开启监控（置灰不可点）。
  // 注意：若 PR 在监控期间被合入/关闭，停止按钮保留（用户需要能停掉运行中的任务）。
  const lifecycleBlocked = !isActive && (p.state === 'merged' || p.state === 'closed');
  const safeNumber = /^\d+$/.test(String(p.number)) ? String(p.number) : '';
  const repoKey = `${p.repoFull || p.repo || ''}#${safeNumber}`;
  const blockBtn = p.state === 'merged'
    ? `<span class="pr-ov-btn disabled" title="PR 已合入，无需开启监控">✓ 已合入</span>`
    : `<span class="pr-ov-btn disabled" title="PR 已关闭（未合入）；若在 GitCode 重新打开后可再开启监控">✕ 已关闭</span>`;
  const btn = isActive
    ? `<a class="pr-ov-btn stop" href="#" onclick="event.preventDefault();stopPrMonitorById('${escHtml(activeRun.runId)}', ${safeNumber})" title="停止监控任务 ${escHtml(activeRun.runId)}">⏹ 关闭监控</a>`
    : (lifecycleBlocked ? blockBtn
      : (p.canMonitor
        ? `<a class="pr-ov-btn start" href="#" onclick="event.preventDefault();startPrMonitorByNumber(${safeNumber}, '${escHtml(p.repoFull || p.repo || '')}')">▶ ${p.monitorRuns?.length ? '重新开启监控' : '开启监控'}</a>`
        : `<span class="pr-ov-btn disabled" title="监控启动权限：PR 作者本人或管理员">🔒 仅作者/管理员可启动</span>`));
  const monBadge = isActive
    ? '<span class="pr-ov-mon running">🔀 监控中</span>'
    : (p.monitorRuns?.length ? `<span class="pr-ov-mon done" title="历史监控 ${p.monitorRuns.length} 次">✅ 已监控×${p.monitorRuns.length}</span>` : '<span class="pr-ov-mon off">未监控</span>');
  return `
    <div class="pr-ov-row${isActive ? ' monitoring' : ''}" data-pr-key="${escHtml(repoKey)}">
      <span class="pr-dot ${isActive ? 'd-running' : (p.state === 'merged' ? 'd-completed' : p.state === 'closed' ? 'd-stopped' : '')}"></span>
      <a class="pr-ov-num" href="${escHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" title="在 GitCode 打开">#${escHtml(String(p.number))}</a>
      ${p.repo ? `<span class="pr-ov-repo-badge" title="${escHtml(p.repoFull || p.repo)}">${escHtml(p.repo.replace(/^flutter_/, ''))}</span>` : ''}
      <span class="pr-ov-title" title="${escHtml(p.title)}">${escHtml(p.title || '(无标题)')}</span>
      <span class="pr-ov-state ${st.cls}">${escHtml(st.label)}</span>
      ${_gateBadges(p.labels)}
      <span class="pr-ov-branch" title="分支">${escHtml(p.headRef || '-')} → ${escHtml(p.baseRef || '-')}</span>
      <span class="pr-ov-owner" title="PR 作者">${escHtml(p.author || '未知作者')}</span>
      <span class="pr-ov-time" title="最后更新">${escHtml(_fmtPrTime(p.updatedAt))}</span>
      ${monBadge}
      ${btn}
    </div>`;
}

/* 仓库下拉筛选：仓库数量较多时避免生成数百个 chips。 */
function _renderRepoFilterSelect() {
  const el = $('pr-ov-repo-filters');
  if (!el) return false;
  const order = _prOvRepos.filter(Boolean);
  const seen = new Set();
  const repos = [];
  for (const full of order) {
    if (!seen.has(full)) { seen.add(full); repos.push(full); }
  }
  for (const p of _prOvCache) {
    if (p.repoFull && !seen.has(p.repoFull)) { seen.add(p.repoFull); repos.push(p.repoFull); }
  }
  if (repos.length < 2) { el.style.display = 'none'; el.innerHTML = ''; return false; }
  const shortName = (full) => (String(full).split('/')[1] || String(full)).replace(/^flutter_/, '');
  if (_prOvRepoFilter !== 'all' && !repos.includes(_prOvRepoFilter)) _prOvRepoFilter = 'all';

  el.style.display = '';
  el.innerHTML = `<label style="display:flex;align-items:center;gap:7px;color:var(--dim);font-size:var(--font-size-xs)">
    仓库筛选 <select id="pr-ov-repo-select" class="pr-ov-input" style="max-width:min(360px,70vw);height:30px;padding:3px 8px" onchange="setPrOvRepoFilter(this.value)">
      <option value="all"${_prOvRepoFilter === 'all' ? ' selected' : ''}>全部组织仓库</option>
      ${repos.map(full => `<option value="${escHtml(full)}"${_prOvRepoFilter === full ? ' selected' : ''}>${escHtml(shortName(full))}</option>`).join('')}
    </select>
  </label>`;
  return true;
}

function _renderPrOverview(degraded = _prOvRenderFlags.degraded, stale = _prOvRenderFlags.stale) {
  const list = $('pr-ov-list');
  const filtersEl = $('pr-ov-filters');
  _prOvRenderFlags = { degraded, stale };
  _renderRepoFilterSelect();
  if (filtersEl) {
    filtersEl.style.display = '';
    filtersEl.querySelectorAll('.pr-chip').forEach(c => c.classList.toggle('active', c.dataset.ovstate === _prOvStateFilter));
  }
  let searched = _prOvCache;
  if (_prOvSearchMode === 'current-page' && _prOvSearch) {
    const needle = _prOvSearch.toLowerCase();
    searched = searched.filter(p => String(p.number).includes(needle)
      || String(p.title || '').toLowerCase().includes(needle)
      || String(p.description || '').toLowerCase().includes(needle));
  }
  if (!searched.length) {
    const scope = _prOvRepoFilter === 'all' ? 'CPF-Flutter 组织 PR' : `${_prOvRepoFilter} PR`;
    const searchText = _prOvSearch ? `，搜索「${escHtml(_prOvSearch)}」` : '';
    list.innerHTML = `<div class="pr-ov-loading">第 ${_prOvPage} 页没有${searchText}（${scope}）。可翻页或调整筛选条件。</div>`;
    _updatePrOvPagination();
    return;
  }

  // 服务端已经按状态/仓库过滤；这里只对当前仓库页执行本地搜索。
  const tips = [];
  if (degraded) tips.push('<div class="pr-ov-loading" style="color:#d8b06a;padding:10px">⚠️ 监控引擎暂不可达，仅展示 PR 列表（监控状态不可用）</div>');
  if (stale) tips.push('<div class="pr-ov-loading" style="color:#d8b06a;padding:6px 10px">⏳ GitCode 响应缓慢，正在展示稍早的数据（下次刷新自动更新）</div>');
  const degradedTip = tips.join('');

  const groupRepos = [...new Set(searched.map(p => p.repoFull || '').filter(Boolean))];
  let body;
  if (groupRepos.length > 1) {
    const order = _prOvRepos.filter(Boolean);
    const ordered = [...groupRepos].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    body = ordered.map(full => {
      const rows = searched.filter(p => (p.repoFull || '') === full);
      const short = (String(full).split('/')[1] || full).replace(/^flutter_/, '');
      return `
        <div class="pr-ov-group-head">
          <span class="pr-ov-group-dot"></span>
          <span class="pr-ov-group-name" title="${escHtml(full)}">${escHtml(short)}</span>
          <span class="pr-ov-group-count">当前页 ${rows.length} 个 PR</span>
          <span class="pr-ov-group-line"></span>
        </div>
        ${rows.map(p => _prOvRowHtml(p, false)).join('')}`;
    }).join('');
  } else {
    body = searched.map(p => _prOvRowHtml(p)).join('');
  }
  list.innerHTML = degradedTip + body;
  _updatePrOvPagination();
}

async function startPrMonitorByNumber(prNumber, repo = '') {
  if (!getAuth()) return;
  const normalizedRepo = String(repo || '').toLowerCase();
  // 防呆兜底：已合入/已关闭的 PR 拒绝发起（按钮已置灰，此处防列表数据过期/直接调用）
  const pr = _prOvCache.find(x => String(x.number) === String(prNumber)
    && (!normalizedRepo || String(x.repoFull || x.repo || '').toLowerCase() === normalizedRepo
      || String(x.repoFull || '').toLowerCase().endsWith('/' + normalizedRepo)));
  if (pr && !pr.canMonitor) {
    alert('只能启动本人 PR 的监控；如需启动其他作者的 PR，请由管理员操作');
    return;
  }
  if (pr && (pr.state === 'merged' || pr.state === 'closed')) {
    alert(pr.state === 'merged'
      ? `PR #${prNumber} 已合入，无需开启监控`
      : `PR #${prNumber} 已关闭（未合入）。若已在 GitCode 重新打开，请刷新列表后再试`);
    return;
  }
  if (!_prTokenConfigured
      && !confirm('⚠️ 尚未配置 GitCode 令牌，监控工作流可能无法以你的身份访问 PR（读 diff / 门禁 / 回评论）。\n\n仍要现在开启监控吗？（建议先点右上角「🔑 令牌」完成配置）')) {
    return;
  }
  const row = pr ? [...document.querySelectorAll('.pr-ov-row')]
    .find(el => el.dataset.prKey === `${pr.repoFull || pr.repo}#${pr.number}`) : null;
  const btn = row?.querySelector('a.pr-ov-btn.start');
  if (btn) { btn.classList.add('busy'); btn.textContent = '⏳ 启动中…'; }
  try {
    const r = await _prApi('POST', '/api/pr-review/monitor/start', { number: prNumber, repo }, 90000);
    if (r.status === 200 && r.data?.success) {
      await _loadPrRuns(false);      // 刷新 run 列表
      await loadGitcodePrs();        // 刷新 PR 总览监控状态
    } else if (r.status === 409) {
      // 该 PR 已有进行中的监控任务
      alert(r.data?.message || `PR #${prNumber} 已在监控中，无需重复开启`);
      await loadGitcodePrs();
    } else {
      alert('开启监控失败：' + (r.data?.message || 'HTTP ' + r.status));
      await loadGitcodePrs();
    }
  } catch (e) {
    alert('开启监控失败：' + e.message);
    await loadGitcodePrs();
  }
}

/* 一键重发 start build：以 PR 作者身份评论并唤醒监控（run 停在人工确认时） */
async function retryStartBuild(runId) {
  if (!getAuth()) return;
  if (!confirm('确定要以 PR 作者身份评论 start build 吗？\n\n将在 GitCode PR 上发布一条 start build 评论并唤醒监控任务。\n前提：PR 作者已在 AIWeb 绑定 GitCode 令牌。')) return;
  const btn = document.querySelector(`a.pr-act[onclick*="retryStartBuild('${runId}'"]`);
  if (btn) { btn.style.opacity = '.5'; btn.style.pointerEvents = 'none'; btn.textContent = '⏳ 重发中…'; }
  try {
    const r = await _prApi('POST', `/api/pr-review/runs/${encodeURIComponent(runId)}/retry-build`, {}, 90000);
    if (r.status === 200 && r.data?.success) {
      alert('✅ ' + (r.data?.message || '已评论 start build，正在唤醒监控任务'));
      await _loadPrRuns(false);
    } else {
      alert('重发失败：' + (r.data?.message || 'HTTP ' + r.status));
      if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; btn.textContent = '🔄 一键重发 start build'; }
    }
  } catch (e) {
    alert('重发失败：' + e.message);
    if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; btn.textContent = '🔄 一键重发 start build'; }
  }
}

async function confirmPrApproval(runId) {
  if (!getAuth()) return;
  const run = _prRunCache[runId];
  const ask = run?.approvalAsk || '确认当前建议的下一步？';
  if (!confirm(ask)) return;
  try {
    const r = await _prApi('POST', `/api/pr-review/runs/${encodeURIComponent(runId)}/confirm-approval`, {}, 30000);
    if (r.status === 200 && r.data?.success) {
      await _loadPrRuns(false);
    } else {
      alert('确认失败：' + (r.data?.message || 'HTTP ' + r.status));
    }
  } catch (e) {
    alert('确认失败：' + e.message);
  }
}

async function syncToSiblingBranches(runId) {
  if (!getAuth()) return;
  if (!confirm('先用 AI 判断这份修改能不能套到同主题的其他 PR。\n能套上的会推送代码，并重新开启那些 PR 的监控。\n不能套上的只显示原因，不会推送。')) return;
  const slot = document.getElementById(`pr-sync-${runId}`);
  if (slot) {
    slot.style.display = '';
    slot.innerHTML = '<div class="pr-sync-line">正在分析兄弟分支…</div>';
  }
  try {
    const r = await _prApi('POST', `/api/pr-review/runs/${encodeURIComponent(runId)}/sync-to-siblings`, {}, 180000);
    const data = r.data || {};
    if (r.status !== 200 || !data.success) {
      if (slot) slot.innerHTML = `<div class="pr-sync-line bad">${escHtml(data.message || '同步失败')}</div>`;
      return;
    }
    const rows = (data.results || []).map(item => {
      const head = item.headRef ? `（${item.headRef}）` : '';
      return `<div class="pr-sync-line ${item.canSync ? 'ok' : 'bad'}">#${escHtml(String(item.number))}${escHtml(head)}：${escHtml(item.reason || '')}</div>`;
    }).join('');
    if (slot) slot.innerHTML = `<div class="pr-sync-line">${escHtml(data.message || '')}</div>${rows || '<div class="pr-sync-line">没有兄弟分支。</div>'}`;
    if ((data.results || []).some(item => item.canSync)) await _loadPrRuns(false);
  } catch (e) {
    if (slot) slot.innerHTML = `<div class="pr-sync-line bad">${escHtml(e.message || '同步失败')}</div>`;
  }
}

async function stopPrMonitorById(runId, prNumber) {  if (!getAuth()) return;
  if (!confirm(`确认关闭 PR #${prNumber} 的监控任务？`)) return;
  // 乐观 UI：停止涉及子进程清理，可能耗时数秒，先给"停止中"反馈
  const btn = document.querySelector(`a.pr-ov-btn[onclick*="stopPrMonitorById('${runId}'"]`);
  if (btn) { btn.classList.add('busy'); btn.textContent = '⏳ 停止中…'; }
  try {
    const r = await _prApi('POST', '/api/pr-review/monitor/stop', { runId }, 90000);
    if (r.status === 200 && r.data?.success) {
      await _loadPrRuns(false);
      await loadGitcodePrs();
    } else {
      alert('关闭监控失败：' + (r.data?.message || 'HTTP ' + r.status));
      await loadGitcodePrs();
    }
  } catch (e) {
    alert('关闭监控失败：' + e.message);
    await loadGitcodePrs();
  }
}

/* ── run 列表加载与渲染 ── */

async function _loadPrRuns(showError) {
  if (!getAuth()) return;
  // 并发防抖：手动刷新与自动刷新叠加时，只采纳最后一次请求的结果（旧响应丢弃）
  const reqId = ++_prRunsReqSeq;
  try {
    const r = await _prApi('GET', '/api/pr-review/runs?page=1&pageSize=50', null, 20000);
    if (reqId !== _prRunsReqSeq) return; // 已有更新的请求，丢弃本次
    if (r.status !== 200 || !r.data?.success) {
      if (showError) _showPrErr(r.data?.message || `加载失败（HTTP ${r.status}）`);
      return;
    }
    const runs = r.data.runs || [];
    const newCache = {};
    for (const run of runs) newCache[run.runId] = run;
    _prRunCache = newCache;
    _prLastRefreshAt = Date.now();
    _hidePrErr();   // 刷新成功即清除历史错误提示
    _updatePrLivePill();
    _renderPrStats(runs);
    _renderPrRunList(runs);
    _restorePrOutputs();
  } catch (e) {
    if (showError && reqId === _prRunsReqSeq) _showPrErr('加载失败：' + e.message);
  }
}

/* 刷新重建列表后，恢复用户打开中的输出区与正在阅读的文件（静默重载，不打断阅读） */
async function _restorePrOutputs() {
  for (const runId of _prOpenOutputs) {
    if (!_prRunCache[runId]) { _prOpenOutputs.delete(runId); continue; }
    await showPrRunOutputs(runId, true);
    const idx = _prViewingFile[runId];
    if (idx !== undefined) await showPrOutputContent(runId, idx, true);
  }
  for (const runId of _prOpenReviewFix) {
    if (!_prRunCache[runId]) { _prOpenReviewFix.delete(runId); continue; }
    await showReviewFix(runId, true);
  }
}

/* 统计 + 实时指示 */
function _renderPrStats(runs) {
  let running = 0, approval = 0, done = 0;
  for (const r of runs) {
    if (r.currentPhase === PR_HUMAN_PHASE && !PR_TERMINAL.has(r.status) && _prApprovalKind[r.runId] !== 'suspended') approval++;
    else if (!PR_TERMINAL.has(r.status)) running++;
    else if (r.status === 'completed') done++;
  }
  $('pr-st-total').textContent = runs.length;
  $('pr-st-running').textContent = running;
  $('pr-st-approval').textContent = approval;
  $('pr-st-done').textContent = done;
}

function _updatePrLivePill() {
  const txt = $('pr-refresh-text');
  if (!txt) return;
  if (!_prLastRefreshAt) { txt.textContent = '实时'; return; }
  const ago = Math.floor((Date.now() - _prLastRefreshAt) / 1000);
  txt.textContent = ago < 3 ? '刚刚刷新' : `${ago}s 前刷新`;
}

/* 手动刷新：立即拉取列表 + PR 总览（绕过缓存）+ 展开中的详情（带防重入） */
let _prManualRefreshing = false;
async function manualRefreshPr() {
  if (!getAuth()) return;
  if (_prManualRefreshing) return;
  _prManualRefreshing = true;
  const btn = document.querySelector('.pr-refresh-btn');
  if (btn) { btn.classList.add('spinning'); }
  try {
    await Promise.all([
      _loadPrRuns(true),
      loadGitcodePrs(true),
    ]);
    for (const runId of [..._prOpenSet]) {
      _loadPrRunDetail(runId);
    }
  } finally {
    _prManualRefreshing = false;
    // 至少转半圈再停，给操作反馈
    setTimeout(() => btn && btn.classList.remove('spinning'), 500);
  }
}

/* 筛选 */
function setPrFilter(filter) {
  _prFilter = filter;
  document.querySelectorAll('.pr-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.filter === filter);
  });
  _renderPrRunList(Object.values(_prRunCache));
}

function _prMatchFilter(run) {
  if (_prRunRepoFilter === '__unknown__' && run.repo) return false;
  if (_prRunRepoFilter !== 'all' && _prRunRepoFilter !== '__unknown__' && run.repo !== _prRunRepoFilter) return false;
  const isApproval = run.currentPhase === PR_HUMAN_PHASE && !PR_TERMINAL.has(run.status) && _prApprovalKind[run.runId] !== 'suspended';
  const isRunning = !PR_TERMINAL.has(run.status) && !isApproval;
  switch (_prFilter) {
    case 'running':   return isRunning;
    case 'approval':  return isApproval;
    case 'completed': return run.status === 'completed';
    case 'failed':    return ['failed', 'crashed', 'stopped'].includes(run.status);
    default:          return true;
  }
}

/* 任务列表仓库筛选（多仓时显示 chips）：all / flutter / engine */
let _prRunRepoFilter = 'all';

function setPrRunRepoFilter(repo) {
  if (_prRunRepoFilter === repo) return;
  _prRunRepoFilter = repo;
  const select = $('pr-run-repo-filter');
  if (select) select.value = repo;
  _renderPrRunList(Object.values(_prRunCache));
}

/* 根据实际 run 仓库生成筛选项；支持组织中任意数量的仓库。 */
function _updatePrRepoChips(runs) {
  const wrap = $('pr-run-repo-filter-wrap');
  const separator = $('pr-run-repo-separator');
  const select = $('pr-run-repo-filter');
  if (!wrap || !select) return;
  const repos = [...new Set(runs.map(run => String(run.repo || '').trim() || '__unknown__'))].sort((a, b) => a.localeCompare(b));
  if (repos.length < 2) {
    _prRunRepoFilter = 'all';
    wrap.style.display = 'none';
    if (separator) separator.style.display = 'none';
    return;
  }
  if (_prRunRepoFilter !== 'all' && !repos.includes(_prRunRepoFilter)) _prRunRepoFilter = 'all';
  const counts = new Map(repos.map(repo => [repo, 0]));
  for (const run of runs) {
    const key = String(run.repo || '').trim() || '__unknown__';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  select.innerHTML = [
    `<option value="all">全部仓库（${runs.length}）</option>`,
    ...repos.map(repo => `<option value="${escHtml(repo)}"${_prRunRepoFilter === repo ? ' selected' : ''}>${repo === '__unknown__' ? '未识别仓库' : escHtml(repo)}（${counts.get(repo) || 0}）</option>`),
  ].join('');
  wrap.style.display = 'inline-flex';
  if (separator) separator.style.display = '';
}

/* ── 卡片原地更新（不重建 DOM，防闪烁/保滚动位置） ── */
function _updateRunCardInPlace(card, run, meta) {
  const isTerminal = PR_TERMINAL.has(run.status);
  const isApproval = run.currentPhase === PR_HUMAN_PHASE && !isTerminal;
  const progress = run.totalSteps > 0 ? Math.min(100, Math.round((run.completedSteps / run.totalSteps) * 100)) : 0;
  const stateCls = _prCardStateCls(run.status);

  // 状态类（不动 DOM 结构，只换 class；仓库色条 class 随 run.repo 保留）
  const repoCls = run.repo === 'flutter_engine' ? ' repo-engine'
    : run.repo === 'flutter_flutter' ? ' repo-flutter' : '';
  const wantCls = `pr-card ${stateCls}${repoCls}${isApproval ? ' need-approval' : ''}${card.classList.contains('open') ? ' open' : ''}`;
  if (card.className !== wantCls) card.className = wantCls;

  // 状态点
  const dot = card.querySelector('.pr-dot');
  const wantDot = _prDotCls(run.status, isApproval);
  if (dot && !dot.className.endsWith(wantDot)) dot.className = `pr-dot ${wantDot}`;

  // 徽章文本（保留 refine 后的"等待 CI"细分——只有真变化才改写）
  const head = card.querySelector('.pr-card-head');
  let approvalBadge = head?.querySelector('.b-approval, .b-waiting');
  if (isApproval && !approvalBadge && head) {
    approvalBadge = document.createElement('span');
    approvalBadge.className = 'pr-badge b-approval';
    approvalBadge.textContent = '⚠️ 需人工确认';
    head.insertBefore(approvalBadge, head.querySelector('.tc-spacer'));
  } else if (!isApproval && approvalBadge) {
    approvalBadge.remove();
    delete _prApprovalKind[run.runId];
    delete _prApprovalCheckedAt[run.runId];
  }
  const badge = card.querySelector(`.pr-card-head .pr-badge:not(.b-approval):not(.b-waiting)`);
  const wantBadge = `${meta.icon} ${meta.label}`;
  if (badge && badge.textContent !== wantBadge) badge.textContent = wantBadge;
  const taskBar = card.querySelector('.pr-task-bar');
  if (taskBar) {
    const keepSync = taskBar.querySelector('.pr-sync-result');
    const syncOpen = keepSync && keepSync.style.display !== 'none' ? keepSync.innerHTML : '';
    const nextHtml = _prTaskBarHtml(run);
    if (taskBar._barHtml !== nextHtml) {
      taskBar._barHtml = nextHtml;
      taskBar.innerHTML = nextHtml;
      if (syncOpen) {
        const slot = taskBar.querySelector('.pr-sync-result');
        if (slot) { slot.style.display = ''; slot.innerHTML = syncOpen; }
      }
    }
  }

  // 进度条（宽度动画自动过渡）
  const fill = card.querySelector('.pr-progress-fill');
  if (fill) fill.style.width = progress + '%';
  const progressNum = card.querySelector('.pr-progress-label span:last-child');
  const wantNum = `${run.completedSteps ?? 0}/${run.totalSteps ?? 0}（${progress}%）`;
  if (progressNum && progressNum.innerHTML !== `<b>${run.completedSteps ?? 0}</b>/${run.totalSteps ?? 0}（${progress}%）`) {
    progressNum.innerHTML = `<b>${run.completedSteps ?? 0}</b>/${run.totalSteps ?? 0}（${progress}%）`;
  }
  // 阶段名
  const phaseLabel = card.querySelector('.pr-progress-label span:first-child');
  const wantPhase = `步骤进度${run.currentPhase && run.currentPhase !== PR_HUMAN_PHASE ? ` · ${run.currentPhase}` : ''}`;
  if (phaseLabel && phaseLabel.textContent !== wantPhase) phaseLabel.textContent = wantPhase;

  // 时长
  const durEl = card.querySelector('.pr-meta-row .pr-m:nth-child(2)');
  if (durEl) durEl.textContent = `⏱ ${_fmtPrDuration(run.startTime, run.endTime)}`;

  // Token 用量（来源感知：未知显示"未知"，不再因 totalTokens=0 而隐藏）
  const metaRow = card.querySelector('.pr-meta-row');
  const tokEl = metaRow?.querySelector('.pr-m[title="Token 用量"]');
  const tokenText = `📊 ${_fmtPrTokensWithSource(run)}`;
  if (!tokEl) {
    // 插入（在失败步骤前）
    const failEl = metaRow?.querySelector('.pr-m[title="失败步骤"]');
    const el = document.createElement('span');
    el.className = 'pr-m'; el.title = 'Token 用量';
    el.textContent = tokenText;
    if (failEl) metaRow.insertBefore(el, failEl); else metaRow.appendChild(el);
  } else if (tokEl.textContent !== tokenText) {
    tokEl.textContent = tokenText;
  }

  // 监控完成语义提示（run 在页面打开期间进入 completed 时补插）
  if (run.status === 'completed' && !card.querySelector('.pr-done-note') && metaRow) {
    const note = document.createElement('div');
    note.className = 'pr-done-note';
    note.id = `pr-done-note-${run.runId}`;
    note.innerHTML = _prDoneNoteInner(run);
    metaRow.insertAdjacentElement('afterend', note);
  }
  const doneNote = card.querySelector('.pr-done-note');
  if (doneNote && run.status === 'completed') {
    const content = _prDoneNoteInner(run);
    if (doneNote.innerHTML !== content) doneNote.innerHTML = content;
  }
}

/* 人工待办横幅：有任务停在"人工确认"（非挂起等CI）时醒目提醒，点击直达任务卡片 */
function _renderApprovalBanner(runs) {
  const banner = document.getElementById('pr-approval-banner');
  if (!banner) return;
  const items = runs.filter(r =>
    r.currentPhase === PR_HUMAN_PHASE && !PR_TERMINAL.has(r.status)
    && r.approvalKind !== 'suspended' && _prApprovalKind[r.runId] !== 'suspended'
  );
  if (!items.length) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }
  const chipHtml = items.map(r => {
    const repoTag = r.repo === 'flutter_engine' ? '[engine]' : r.repo === 'flutter_flutter' ? '' : '';
    const label = `${repoTag}#${r.prNumber || r.runId.slice(-8)}`;
    const ask = String(r.approvalAsk || '').replace(/\s+/g, ' ').trim();
    const text = ask ? `${label}：${ask}` : `${label} 需要你确认`;
    return `<a class="pab-item" href="#pr-card-${escHtml(r.runId)}"
              onclick="event.preventDefault();document.getElementById('pr-card-${escHtml(r.runId)}')?.scrollIntoView({behavior:'smooth',block:'center'})">⚠️ ${escHtml(text)}</a>`;
  }).join('');
  banner.innerHTML = `
    <span class="pab-icon">🔔</span>
    <span class="pab-title">${items.length} 个任务等待你的决策</span>
    <span class="pab-list">${chipHtml}</span>
    <span class="pab-hint">点击查看详情并处理</span>`;
  banner.style.display = 'flex';
}

function _renderPrRunList(runs) {
  const list = $('pr-runs-list');
  if (!list) return;
  _updatePrRepoChips(runs);
  _renderApprovalBanner(runs);
  // 等待类型可能在同一个 human phase 内变化，隐藏卡片也必须重新查询。
  runs.filter(r => r.currentPhase === PR_HUMAN_PHASE && !PR_TERMINAL.has(r.status))
    .forEach(r => _refineApprovalBadge(r.runId));
  const filtered = runs.filter(_prMatchFilter);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pr-empty-state';
    if (runs.length > 0) {
      empty.innerHTML = `
        <div class="pr-empty-icon">🔍</div>
        <div class="pr-empty-title">当前筛选下没有任务</div>
        <div class="pr-empty-desc">切换上方筛选条件查看其他状态的任务</div>`;
    } else {
      empty.id = 'pr-runs-empty';
      empty.innerHTML = `
        <div class="pr-empty-icon">🔀</div>
        <div class="pr-empty-title">暂无 PR 监控任务</div>
        <div class="pr-empty-desc">在 AceHarness 工作台对目标 PR 评论 start build，<br/>或直接启动 gitcode-pr-review 工作流后，任务将自动出现在这里</div>`;
    }
    list.innerHTML = '';
    list.appendChild(empty);
  } else {
    // 增量更新：已有卡片原地更新（不重建、不闪、保滚动），新卡插入、消失卡移除
    const existing = new Map();
    for (const el of [...list.querySelectorAll('.pr-card')]) {
      const id = el.id.replace('pr-card-', '');
      if (!filtered.some(r => r.runId === id)) { el.remove(); continue; }
      existing.set(id, el);
    }
    list.querySelectorAll('.pr-empty-state').forEach(e => e.remove());
    let insertIdx = 0;
    for (const run of filtered) {
      const meta = _prStatusMeta(run.status);
      const card = existing.get(run.runId);
      if (card) {
        _updateRunCardInPlace(card, run, meta);
        // 顺序变化时移动节点（appendChild 移动不重建）
        const ref = list.children[insertIdx];
        if (ref !== card) list.insertBefore(card, ref || null);
      } else {
        const nc = _buildPrRunCard(run, insertIdx);
        const ref = list.children[insertIdx];
        list.insertBefore(nc, ref || null);
      }
      insertIdx++;
    }
  }
  $('pr-run-count').textContent = runs.length > 0 ? `${filtered.length}/${runs.length} 个` : '';
}

/* ── 工具函数 ── */

function _prApi(method, path, body, timeoutMs = 30000) {
  return authApi(method, path, body, timeoutMs);
}

function _prStatusMeta(status) {
  return PR_STATUS_META[status] || { label: status || '未知', icon: '❓', badge: 'b-stopped' };
}

function _fmtPrTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function _fmtPrDuration(startIso, endIso) {
  if (!startIso) return '-';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const sec = Math.floor(Math.max(0, end - start) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function _fmtPrTokens(n) {
  if (!n || n <= 0) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

/* R5：用量来源感知文本——reported/partial 显示数值，unavailable/缺失显示"未知"（不再隐藏或显示 0）。 */
function _fmtPrTokensWithSource(run) {
  const source = run.tokenUsageSource || (run.totalTokens > 0 ? 'reported' : 'unavailable');
  if (source === 'not_applicable') return '不适用';
  if (source === 'unavailable') return '未知';
  const base = _fmtPrTokens(run.totalTokens);
  return source === 'partial' ? `${base}（部分）` : base;
}

/* R1：监控结束语义提示。只有存在门禁通过证据才显示"门禁全绿"，关闭/阻塞/未知一律不宣称全绿。 */
function _prDoneNoteInner(run) {
  const tail = '任务结束后 PR 的新动态（如重新 start build 触发的重验）不会更新到此卡片。';
  const summary = run.gateSummary ? `（${escHtml(run.gateSummary)}）` : '';
  if (['partial', 'failed'].includes(run.artifactStatus)) {
    return `⚠️ 监控已结束，但运行证据归档${run.artifactStatus === 'partial' ? '不完整' : '失败'}，需要复核归档清单${summary}。${tail}`;
  }
  if (run.prState === 'closed') {
    return `⛔ PR 已关闭（未合入、未完成验证）：门禁未确认全绿${summary}。${tail}`;
  }
  if (run.prState === 'merged') {
    return `✅ PR 已合入。${tail}`;
  }
  if (run.gateOutcome === 'tester_approved') {
    return `✅ 测试人已通过，监控已结束，等待 PR 合入。${tail}`;
  }
  if (run.gateOutcome === 'green') {
    return `✅ AI 监控使命结束（任务结束时门禁全绿）。PR 尚未合入：<b>评审人/测试人审批、评论 submit</b> 仍需人工完成；${tail}`;
  }
  const label = run.gateOutcome === 'blocked' ? '被阻塞' : run.gateOutcome === 'failed' ? '未通过' : '结果未确认全绿';
  return `⚠️ AI 监控使命结束：门禁${label}${summary}，需人工处理或复核。${tail}`;
}

/* run 状态 → 卡片 CSS 状态类 */
function _prCardStateCls(status) {
  if (status === 'completed') return 'st-completed';
  if (['failed', 'crashed'].includes(status)) return 'st-failed';
  if (status === 'stopped') return 'st-stopped';
  return 'st-running';
}

/* run 状态 → 状态点 CSS 类 */
function _prDotCls(status, isApproval) {
  if (isApproval) return 'd-approval';
  if (status === 'completed') return 'd-completed';
  if (['failed', 'crashed'].includes(status)) return 'd-failed';
  if (status === 'stopped') return 'd-stopped';
  return 'd-running';
}

/* ── run 卡片构建 ── */

function _prTaskBarHtml(run) {
  const isTerminal = PR_TERMINAL.has(run.status);
  const num = /^\d+$/.test(String(run.prNumber || '')) ? String(run.prNumber) : '';
  const repo = String(run.repo || '');
  const ask = String(run.approvalAsk || '').trim();
  const next = String(run.approvalNext || '').trim();
  const human = run.approvalKind === 'human' && ask;
  const bits = [];
  if (ask) bits.push(`<div class="pr-approval-ask">${escHtml(ask)}</div>`);
  const buttons = [];
  if (human && next) {
    buttons.push(`<a class="pr-act pr-act-confirm" href="#" onclick="event.preventDefault();confirmPrApproval('${escHtml(run.runId)}')">确认进入「${escHtml(next)}」</a>`);
  }
  if (!isTerminal) {
    buttons.push(`<a class="pr-act" href="#" onclick="event.preventDefault();stopPrMonitorById('${escHtml(run.runId)}', '${escHtml(num)}')">⏹ 停止监控</a>`);
  } else if (num) {
    buttons.push(`<a class="pr-act" href="#" onclick="event.preventDefault();startPrMonitorByNumber(${num}, '${escHtml(repo)}')">▶ 重新开启监控</a>`);
  }
  if (num) {
    buttons.push(`<a class="pr-act" href="#" onclick="event.preventDefault();syncToSiblingBranches('${escHtml(run.runId)}')">⇄ 同步到兄弟分支</a>`);
  }
  bits.push(`<div class="pr-task-actions">${buttons.join('')}</div>`);
  bits.push(`<div class="pr-sync-result" id="pr-sync-${escHtml(run.runId)}" style="display:none"></div>`);
  return bits.join('');
}

function _buildPrRunCard(run, idx = 0) {
  const meta = _prStatusMeta(run.status);
  const isTerminal = PR_TERMINAL.has(run.status);
  const isApproval = run.currentPhase === PR_HUMAN_PHASE && !isTerminal;
  const progress = run.totalSteps > 0 ? Math.min(100, Math.round((run.completedSteps / run.totalSteps) * 100)) : 0;
  const prNum = run.prNumber || null;
  // 仓库徽章：flutter 蓝 / engine 紫（与 PR 总览配色一致），卡片左侧同步色条（CSS ::before）
  const repoCls = run.repo === 'flutter_engine' ? ' repo-engine'
    : run.repo === 'flutter_flutter' ? ' repo-flutter' : '';
  const repoBadge = run.repo
    ? `<span class="pr-card-repo-badge ${run.repo === 'flutter_engine' ? 'rb-engine' : 'rb-flutter'}" title="${escHtml(run.repo)}">${escHtml(run.repo.replace(/^flutter_/, ''))}</span>`
    : '';
  const title = prNum ? `PR #${prNum}` : (run.runId || '').slice(0, 24);
  const prTitleText = String(run.prTitle || '').trim();
  const prTitleHtml = prTitleText
    ? `<span class="pr-card-pr-title" title="${escHtml(prTitleText)}">${escHtml(prTitleText)}</span>`
    : '';
  const isOpen = _prOpenSet.has(run.runId);

  const card = document.createElement('div');
  card.className = `pr-card ${_prCardStateCls(run.status)}${repoCls}${isApproval ? ' need-approval' : ''}${isOpen ? ' open' : ''}`;
  card.id = `pr-card-${run.runId}`;
  card.style.animationDelay = `${Math.min(idx, 12) * 45}ms`;
  card.innerHTML = `
    <div class="pr-card-head" onclick="togglePrRunDetail('${escHtml(run.runId)}')">
      <span class="pr-dot ${_prDotCls(run.status, isApproval)}" title="${escHtml(meta.label)}"></span>
      <span class="pr-card-title">
        <span class="chev">▶</span>
        ${repoBadge}
        <span class="pr-num">${escHtml(title)}</span>
        ${prTitleHtml}
      </span>
      ${isApproval ? `<span class="pr-badge ${run.approvalKind === 'suspended' ? 'b-waiting' : 'b-approval'}">${run.approvalKind === 'suspended' ? '⏳ 等待 CI 门禁' : '⚠️ 需人工确认'}</span>` : ''}
      <span class="tc-spacer"></span>
      ${run.workbenchUrl ? `
        <a class="pr-wb-link" href="${escHtml(run.workbenchUrl)}" target="_blank" rel="noopener noreferrer"
           onclick="event.stopPropagation()">🔗 工作台</a>` : ''}
      <span class="pr-badge ${meta.badge}">${meta.icon} ${escHtml(meta.label)}</span>
    </div>
    <div class="pr-task-bar" id="pr-taskbar-${escHtml(run.runId)}">${_prTaskBarHtml(run)}</div>
    <div class="pr-card-body">
      <div class="pr-card-body-inner">
      <div class="pr-progress-zone">
        <div class="pr-progress-label">
          <span>步骤进度${run.currentPhase && run.currentPhase !== PR_HUMAN_PHASE ? ` · ${escHtml(run.currentPhase)}` : ''}</span>
          <span><b>${run.completedSteps ?? 0}</b>/${run.totalSteps ?? 0}（${progress}%）</span>
        </div>
        <div class="pr-progress"><div class="pr-progress-fill" style="width:${progress}%"></div></div>
      </div>
      <div class="pr-meta-row">
        <span class="pr-m" title="开始时间">🕐 ${escHtml(_fmtPrTime(run.startTime))}</span>
        <span class="pr-m" title="持续时间">⏱ ${escHtml(_fmtPrDuration(run.startTime, run.endTime))}</span>
        <span class="pr-m" title="Token 用量">📊 ${escHtml(_fmtPrTokensWithSource(run))}</span>
        ${run.failedSteps > 0 ? `<span class="pr-m" title="失败步骤" style="color:var(--err)">✗ ${run.failedSteps} 个失败步骤</span>` : ''}
        <span class="pr-m" title="Run ID" style="min-width:0;overflow:hidden;text-overflow:ellipsis">
          <a href="#" onclick="event.preventDefault();_copyPrRunId('${escHtml(run.runId)}')" title="点击复制 Run ID">🆔 ${escHtml(run.runId)}</a>
        </span>
      </div>
      ${run.status === 'completed' ? `
        <div class="pr-done-note" id="pr-done-note-${escHtml(run.runId)}">${_prDoneNoteInner(run)}</div>` : ''}
      <div class="pr-detail" id="pr-detail-${escHtml(run.runId)}">
        <div style="font-size:var(--font-size-xs);color:var(--dim);padding:6px 0">点击展开加载实时详情…</div>
      </div>
      <div class="pr-actions" data-actions="task-controls">
        <a class="pr-act" href="#" onclick="event.preventDefault();showPrRunOutputs('${escHtml(run.runId)}')">📄 步骤输出</a>
        <a class="pr-act" href="#" onclick="event.preventDefault();showReviewFix('${escHtml(run.runId)}')">🤖 检视修复</a>
        <a class="pr-act" href="#" onclick="event.preventDefault();_loadPrRunDetail('${escHtml(run.runId)}')">🔄 刷新详情</a>
      </div>
      <div class="pr-files-zone" id="pr-outputs-${escHtml(run.runId)}" style="display:none"></div>
      <div class="pr-files-zone" id="pr-reviewfix-${escHtml(run.runId)}" style="display:none"></div>
      </div>
    </div>`;
  return card;
}

/* ── 卡片展开/收起 ── */
async function togglePrRunDetail(runId) {
  const card = document.getElementById(`pr-card-${runId}`);
  if (!card) return;
  const willOpen = !card.classList.contains('open');
  if (!willOpen) {
    _prOpenSet.delete(runId);
    card.classList.remove('open');
    return;
  }
  card.classList.add('open');
  // 立即展开并显示加载状态，避免点击后长时间没有反馈。
  _prOpenSet.add(runId);
  if (!_prLoadingDetail[runId]) {
    await _loadPrRunDetail(runId);
  }
}

/* ── 详情加载（实时状态 + 步骤时间线） ── */
async function _loadPrRunDetail(runId) {
  const container = document.getElementById(`pr-detail-${runId}`);
  if (!container || _prLoadingDetail[runId]) return;
  _prLoadingDetail[runId] = true;
  // 加载提示仅首次显示（此前已渲染过详情时静默刷新，避免"加载中"闪烁）
  if (!container._lastHtml) {
    container.innerHTML = '<div style="font-size:var(--font-size-xs);color:var(--dim);padding:6px 0">加载实时详情中…</div>';
  }

  try {
    const r = await _prApi('GET', `/api/pr-review/runs/${encodeURIComponent(runId)}/status`, null, 20000);
    if (r.status !== 200 || !r.data?.success) {
      const error = `<div class="error-msg" style="display:block">${escHtml(r.data?.message || '详情加载失败')} · <a href="#" onclick="event.preventDefault();_loadPrRunDetail('${escHtml(runId)}')">点击重试</a></div>`;
      container.innerHTML = container._lastHtml ? `${container._lastHtml}${error}` : error;
      return;
    }
    const st = r.data.status || {};
    const steps = st.stepLogs || [];

    let html = st.staleStatus
      ? `<div class="pr-banner pr-banner-waiting">⚠️ AceHarness 暂时未响应，以下是 ${escHtml(st.staleAt || '最近一次')} 的步骤快照。</div>`
      : '';

    // 人工确认横幅（区分：挂起等 CI 门禁 → 自动继续无需操作；其余 → 真需人工处理）
    if (!PR_TERMINAL.has(st.status) && st.currentPhase === PR_HUMAN_PHASE) {
      const isSuspendedWait = _approvalKindFromStatus(st) === 'suspended';
      if (isSuspendedWait) {
        html += `
          <div class="pr-banner pr-banner-waiting">
            <span>⏳</span>
            <span>等待 CI 门禁结果 — 工作流已挂起待命，CI 出结果后<b>自动继续</b>，无需操作</span>
          </div>`;
      } else {
        const ask = st.approval?.ask || _prRunCache[runId]?.approvalAsk || '需要你确认下一步。请看下方说明。';
        const next = st.approval?.suggestedNextState || _prRunCache[runId]?.approvalNext || '';
        html += `
          <div class="pr-banner pr-banner-approval">
            <span>⚠️</span>
            <span>${escHtml(ask)}</span>
            ${next ? `<a class="pr-wb-link" href="#" onclick="event.preventDefault();confirmPrApproval('${escHtml(runId)}')">确认进入「${escHtml(next)}」</a>` : ''}
          </div>`;
      }
    }

    // 门禁根因/维护提醒（普通详情即可见，不必打开"检视修复"面板）
    html += _gateDiagnosisHtml(st.gateDiagnosis);

    // 最终评审摘要
    if (st.finalReview?.summary) {
      html += `
        <div class="pr-banner pr-banner-review">
          <span class="rv-title">📋 最终评审</span>
          <div class="rv-body">${escHtml(st.finalReview.summary)}</div>
        </div>`;
    }

    // 当前阶段信息
    if (!PR_TERMINAL.has(st.status)) {
      html += `<div style="font-size:var(--font-size-xs);color:var(--text-aux);margin-bottom:8px">
        阶段：<b>${escHtml(st.currentPhase || '-')}</b> ｜ 当前步骤：<b>${escHtml(st.currentStep || '-')}</b></div>`;
    }

    // 步骤时间线
    if (steps.length > 0) {
      html += '<div class="pr-timeline">' + steps.map(s => {
        const cls = s.status === 'completed' ? 'tl-completed' : s.status === 'failed' ? 'tl-failed'
          : s.status === 'running' ? 'tl-running' : '';
        const icon = s.status === 'completed' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'running' ? '●' : '○';
        const dur = s.durationMs ? `${Math.round(s.durationMs / 1000)}s` : '';
        return `
          <div class="pr-tl-item ${cls}" title="${escHtml(s.stepName || '')}">
            <span style="width:14px;flex-shrink:0;text-align:center">${icon}</span>
            <span class="tl-name">${escHtml(s.stepName || '-')}</span>
            ${s.agent ? `<span class="tl-agent">🤖 ${escHtml(s.agent)}</span>` : ''}
            ${dur ? `<span class="tl-time">${escHtml(dur)}</span>` : ''}
          </div>`;
      }).join('') + '</div>';
    } else {
      html += '<div style="font-size:var(--font-size-xs);color:var(--dim)">暂无步骤日志</div>';
    }

    // 内容无变化时跳过重写（自动刷新不打断阅读，不闪烁）
    if (container._lastHtml === html && container.innerHTML === html) return;
    container._lastHtml = html;
    container.innerHTML = html;
  } catch (e) {
    const error = `<div style="font-size:var(--font-size-xs);color:var(--err);padding:6px 0">
      详情加载失败：${escHtml(e.message)} · <a href="#" style="color:var(--accent)" onclick="event.preventDefault();_loadPrRunDetail('${escHtml(runId)}')">点击重试</a>
    </div>`;
    container.innerHTML = container._lastHtml ? `${container._lastHtml}${error}` : error;
  } finally {
    _prLoadingDetail[runId] = false;
  }
}

/* ── 输出文件 ── */

let _prArchiveOpen = {};   // runId -> 历史归档是否展开（自动刷新重渲染后保持状态）

/* 单个文件 chip（data-idx 携带原始数组索引，分组/排序后查看与高亮仍按索引定位） */
function _prChipHtml(runId, idx, label, title) {
  return `<a class="pr-file-chip" data-idx="${idx}" href="#" onclick="event.preventDefault();showPrOutputContent('${escHtml(runId)}',${idx})"
            title="${escHtml(title || label)}">📄 ${escHtml(label)}</a>`;
}

/* 输出文件三分类：
 *   关键产物  —— 无时间戳的非步骤 .md 文件（gate-check.json / fix.patch / pr-comment.json 等）
 *   步骤输出  —— 无时间戳的「阶段-步骤.md」，按阶段分组，chip 只显示步骤名
 *   历史归档  —— 「时间戳-阶段-步骤.md」执行快照，默认折叠，chip 显示 HH:mm + 步骤名 */
function _prClassifyOutputs(files) {
  const artifacts = [];
  const phases = new Map();
  const archives = [];
  const TS = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/;
  files.forEach((f, idx) => {
    const fname = f.filename || '';
    const name = f.stepName || fname || '未命名';
    const m = TS.exec(name);
    if (m) {
      const t = name.slice(11, 19).replace(/-/g, ':');   // 14-27-33 → 14:27:33
      archives.push({ idx, label: `${t} ${m[1]}` });
    } else if (/\.md$/i.test(fname) && name.includes('-')) {
      const dash = name.indexOf('-');
      const phase = name.slice(0, dash);
      const step = name.slice(dash + 1).replace(/\.md$/i, '');
      if (!phases.has(phase)) phases.set(phase, []);
      phases.get(phase).push({ idx, step });
    } else {
      artifacts.push({ idx, label: name });
    }
  });
  return { artifacts, phases, archives };
}

async function showPrRunOutputs(runId, isRestore = false) {
  const box = document.getElementById(`pr-outputs-${runId}`);
  if (!box) return;
  // 自动刷新恢复：输出区已打开则保持不动（不关不重拉，避免闪烁空窗）；仅手动点击才走关闭分支
  if (box.style.display === 'block' && box._files) {
    if (isRestore) return;
    box.style.display = 'none';
    _prOpenOutputs.delete(runId);
    return;
  }
  box.style.display = 'block';
  if (!isRestore) _prOpenOutputs.add(runId);
  box.innerHTML = '<div style="font-size:var(--font-size-xs);color:var(--dim);padding:8px 0">加载输出列表中…</div>';

  try {
    const r = await _prApi('GET', `/api/pr-review/runs/${encodeURIComponent(runId)}/outputs`, null, 20000);
    if (r.status !== 200 || !r.data?.files) {
      box.innerHTML = `<div class="error-msg" style="display:block">${escHtml(r.data?.message || '暂无输出')}</div>`;
      return;
    }
    const files = r.data.files || [];
    if (files.length === 0) {
      box.innerHTML = '<div style="font-size:var(--font-size-xs);color:var(--dim);padding:8px 0">暂无输出文件</div>';
      return;
    }
    const { artifacts, phases, archives } = _prClassifyOutputs(files);
    let html = `<div style="font-size:var(--font-size-xs);color:var(--text-aux);margin:6px 0">输出文件（${files.length} 个，点击查看内容）：</div>`;

    // ① 关键产物（结构化数据，重点展示）
    if (artifacts.length) {
      html += `
        <div style="margin:8px 0 4px;font-size:var(--font-size-xs);color:var(--warn);font-weight:600">🔑 关键产物</div>
        <div class="pr-files-wrap">${artifacts.map(a => _prChipHtml(runId, a.idx, a.label)).join('')}</div>`;
    }

    // ② 最新步骤输出（按阶段分组，阶段名做行首标签）
    if (phases.size) {
      html += `<div style="margin:10px 0 4px;font-size:var(--font-size-xs);color:var(--text-aux);font-weight:600">📋 步骤输出（最新）</div>`;
      for (const [phase, steps] of phases) {
        html += `
          <div style="margin:4px 0;display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap">
            <span style="font-size:var(--font-size-xs);color:var(--dim);min-width:76px;padding:4px 0">${escHtml(phase)}</span>
            <div class="pr-files-wrap" style="max-height:none;overflow:visible;padding:0">${steps.map(s => _prChipHtml(runId, s.idx, s.step, `${phase}-${s.step}`)).join('')}</div>
          </div>`;
      }
    }

    // ③ 历史归档（各步骤执行时的时间戳快照，默认折叠）
    if (archives.length) {
      const open = !!_prArchiveOpen[runId];
      html += `
        <div style="margin:10px 0 4px">
          <a href="#" onclick="event.preventDefault();window._prToggleArchive('${escHtml(runId)}')"
             style="font-size:var(--font-size-xs);color:var(--dim);text-decoration:none">
             <span id="pr-arch-arrow-${escHtml(runId)}">${open ? '▾' : '▸'}</span> 🗄 历史归档（${archives.length} 个执行快照）</a>
        </div>
        <div id="pr-archives-${escHtml(runId)}" style="display:${open ? 'block' : 'none'}">
          <div class="pr-files-wrap">${archives.map(a => _prChipHtml(runId, a.idx, a.label)).join('')}</div>
        </div>`;
    }

    html += `<div id="pr-output-content-${escHtml(runId)}" style="display:none"></div>`;
    box.innerHTML = html;
    box._files = files;
  } catch (e) {
    box.innerHTML = `<div style="font-size:var(--font-size-xs);color:var(--err);padding:8px 0">
      加载输出失败：${escHtml(e.message)} · <a href="#" style="color:var(--accent)" onclick="event.preventDefault();showPrRunOutputs('${escHtml(runId)}')">点击重试</a>
    </div>`;
  }
}

/* 历史归档折叠开关（不重拉数据，只切换显示） */
window._prToggleArchive = function (runId) {
  _prArchiveOpen[runId] = !_prArchiveOpen[runId];
  const zone = document.getElementById(`pr-archives-${runId}`);
  const arrow = document.getElementById(`pr-arch-arrow-${runId}`);
  if (zone) zone.style.display = _prArchiveOpen[runId] ? 'block' : 'none';
  if (arrow) arrow.textContent = _prArchiveOpen[runId] ? '▾' : '▸';
};

/* ═══════════ AI 检视修复：意见/修改可视化 + 用户决策 ═══════════ */

/* 切换显示检视修复区（懒加载，与「步骤输出」同模式） */
async function showReviewFix(runId, isRestore = false) {
  const box = document.getElementById(`pr-reviewfix-${runId}`);
  if (!box) return;
  if (box._loadingPromise) return box._loadingPromise;
  if (box.style.display === 'block' && box._data) {
    if (isRestore) return;
    box.style.display = 'none';
    _prOpenReviewFix.delete(runId);
    return;
  }
  box.style.display = 'block';
  if (!isRestore) _prOpenReviewFix.add(runId);
  box.innerHTML = '<div style="font-size:var(--font-size-xs);color:var(--dim);padding:8px 0">加载检视修复数据中…</div>';

  const loadPromise = (async () => {
    try {
      const r = await _prApi('GET', `/api/pr-review/runs/${encodeURIComponent(runId)}/review-fix`, null, 35000);
      if (r.status !== 200 || !r.data?.success) {
        box.innerHTML = `<div class="error-msg" style="display:block">${escHtml(r.data?.message || '加载失败')}</div>`;
        return;
      }
      box._data = r.data;
      box.innerHTML = _renderReviewFix(runId, r.data);
    } catch (e) {
      box.innerHTML = `<div style="font-size:var(--font-size-xs);color:var(--err);padding:8px 0">
        加载检视修复数据失败：${escHtml(e.message)} · <a href="#" style="color:var(--accent)" onclick="event.preventDefault();showReviewFix('${escHtml(runId)}')">点击重试</a>
      </div>`;
    }
  })();
  box._loadingPromise = loadPromise;
  try { await loadPromise; }
  finally { if (box._loadingPromise === loadPromise) box._loadingPromise = null; }
}

const _RF_OP_LABELS = { approved: '已认可', to_apply: '待应用', submitted: '已提交', pushed: '已推送', waiting_ci: '待 CI', verified: '已验证', blocked: '受阻' };
const _RF_OP_SEQ = ['approved', 'to_apply', 'submitted', 'pushed', 'waiting_ci', 'verified'];

/** 门禁日志核对结论 → 中文说明（与 AceHarness gate-log-analysis.mjs 的 verdict 一一对应）。 */
const _GATE_LOG_VERDICT_LABELS = {
  compile_error: '构建日志确认存在编译错误（确定性代码问题，不按抖动重试）',
  build_script_failure: '构建脚本/tbuild 失败，但无编译错误证据（根因未确认）',
  infra_failure: '失败落在基础设施阶段（节点/镜像/取码/设备）→ 平台问题',
  harness_env_failure: '跑测用例未执行到断言，失败在测试框架/环境准备阶段 → 平台/环境侧，非 PR 代码问题',
  test_assertion: '跑测报告确认真实断言/用例失败（确定性代码问题，不按抖动重试）',
  test_hang: '跑测报告为超时/卡死（根因未确认，需人工）',
  test_stage_unverified: '构建成功、跑测为异步任务，报告不可得 → 根因未验证',
  unknown: '日志未给出可归因结论 → 根因未验证',
};
function _gateLogVerdictLabel(verdict) {
  return _GATE_LOG_VERDICT_LABELS[String(verdict || '')] || `日志结论：${escHtml(String(verdict || '未知'))}`;
}

/**
 * 门禁根因（日志核对）+ 重试用尽维护提醒。普通"详情"与"检视修复"面板共用，保证措辞一致。
 * 只有 logPlatformVerified=true（后端已核实属门禁/平台侧）才敢说"不是 PR 代码问题"；
 * 其余（含根因未核实）一律只说"根因未核实，需维护人员协助排查"。
 */
function _gateDiagnosisHtml(gd) {
  if (!gd) return '';
  let html = '';
  if (gd.logVerdict) {
    const verifiedTag = gd.rootCauseVerified ? '已核实' : '未核实';
    const reasons = (gd.logReasons || []).map(r => `<div style="font-size:11px;margin:2px 0 0 8px">· ${escHtml(String(r).slice(0, 240))}</div>`).join('');
    const evidence = (gd.logEvidence || []).map(e => `<div style="color:var(--dim);font-size:11px;margin:2px 0 0 8px">· ${escHtml(String(e).slice(0, 240))}</div>`).join('');
    html += `<div class="pr-rf-result" style="margin:4px 0;border-left:3px solid ${gd.rootCauseVerified ? 'var(--accent)' : 'var(--dim)'};padding-left:8px">
      <div style="font-size:12px;font-weight:600">🔎 门禁根因（日志核对 · ${verifiedTag}）：${escHtml(_gateLogVerdictLabel(gd.logVerdict))}</div>
      ${reasons}${evidence}
    </div>`;
  }
  if (gd.needsMaintainer) {
    const header = gd.logPlatformVerified
      ? '⏳ 自动重试已用尽，日志核对确认是门禁/平台侧故障，不是本 PR 代码问题'
      : '⏳ 自动重试已用尽，门禁根因未核实，需维护人员协助排查';
    html += `<div class="pr-rf-result fail" style="margin:6px 0;border-left:3px solid #e6a23c;padding-left:8px">
      <div style="font-weight:600">${header}</div>
      <div style="font-size:12px;margin-top:2px">${escHtml(gd.maintainerHint || '请携带门禁报告链接联系门禁维护人员协助排查。')}</div>
      ${gd.reportUrl ? `<div style="font-size:11px;margin-top:2px"><a href="${escHtml(gd.reportUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">打开门禁报告（附给维护人员）↗</a></div>` : ''}
    </div>`;
  }
  return html;
}

/** 执行回执条：修复证据 + 操作链路 + 能力阻断（R01/R02/R05） */
function _rfExecutionStrip(d) {
  const parts = [];
  const ev = d.evidence;
  if (ev) {
    const bits = [`修复状态：<b>${escHtml(ev.fixStateLabel || ev.fixState || '未知')}</b>`];
    if (ev.baselineHeadSha) bits.push(`基线 <code>${escHtml(String(ev.baselineHeadSha).slice(0, 8))}</code>`);
    if (ev.currentHeadSha) bits.push(`当前 <code>${escHtml(String(ev.currentHeadSha).slice(0, 8))}</code>`);
    if (ev.hasNewCommitUnverified) bits.push('<span style="color:#d08700">有新提交，尚未验证是否修复</span>');
    parts.push(`<div style="font-size:11px;color:var(--dim)">${bits.join(' · ')}</div>`);
    if (ev.previousPush?.commitSha) {
      parts.push(`<div style="font-size:11px;color:var(--dim)">此前已推送 <code>${escHtml(String(ev.previousPush.commitSha).slice(0, 8))}</code>；本轮建议尚未推送</div>`);
    }
  }
  const ops = Array.isArray(d.operations) ? d.operations : [];
  if (ops.length) {
    const latest = ops[ops.length - 1];
    const cur = latest.state || 'to_apply';
    const chain = _RF_OP_SEQ.map(s => {
      const on = s === cur;
      return `<span style="padding:1px 6px;border-radius:8px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};color:${on ? 'var(--accent)' : 'var(--dim)'};font-size:10px">${escHtml(_RF_OP_LABELS[s] || s)}</span>`;
    }).join('<span style="color:var(--dim)">→</span>');
    const blocked = cur === 'blocked' || latest.status === 'failed';
    parts.push(`<div style="font-size:11px;margin-top:4px">操作：${chain}${blocked ? ` <span style="color:var(--err)">受阻${latest.error ? '：' + escHtml(String(latest.error).slice(0, 120)) : ''}</span>` : ''}</div>`);
    const shaBits = [];
    if (latest.commitSha) shaBits.push(`commit <code>${escHtml(String(latest.commitSha).slice(0, 10))}</code>`);
    if (latest.remoteHeadSha) shaBits.push(`远端 <code>${escHtml(String(latest.remoteHeadSha).slice(0, 10))}</code>`);
    if (latest.buildCredential) shaBits.push(`构建凭据 ${escHtml(String(latest.buildCredential).slice(0, 40))}`);
    if (shaBits.length) parts.push(`<div style="font-size:10px;color:var(--dim)">${shaBits.join(' · ')}</div>`);
  }
  const cap = d.capabilities;
  if (cap && cap.blocked && cap.blockedReason) {
    parts.push(`<div class="pr-rf-result fail" style="margin:4px 0;font-size:11px">⛔ ${escHtml(cap.blockedReason)}${cap.permissionDenied ? ' · 到「GitCode 令牌」更新权限后重试' : ''}</div>`);
  }
  const h = d.monitorHealth;
  if (h) {
    const hb = [];
    if (h.waitReason) hb.push(`等待原因：${escHtml(h.waitReason)}`);
    if (h.lastCheckedAt) hb.push(`最近检查 ${escHtml(new Date(h.lastCheckedAt).toLocaleString('zh-CN', { hour12: false }))}`);
    if (h.reconcileIntervalMs) hb.push(`每 ${Math.round(h.reconcileIntervalMs / 1000)} 秒补查`);
    if (h.stale) hb.push('<span style="color:#d08700">门禁快照已过期，不能代表当前构建结果</span>');
    if (h.monitoringPaused) hb.push('自动补查已暂停');
    if (h.queryUnavailable) hb.push('<span style="color:#d08700">查询暂不可用，显示最近状态</span>');
    if (hb.length) parts.push(`<div style="font-size:10px;color:var(--dim);margin-top:3px">监控：${hb.join(' · ')}</div>`);
  }
  if (!parts.length) return '';
  return `<div class="pr-rf-exec" style="padding:6px 0 2px;border-bottom:1px dashed var(--border);margin-bottom:6px">${parts.join('')}</div>`;
}

function _renderReviewFix(runId, d) {
  if (!d.hasReviewFix && !(d.gateIssues || []).length && !(d.pairs || []).length
      && !(d.siblingReview?.comments || []).length && !(d.operations || []).length && !d.evidence) {
    return `<div style="font-size:var(--font-size-xs);color:var(--dim);padding:8px 0">该任务没有 AI 检视意见数据（未走到检视环节，或检视无待处理意见）</div>`;
  }
  const aiComments = d.aiComments || d.comments || [];
  const siblingComments = d.siblingReview?.comments || [];
  const humanComments = d.humanComments || [];
  const noise = d.noiseFilteredCount || 0;
  const stale = d.staleCount ? ` <span style="color:var(--dim)">· ${d.staleCount} 条意见后有新 push（是否修复需确认）</span>` : '';

  /* patch 来源标注（后端三级来源：run / history / recovered；建议模式单独措辞） */
  const src = d.patch ? (d.patchSource || 'run') : '';
  const _rfDt = s => String(s || '').slice(0, 16).replace('T', ' ');
  let patchHead = '', patchNote = '';
  if (d.suggestionMode) {
    patchHead = `🔧 建议的修改（未推送 ${_rfPatchStats(d.patch)}）`;
    patchNote = `以下是 AI 按检视意见生成的建议修复${d.suggestion?.generatedAt ? `（${escHtml(_rfDt(d.suggestion.generatedAt))} 生成）` : ''}——<b>尚未推送到 PR</b>，在下方决策区选择应用 / 驳回 / 反馈`;
  } else if (src === 'history') {
    patchHead = `🔧 提交的修改（历史任务推送 ${_rfPatchStats(d.patch)}）`;
    patchNote = `本任务未推送修改；以下是该 PR 更早监控任务${d.patchRunId ? ` <code>${escHtml(String(d.patchRunId))}</code>` : ''}推送的修复${d.patchSavedAt ? `（${escHtml(_rfDt(d.patchSavedAt))} 持久化）` : ''}`;
  } else if (src === 'recovered') {
    patchHead = `🔧 提交的修改（从 GitCode 恢复 ${_rfPatchStats(d.patch)}）`;
    patchNote = '本任务与历史持久化中均无 fix.patch；以下为 AI 检视意见之后该 PR 收到的推送（从 GitCode 提交历史恢复，无法精确归属，不支持一键回退）';
  } else if (d.canRetryPush) {
    patchHead = `🔧 尚未推送的本次修改（${_rfPatchStats(d.patch)}）`;
    patchNote = '当前 PR head 仍是修复前版本；该 patch 尚未出现在 PR 上，可在确认 GitCode 写权限后重试提交';
  } else if (d.pushFailed) {
    patchHead = `🔧 推送失败的本次修改（${_rfPatchStats(d.patch)}）`;
    patchNote = `工作流推送结果：${escHtml(d.pushStatus || '失败')}。当前 PR head 或生命周期未通过自动重试校验；请先确认 GitCode 权限和最新 PR 状态`;
  } else if (d.pushSucceeded) {
    patchHead = `🔧 已推送的本次修改（${_rfPatchStats(d.patch)}）`;
    patchNote = '工作流步骤记录显示推送成功；请查看最新门禁状态';
  } else {
    patchHead = `🔧 本次任务生成的修改（fix.patch ${_rfPatchStats(d.patch)}）`;
  }

  /* 无 patch 正文但有恢复的提交清单时，至少展示提交记录（可跳转 GitCode） */
  const recoveredList = (!d.patch && Array.isArray(d.recoveredCommits) && d.recoveredCommits.length)
    ? d.recoveredCommits.map(c => `
        <div class="pr-rf-comment" style="margin:4px 0">
          <div class="pr-rf-c-head">
            <span class="pr-rf-badge cat">📦 ${escHtml(String(c.sha || '').slice(0, 10))}</span>
            <span style="font-size:10px;color:var(--dim)">${escHtml(_rfDt(c.date))}</span>
            <a href="${escHtml(c.htmlUrl || '')}" target="_blank" rel="noopener" style="color:var(--accent)">GitCode ↗</a>
          </div>
          <div class="pr-rf-c-title">${escHtml(String(c.subject || '').slice(0, 160))}</div>
        </div>`).join('')
    : '';

  const pairs = d.pairs || [];
  const hasPairs = pairs.length > 0;

  let html = `
    <div class="pr-rf-zone">`;
  html += _rfExecutionStrip(d);
  if (d.gateSummary?.failures?.length) {
    html += `<div class="pr-rf-result fail" style="margin:4px 0">门禁快照中的失败项：${d.gateSummary.failures.map(escHtml).join('、')}。${d.suggestionMode ? '当前检视建议尚未应用，不能据此认定门禁已修复。' : '请查看门禁报告确认原因。'}</div>`;
  }
  /* 门禁根因（日志核对）+ 重试用尽维护提醒：与普通详情共用同一渲染，措辞一致 */
  html += _gateDiagnosisHtml(d.gateSummary);

  const scopedCard = p => _rfPairCardHtml(runId, { ...p, pairId: `${runId}-${p.pairId}` });
  const gatePairs = pairs.filter(p => p.isGate);
  const reviewPairs = pairs.filter(p => !p.isGate && !p.isExtra);
  const extraPairs = pairs.filter(p => p.isExtra);
  if (gatePairs.length) {
    html += `<div class="pr-rf-sec">🛡️ 门禁问题与修复对照（${gatePairs.length} 条）</div>${gatePairs.map(scopedCard).join('')}`;
  }
  if (d.gateSummary?.reportUrl) html += `<a href="${escHtml(d.gateSummary.reportUrl)}" target="_blank" rel="noopener" style="color:var(--accent);font-size:11px">打开门禁报告 ↗</a>`;
  if (d.patch) html += `<div class="pr-rf-sec">${patchHead}</div><div style="font-size:11px;color:var(--dim)">${patchNote}</div>`;

  if (siblingComments.length) {
    html += `
      <div class="pr-rf-sec">🔗 兄弟 PR #${escHtml(d.siblingReview.prNumber || '?')} 的 AI 检视意见（${siblingComments.length} 条 · 来源意见，不是本 PR 评论）</div>
      <div class="pr-rf-comments">${siblingComments.map(c => _rfCommentHtml(c)).join('')}</div>`;
  }

  if (hasPairs) {
    if (reviewPairs.length) html += `<div class="pr-rf-sec">📋 AI 检视意见与${d.suggestionMode ? '建议' : ''}修复对照（${reviewPairs.length} 条）</div>${reviewPairs.map(scopedCard).join('')}`;
    if (extraPairs.length) html += `<div class="pr-rf-sec">🔧 附加修改（${extraPairs.length} 项）</div>${extraPairs.map(scopedCard).join('')}`;
  } else {
    /* ── 平铺模式（无 patch 或无配对数据时回退） ── */
    html += `
      <div class="pr-rf-sec">📋 AI 检视意见（${aiComments.length} 条 · 待处理 ${d.actionableCount ?? aiComments.length} 条${stale}）</div>
      ${aiComments.length
        ? `<div class="pr-rf-comments">${aiComments.map(c => _rfCommentHtml(c)).join('')}</div>`
        : `<div style="font-size:var(--font-size-xs);color:var(--dim);padding:6px 0 2px">没有 AI 检视意见${noise ? `（已过滤 ${noise} 条噪音）` : ''}</div>`}
      ${d.patch ? `
        <div class="pr-rf-sec" style="margin-top:12px">${patchHead}</div>
        ${patchNote ? `<div style="font-size:var(--font-size-xs);color:var(--dim);padding:2px 0 4px">${patchNote}</div>` : ''}
        <div class="pr-rf-diff">${_rfDiffHtml(d.patch)}</div>` : `
        <div class="pr-rf-sec" style="margin-top:12px">🔧 提交的修改${recoveredList ? '（提交清单从 GitCode 恢复）' : ''}</div>
        ${recoveredList ? recoveredList : (aiComments.some(c => c.stale)
          ? `<div class="pr-rf-result info" style="margin:4px 0">AI 意见发布后 PR 有新 push；当前代码是否修复需打开 PR 确认</div>`
          : `<div style="font-size:var(--font-size-xs);color:var(--dim);padding:6px 0">本任务没有修改提交</div>`)}`}
    `;
  }

  html += `
      ${humanComments.length ? `
        <div class="pr-rf-sec" style="margin-top:12px;display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none"
             onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'':'none';this.querySelector('.pr-rf-expander').textContent=this.nextElementSibling.style.display==='none'?'展开全文':'收起'">
          💬 人工行内评论（${humanComments.length} 条）
          <a class="pr-rf-expander" href="#" onclick="event.preventDefault()" style="margin-left:auto">展开</a>
        </div>
        <div style="display:none" class="pr-rf-comments">${humanComments.map(c => _rfHumanCommentHtml(c)).join('')}</div>` : ''}

      <div class="pr-rf-sec" style="margin-top:12px">⚖️ 整体决策 <span id="rf-decision-summary-${escHtml(runId)}" style="font-size:10px;font-weight:400;color:var(--dim);margin-left:8px"></span></div>
      <div id="pr-rf-decision-${escHtml(runId)}">${_rfDecisionAreaHtml(runId, d)}</div>
    </div>`;
  return html;
}

/* 逐条配对卡片：左意见 · 右修改 */
function _rfPairCardHtml(runId, p) {
  const c = p.comment;
  const isAI = c && (c.body || '').startsWith('【AI-Review】');
  const m = isAI ? /^【AI-Review】(?:【([^】]+)】)(?:【([^】]+)】)?(?:【[^】]*】)*\s*(.*)/.exec(c.body) : null;
  const sev = m ? (m[1] || '') : '';
  const cat = m ? (m[2] || '') : '';
  const title = m ? (m[1] || '') + ' · ' + (m[3] || '').split('\n')[0] : (c ? (c.body || '').split('\n')[0] : '');
  const sevCls = { '致命': 'fatal', '严重': 'major', '一般': 'minor', '建议': 'sugg', '提示': 'info' }[sev] || 'info';
  const loc = c?.path ? `${c.path}${c.line ? ':' + c.line : ''}` : 'PR 整体';
  const rawBody = c ? (c.body || '') : '';
  const shortBody = rawBody.length > 250 ? rawBody.slice(0, 250) + '…' : rawBody;
  const pairId = p.pairId;
  const isApproved = c?.approvedPatch === true;
  const isStale = !!c?.stale && !isApproved;
  const approvedBadge = isApproved ? '<span class="pr-rf-badge cat" title="原任务中已批准的补丁；推送和构建结果以上方执行凭据为准">已批准的修复</span>' : '';

  const commentSide = c ? `
    <div class="rf-pair-side rf-pair-comment">
      <div class="pr-rf-c-head">
        ${isAI ? `<span class="pr-rf-badge ${sevCls}">${escHtml(sev)}</span>${cat ? `<span class="pr-rf-badge cat">${escHtml(cat)}</span>` : ''}` : '<span class="pr-rf-badge cat">💬 人工</span>'}
        <span class="pr-rf-loc">${escHtml(loc)}</span>
        ${approvedBadge}
        ${isStale ? '<span class="pr-rf-badge stale-b" title="PR 在意见发布后有新提交，但未自动验证修复状态">↻ 后续有 push</span>' : ''}
        ${rawBody.length > 250 ? `<a class="pr-rf-expander" href="#" onclick="event.preventDefault();window._rfToggleComment(this)">展开</a>` : ''}
      </div>
      <div class="pr-rf-c-title">${escHtml(title.slice(0, 120))}</div>
      <div class="pr-rf-c-body" data-raw="${escHtml(rawBody)}">${escHtml(shortBody)}</div>
    </div>` : `
    <div class="rf-pair-side rf-pair-comment">
      <div class="pr-rf-c-head"><span class="pr-rf-badge cat">${p.gateIssues?.length ? '🛡️ 门禁问题' : '🔧 附加修改'}</span></div>
      <div class="pr-rf-c-title" style="color:var(--dim)">${p.gateIssues?.length ? '门禁报告及对应文件修改' : '此文件修改无对应检视意见'}</div>
      ${p.gateIssues?.length ? `<div style="font-size:11px;color:var(--text-aux);margin-top:6px">${p.gateIssues.map(issue => `
        <div style="margin:4px 0;padding-left:8px;border-left:2px solid var(--warn)">
          <b>${escHtml([issue.rule, issue.path && `${issue.path}${issue.line ? ':' + issue.line : ''}`].filter(Boolean).join(' · ') || '门禁问题')}</b>
          ${issue.message ? `<div>${escHtml(issue.message)}</div>` : ''}
        </div>`).join('')}</div>` : ''}
    </div>`;

  const diffNames = Array.isArray(p.diffFiles) && p.diffFiles.length
    ? p.diffFiles
    : (p.diffFile ? String(p.diffFile).split('\n').filter(Boolean) : []);
  const diffLabel = diffNames.map(name => name.split('/').pop()).filter(Boolean).join('、') || '修改';
  const diffSide = p.hasDiff ? `
    <div class="rf-pair-side rf-pair-diff">
      <div class="rf-pair-diff-file" title="${escHtml(diffNames.join('\n'))}">${escHtml(diffLabel)}</div>
      <div class="rf-pair-diff-scroll">${_rfDiffHtml(p.diff)}</div>
    </div>` : `
    <div class="rf-pair-side rf-pair-diff rf-pair-diff-empty">
      <div style="font-size:11px;color:var(--dim);padding:16px 0;text-align:center">${isStale ? '意见后有新 push，修复状态未验证' : p.gateRelated ? '此文件还有门禁问题，请查看上方门禁修复对照' : '本条未产生代码修改'}</div>
    </div>`;

  /* 逐条决策行：已修复→按钮置灰；未修复→可点击 + 输入框 */
  const decisionRow = c && !p.isExtra ? `
      <div class="rf-pair-decision" data-pair-id="${escHtml(pairId)}">
        ${isApproved
          ? '<span class="rf-pair-decision-result">已批准并交由当前任务执行；请查看推送与构建状态</span>'
          : isStale
          ? `<span class="rf-pair-decision-result">旧代码意见：后续有 push，未自动确认修复状态</span>
             <button class="rf-pair-btn approve" disabled title="此意见针对旧代码，当前状态需到 PR 核实">旧意见</button>`
          : `<span class="rf-pair-decision-label">此条决策：</span>
             <button class="rf-pair-btn approve" onclick="window._rfPairDecide('${escHtml(pairId)}','approve',this)">✅ 认可</button>
             <button class="rf-pair-btn reject" onclick="window._rfPairDecide('${escHtml(pairId)}','reject',this)">❌ 驳回</button>
             <button class="rf-pair-btn fix" onclick="window._rfPairToggleFeedback('${escHtml(pairId)}')">💬 补充建议</button>`}
      </div>
      ${!isStale && !isApproved ? `
      <div class="rf-pair-feedback" id="rf-pair-fb-${escHtml(pairId)}" style="display:none">
        <textarea id="rf-pair-fb-input-${escHtml(pairId)}" class="rf-pair-fb-input" rows="2"
          placeholder="对这条意见的修改建议（如：改用 result.error 而非仅记日志）"></textarea>
        <button class="rf-pair-btn fix rf-pair-fb-submit" onclick="window._rfPairSubmitFeedback('${escHtml(runId)}','${escHtml(pairId)}',${p.index})">🛠️ 按建议修改此条</button>
      </div>` : ''}` : '';

  return `
    <div class="rf-pair ${isStale ? 'stale' : ''}" id="rf-pair-${escHtml(pairId)}" data-run-id="${escHtml(runId)}">
      <div class="rf-pair-head">
        <span class="rf-pair-num">${p.index}</span>
        <span class="rf-pair-label">${c ? (isAI ? 'AI 检视' : '人工评论') : p.isGate ? '门禁修复' : '附加修改'}</span>
        ${approvedBadge}
        ${isStale ? '<span class="pr-rf-badge stale-b" title="PR 在意见发布后有新提交，但未自动验证修复状态">↻ 后续有 push</span>' : ''}
        ${p.isExtra ? '<span class="pr-rf-badge cat">无意见关联</span>' : ''}
      </div>
      <div class="rf-pair-body">${commentSide}${diffSide}</div>${decisionRow}
    </div>`;
}

/* 逐条决策状态存储：pairId → { decision: 'approve'|'reject', feedback?: string } */
let _rfPairDecisions = {};

/* 切换某条配对的补充建议输入框 */
window._rfPairToggleFeedback = function(pairId) {
  const el = document.getElementById(`rf-pair-fb-${pairId}`);
  if (!el) return;
  const visible = el.style.display !== 'none';
  el.style.display = visible ? 'none' : 'flex';
  if (!visible) {
    setTimeout(() => document.getElementById(`rf-pair-fb-input-${pairId}`)?.focus(), 100);
  }
};

/* 提交某条配对的修改建议（调后端 user_fix_feedback 指令通道） */
window._rfPairSubmitFeedback = async function(runId, pairId, pairIndex) {
  const input = document.getElementById(`rf-pair-fb-input-${pairId}`);
  const feedback = (input?.value || '').trim();
  if (feedback.length < 5) {
    if (input) {
      input.focus();
      input.style.borderColor = 'rgba(245,185,66,.6)';
      setTimeout(() => { input.style.borderColor = ''; }, 2000);
    }
    return;
  }

  // 找到该配对的评论摘要，拼进反馈指令
  const pairEl = document.getElementById(`rf-pair-${pairId}`);
  const commentTitle = pairEl?.querySelector('.pr-rf-c-title')?.textContent?.trim() || '';
  const fullFeedback = `针对检视意见 #${pairIndex}（${commentTitle.slice(0, 60)}）：${feedback}`;

  const btn = pairEl?.querySelector('.rf-pair-fb-submit');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 启动修改任务…'; }

  try {
    const r = await _prApi('POST',
      `/api/pr-review/runs/${encodeURIComponent(runId)}/review-fix/decision`,
      { decision: 'feedback', feedback: fullFeedback }, 90000);

    if (r.status === 200 && r.data?.success) {
      const row = pairEl?.querySelector('.rf-pair-decision');
      if (row) {
        row.innerHTML = `<span class="rf-pair-decision-result" style="color:#7fa8ff">🛠️ 已按建议启动修改——新任务 ${r.data.newRunId?.slice(0, 25) || ''}</span>`;
      }
      const fbRow = document.getElementById(`rf-pair-fb-${pairId}`);
      if (fbRow) fbRow.style.display = 'none';
    } else {
      if (btn) { btn.disabled = false; btn.textContent = '🛠️ 按建议修改此条'; }
      alert('修改失败：' + (r.data?.message || 'HTTP ' + r.status));
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '🛠️ 按建议修改此条'; }
    alert('修改失败：' + e.message);
  }
};

window._rfPairDecide = function(pairId, decision, btn) {
  const row = btn.closest('.rf-pair-decision');
  if (!row) return;
  const approveBtn = row.querySelector('.rf-pair-btn.approve');
  const rejectBtn = row.querySelector('.rf-pair-btn.reject');

  // toggle：再点一次取消
  if (_rfPairDecisions[pairId] === decision) {
    delete _rfPairDecisions[pairId];
    approveBtn?.classList.remove('selected');
    rejectBtn?.classList.remove('selected');
  } else {
    _rfPairDecisions[pairId] = decision;
    if (decision === 'approve') {
      approveBtn?.classList.add('selected');
      rejectBtn?.classList.remove('selected');
    } else {
      rejectBtn?.classList.add('selected');
      approveBtn?.classList.remove('selected');
    }
  }

  // 更新底部的整体决策摘要
  _rfUpdateDecisionSummary(row.closest('.rf-pair')?.dataset.runId);
};

/* 更新整体决策摘要（显示逐条决策进度） */
function _rfUpdateDecisionSummary(runId) {
  if (!runId) return;
  const values = Object.entries(_rfPairDecisions).filter(([key]) => key.startsWith(runId + '-')).map(([, value]) => value);
  const total = values.length;
  const approved = values.filter(v => v === 'approve').length;
  const rejected = values.filter(v => v === 'reject').length;
  const summary = document.getElementById(`rf-decision-summary-${runId}`);
  if (summary) {
    summary.innerHTML = `逐条决策进度：<b style="color:#5fd69b">${approved} 认可</b> · <b style="color:#ee8d8d">${rejected} 驳回</b> · ${total} 条已决策`;
  }
}

/* 决策区：PR 已合入/已关闭时显示终态说明（隐藏按钮，防点了才报错）；未检视时显示兄弟同步入口 */
function _rfDecisionAreaHtml(runId, d) {
  if (d.prState === 'merged') {
    return `<div class="pr-rf-result ok">✅ PR 已合入，无需继续提交修改</div>`;
  }
  if (d.prState === 'closed') {
    return `<div class="pr-rf-result warn">⛔ PR 已关闭（未合入）——无需决策；若在 GitCode 重新打开后可再开启监控</div>`;
  }
  if (d.canRetryApply) {
    return `
      <div class="pr-rf-result warn" style="margin-bottom:8px">
        上次应用任务 ${escHtml(d.failedApplyRunId || '')} 启动失败，修复 patch 尚未推送，且 PR head 仍与建议生成时一致。
        可以安全重试；重试前会再次校验 PR 状态和 head。
      </div>
      <div class="pr-rf-actions">
        <button class="pr-rf-btn approve" onclick="window._rfSubmitDecision('${escHtml(runId)}','apply')">🔁 重试应用建议修复（推送）</button>
      </div>`;
  }
  // 未被 AI 检视 + 无意见 → 显示兄弟同步提示
  if (d.canRetryPush) {
    const priorApproval = d.decision?.decision === 'approved'
      ? `<div class="pr-rf-result info" style="margin-bottom:8px">已记录认可（${escHtml(d.decision.byUser || '')}），但该操作没有推送 patch。</div>`
      : '';
    return `
      <div class="pr-rf-result warn" style="margin-bottom:8px">
        当前 PR head 仍与修复前版本一致，这份 patch 尚未推送。确认 GitCode 凭据有仓库写权限后，可以重新启动推送。
      </div>
      ${priorApproval}
      <div class="pr-rf-actions">
        <button class="pr-rf-btn approve" onclick="window._rfSubmitDecision('${escHtml(runId)}','apply')">✅ 认可并重试提交</button>
      </div>`;
  }
  if (d.pushFailed) {
    return `<div class="pr-rf-result warn" style="margin-bottom:8px">工作流记录显示推送失败（${escHtml(d.pushStatus || '未知原因')}）。PR 状态未通过自动重试校验；先查看步骤输出并确认 GitCode 写权限。</div>
      ${_rfDecisionHtml(runId, d.decision, d.patchSource)}`;
  }
  // 未被 AI 检视 + 无意见 → 显示兄弟同步提示
  if ((d.actionableCount || 0) === 0 && d.hasReviewFix && !(d.gateIssues || []).length) {
    const syncHtml = `
      <div class="pr-rf-result warn" style="margin-bottom:8px">
        当前没有待处理的 AI 检视意见；旧意见后的提交尚未逐条验证。如果同主题的其他分支已被检视并修复，
        本分支可能存在相同的未修复问题。
      </div>
      <div class="pr-rf-actions">
        <button class="pr-rf-btn fix" onclick="window._rfSyncSibling('${escHtml(runId)}')">🔄 从兄弟 PR 同步修复</button>
      </div>
      <div class="pr-rf-feedback-row">
        <textarea id="pr-rf-input-${escHtml(runId)}" class="pr-rf-input" rows="2"
          placeholder="如果你知道怎么改更好，写在这里，AI 会在服务器上按你的建议修改代码并推送"></textarea>
        <button class="pr-rf-btn fix" onclick="window._rfSubmitDecision('${escHtml(runId)}','feedback')">🛠️ 按我的建议修改</button>
      </div>`;
    return syncHtml;
  }
  // ── 建议模式：AI 检视意见的建议修复已生成但未推送，等用户决策（应用/驳回/反馈） ──
  if (d.suggestionMode && (!d.decision || d.decision.decision === 'approved')) {
    const drift = d.prHeadSha && d.suggestion?.headSha && d.prHeadSha !== d.suggestion.headSha;
    return `
      <div class="pr-rf-result info" style="margin-bottom:8px">
        💡 <b>建议模式</b>：以上修复是 AI 按检视意见生成的<b>建议</b>，尚未推送到你的 PR——
        确认有道理再应用；不同意就驳回（AI 不会再按这些意见改代码）。
        ${d.suggestion?.commentCount ? `共 ${d.suggestion.commentCount} 条意见。` : ''}
      </div>
      ${d.decision?.decision === 'approved' ? `<div class="pr-rf-result warn" style="margin-bottom:8px">✅ 已记录认可，但这一步没有启动提交；请点下方「认可并提交」完成应用。</div>` : ''}
      ${drift ? `<div class="pr-rf-result warn" style="margin-bottom:8px">⚠️ PR 在建议生成后又有新提交，建议可能不适用——建议用「按我的想法改」重新生成</div>` : ''}
      <div class="pr-rf-actions">
        <button class="pr-rf-btn approve" ${drift ? 'disabled style="opacity:.45;cursor:not-allowed" title="PR 有新提交，建议可能不适用"' : ''} onclick="window._rfSubmitDecision('${escHtml(runId)}','apply')">✅ ${d.decision?.decision === 'approved' ? '认可并提交' : '应用建议修复（推送）'}</button>
        <button class="pr-rf-btn revert" onclick="window._rfSubmitDecision('${escHtml(runId)}','dismiss')">❌ 驳回全部意见</button>
      </div>
      <div class="pr-rf-feedback-row">
        <textarea id="pr-rf-input-${escHtml(runId)}" class="pr-rf-input" rows="2"
          placeholder="部分意见不想采纳/想按你的想法改？写在这里（AI 会按你的指令重新修改并推送）"></textarea>
        <button class="pr-rf-btn fix" onclick="window._rfSubmitDecision('${escHtml(runId)}','feedback')">🛠️ 按我的想法改</button>
      </div>`;
  }
  return _rfDecisionHtml(runId, d.decision, d.patchSource);
}

/* 同步兄弟 PR 修复 */
window._rfSyncSibling = async function (runId) {
  if (!runId) return;
  if (!confirm('确定要同步兄弟 PR 的修复吗？\n\n系统将查找同主题已被 AI 检视的 PR，并将其修复应用到本分支。\n启动后新任务会自动完成修复并推送。')) return;
  const zone = document.getElementById(`pr-rf-decision-${runId}`);
  if (zone) {
    zone.innerHTML = '<div class="pr-rf-hint">⏳ 正在查找兄弟 PR 并启动同步任务…（约需 10-30 秒）</div>';
  }
  try {
    const r = await _prApi('POST', `/api/pr-review/runs/${encodeURIComponent(runId)}/sync-sibling-fix`, {}, 90000);
    if (r.status === 200 && r.data?.success) {
      zone.innerHTML = `<div class="pr-rf-result info">${escHtml(r.data?.message || '同步任务已启动')}</div>`;
      await _loadPrRuns(false);
    } else {
      zone.innerHTML = `<div class="error-msg" style="display:block">${escHtml(r.data?.message || '同步失败')}</div>
        <div style="margin-top:8px"><button class="pr-rf-btn fix" onclick="window._rfSyncSibling('${escHtml(runId)}')">重试</button></div>`;
    }
  } catch (e) {
    zone.innerHTML = `<div class="error-msg" style="display:block">同步失败：${escHtml(e.message)}</div>
      <div style="margin-top:8px"><button class="pr-rf-btn fix" onclick="window._rfSyncSibling('${escHtml(runId)}')">重试</button></div>`;
  }
};

/* 人工行内评论卡（简化渲染：无 AI 级别徽章，默认截断可展开） */
function _rfHumanCommentHtml(c) {
  const loc = c.path ? `${c.path}${c.line ? ':' + c.line : ''}` : 'PR 整体';
  const raw = c.body || '';
  const short = raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
  return `
    <div class="pr-rf-comment ${c.stale ? 'stale' : ''}">
      <div class="pr-rf-c-head">
        <span class="pr-rf-badge cat">💬 人工评论</span>
        <span class="pr-rf-loc" title="${escHtml(loc)}">${escHtml(loc)}</span>
        <span style="font-size:10px;color:var(--dim)">@${escHtml(c.author || '-')}</span>
        ${raw.length > 300 ? `<a class="pr-rf-expander" href="#" onclick="event.preventDefault();window._rfToggleComment(this)">展开全文</a>` : ''}
      </div>
      <div class="pr-rf-c-body" data-raw="${escHtml(raw)}" style="max-height:100px">${escHtml(short)}</div>
    </div>`;
}

/* 单条意见卡：解析【AI-Review】【级别】【类别】徽章，正文默认截断 */
function _rfCommentHtml(c) {
  const m = /^【AI-Review】(?:【([^】]+)】)(?:【([^】]+)】)?(?:【[^】]*】)*\s*(.*)/.exec(c.body || '');
  const isAI = !!m;
  const sev = isAI ? (m[1] || '') : '';
  const cat = isAI ? (m[2] || '') : '';
  const title = isAI ? (m[3] || '') : (c.body || '').split('\n')[0];
  const sevCls = { '致命': 'fatal', '严重': 'major', '一般': 'minor', '建议': 'sugg', '提示': 'info' }[sev] || 'info';
  const loc = c.path ? `${c.path}${c.line ? ':' + c.line : ''}` : 'PR 整体';
  const raw = c.body || '';
  const short = raw.length > 400 ? raw.slice(0, 400) + '…' : raw;
  // stale 只证明意见发布后 PR 有新 push，不能据此确认作者已修复。
  const staleBadge = c.stale
    ? '<span class="pr-rf-badge stale-b" title="该意见发布后 PR 收到过新 push，修复状态未自动验证">↻ 意见后有 push</span>'
    : '';
  return `
    <div class="pr-rf-comment ${c.stale ? 'stale' : ''}">
      <div class="pr-rf-c-head">
        ${isAI ? `<span class="pr-rf-badge ${sevCls}">${escHtml(sev)}</span><span class="pr-rf-badge cat">${escHtml(cat)}</span>` : '<span class="pr-rf-badge cat">💬 人工评论</span>'}
        <span class="pr-rf-loc" title="${escHtml(loc)}">${escHtml(loc)}</span>
        ${staleBadge}
        ${raw.length > 400 ? `<a class="pr-rf-expander" href="#" onclick="event.preventDefault();window._rfToggleComment(this)">展开全文</a>` : ''}
      </div>
      <div class="pr-rf-c-title">${escHtml(title.slice(0, 160))}</div>
      <div class="pr-rf-c-body" data-raw="${escHtml(raw)}">${escHtml(short)}</div>
    </div>`;
}

window._rfToggleComment = function (el) {
  const bodyEl = el.closest('.pr-rf-comment, .rf-pair-side').querySelector('.pr-rf-c-body');
  const raw = bodyEl.dataset.raw || '';
  const expanded = bodyEl.classList.toggle('expanded');
  bodyEl.textContent = expanded ? raw : (raw.length > 400 ? raw.slice(0, 400) + '…' : raw);
  el.textContent = expanded ? '收起' : '展开全文';
};

/* diff 统计：+N / -M */
function _rfPatchStats(patch) {
  const add = (patch.match(/^\+[^+]/gm) || []).length;
  const del = (patch.match(/^-[^-]/gm) || []).length;
  return `<span class="dstat-add">+${add}</span> <span class="dstat-del">-${del}</span>`;
}

/* unified diff → 分文件块渲染（红删绿增） */
function _rfDiffHtml(patch) {
  const lines = patch.split('\n');
  const files = [];
  let cur = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      cur = { name: line.replace(/^diff --git a\/\S+ b\//, ''), lines: [] };
      files.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (!files.length) return `<pre class="pr-rf-diff-pre">${escHtml(patch.slice(0, 3000))}</pre>`;

  return files.map((f, i) => {
    const body = f.lines.map(l => {
      if (l.startsWith('+++') || l.startsWith('---')) return `<div class="dl-meta">${escHtml(l)}</div>`;
      if (l.startsWith('@@')) return `<div class="dl-hunk">${escHtml(l)}</div>`;
      if (l.startsWith('+')) return `<div class="dl-add">${escHtml(l)}</div>`;
      if (l.startsWith('-')) return `<div class="dl-del">${escHtml(l)}</div>`;
      return `<div class="dl-ctx">${escHtml(l)}</div>`;
    }).join('');
    const add = f.lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    const del = f.lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
    return `
      <div class="dl-file">
        <div class="dl-file-head" onclick="this.parentNode.classList.toggle('collapsed')">
          <span class="dl-file-name" title="${escHtml(f.name)}">${escHtml(f.name)}</span>
          <span><span class="dstat-add">+${add}</span> <span class="dstat-del">-${del}</span> <span class="dl-caret">▾</span></span>
        </div>
        <div class="dl-file-body">${body}</div>
      </div>`;
  }).join('');
}

/* 决策条：待决策（三操作）/ 已认可 / 已回退 / 已按建议修改 / 决策产物
 * patchSource='recovered'（GitCode 恢复的修改）时禁用一键回退：无法精确归属，防止误回退作者本人提交 */
function _rfDecisionHtml(runId, decision, patchSource) {
  if (!decision) {
    const revertDisabled = patchSource === 'recovered';
    return `
      <div class="pr-rf-actions">
        <button class="pr-rf-btn approve" onclick="window._rfSubmitDecision('${escHtml(runId)}','approve')">✅ 仅记录认可</button>
        ${revertDisabled
          ? `<button class="pr-rf-btn revert" disabled style="opacity:.45;cursor:not-allowed" title="修改从 GitCode 提交历史恢复，无法精确归属到监控任务，不支持一键回退；如需回退请用「按我的建议修改」描述回退范围">↩️ 恢复原版</button>`
          : `<button class="pr-rf-btn revert" onclick="window._rfSubmitDecision('${escHtml(runId)}','revert')">↩️ 恢复原版</button>`}
      </div>
      <div class="pr-rf-feedback-row">
        <textarea id="pr-rf-input-${escHtml(runId)}" class="pr-rf-input" rows="2"
          placeholder="如果你知道怎么改更好，写在这里（例如：这里应该用 result.error 而不是只记日志），AI 会在服务器上按你的建议修改代码并推送"></textarea>
        <button class="pr-rf-btn fix" onclick="window._rfSubmitDecision('${escHtml(runId)}','feedback')">🛠️ 按我的建议修改</button>
      </div>`;
  }
  const dt = (decision.decidedAt || '').slice(0, 16).replace('T', ' ');
  const prefix = decision.spawnedByDecision ? '📌 本任务由你的决策操作产生 —— ' : '';
  if (decision.decision === 'approved') {
    return `<div class="pr-rf-result ok">${prefix}✅ 已记录认可（${escHtml(decision.byUser || '')} · ${escHtml(dt)}）——认可记录本身不会创建提交或推送</div>`;
  }
  if (decision.decision === 'applied') {
    return `<div class="pr-rf-result info">${prefix}⏳ 已启动修复推送任务（${escHtml(decision.byUser || '')} · ${escHtml(dt)}）：<code>${escHtml(decision.newRunId || '')}</code>。任务完成前不代表已经推送成功。</div>`;
  }
  if (decision.decision === 'dismissed') {
    return `<div class="pr-rf-result warn">${prefix}❌ 已驳回全部检视意见（${escHtml(decision.byUser || '')} · ${escHtml(dt)}）——${decision.commentPosted ? `已在 PR 留处理标记（${escHtml(decision.commentPostedAs || '')}），` : ''}监控已结束${decision.commentError ? `<div style="margin-top:4px;color:var(--err)">标记评论失败：${escHtml(decision.commentError)}</div>` : ''}</div>`;
  }
  if (decision.decision === 'reverted') {
    return `<div class="pr-rf-result warn">${prefix}↩️ 已启动回退任务（${escHtml(decision.byUser || '')} · ${escHtml(dt)}）——回退任务 <code>${escHtml(decision.newRunId || '')}</code> 正在执行，稍后刷新查看</div>`;
  }
  return `<div class="pr-rf-result info">${prefix}🛠️ 已按建议启动修改（${escHtml(decision.byUser || '')} · ${escHtml(dt)}）——新任务 <code>${escHtml(decision.newRunId || '')}</code>
    ${decision.feedback ? `<div class="pr-rf-fb-quote">建议：「${escHtml(decision.feedback)}」</div>` : ''}</div>`;
}

/* 提交决策 */
window._rfSubmitDecision = async function (runId, decision) {
  const zone = document.getElementById(`pr-rf-decision-${runId}`);
  if (!zone) return;
  if (zone._busy) return;

  let body = { decision };
  if (decision === 'feedback') {
    const input = document.getElementById(`pr-rf-input-${runId}`);
    body.feedback = (input?.value || '').trim();
    if (body.feedback.length < 5) {
      input?.focus();
      zone._hint?.remove();
      zone._hint = document.createElement('div');
      zone._hint.className = 'pr-rf-hint';
      zone._hint.textContent = '请先填写修改建议（至少 5 个字符）';
      zone.insertBefore(zone._hint, zone.firstChild);
      return;
    }
  }
  if (decision === 'revert' && !confirm('确定要恢复原版吗？\n\n将在你的 fork 上推送一个 revert 提交，撤销本次 AI 修复的全部改动。')) {
    return;
  }
  if (decision === 'apply' && !confirm('确定要提交这份修复吗？\n\n工作流会把上面展示的 patch 应用到 fork 并尝试推送。GitCode 凭据需要有仓库写权限；任务完成前不会视为推送成功。')) {
    return;
  }
  if (decision === 'dismiss' && !confirm('确定要驳回全部检视意见吗？\n\n驳回后 AI 不再按这些意见改代码；会在 PR 上留一条处理标记评论，本 PR 的监控结束。')) {
    return;
  }

  zone._busy = true;
  zone._hint?.remove();
  const btns = zone.querySelectorAll('button');
  btns.forEach(b => { b.disabled = true; b.style.opacity = '.5'; });
  const tip = document.createElement('div');
  tip.className = 'pr-rf-hint';
  tip.textContent = decision === 'approve' ? '记录认可中…'
    : decision === 'dismiss' ? '正在驳回并发布 PR 标记…'
    : decision === 'apply' ? '正在启动推送任务…（约需 10-30 秒）'
    : (decision === 'revert' ? '正在启动回退任务…（约需 10-30 秒）' : '正在启动修改任务…（约需 10-30 秒）');
  zone.insertBefore(tip, zone.firstChild);

  try {
    const r = await _prApi('POST', `/api/pr-review/runs/${encodeURIComponent(runId)}/review-fix/decision`, body, 90000);
    if (r.status !== 200 || !r.data?.success) {
      tip.textContent = '❌ ' + (r.data?.message || '操作失败，请重试');
      btns.forEach(b => { b.disabled = false; b.style.opacity = ''; });
      zone._busy = false;
      return;
    }
    // 成功：重渲染决策条 + 更新缓存里的 decision（避免自动刷新覆盖）
    const box = document.getElementById(`pr-reviewfix-${runId}`);
    if (box?._data) {
      box._data.decision = r.data.decision;
      // 认可只是记录，不会推送；如果该 run 仍有可应用的 patch，要保留「认可并提交」入口。
      if (decision === 'approve') {
        zone.innerHTML = _rfDecisionAreaHtml(runId, box._data);
        zone._busy = false;
        return;
      }
    }
    zone.innerHTML = _rfDecisionHtml(runId, r.data.decision)
      + (r.data.message ? `<div class="pr-rf-hint">${escHtml(r.data.message)}</div>` : '');
  } catch (e) {
    tip.textContent = '❌ 操作失败：' + e.message;
    btns.forEach(b => { b.disabled = false; b.style.opacity = ''; });
    zone._busy = false;
  }
};

/* ── Markdown 安全渲染（内置，零依赖：先全文转义再构建标签，天然防 XSS） ── */

/**
 * 兜底检查：属性值内不得出现标签字符（'<' 或 '>'）。
 * 本渲染器生成的双引号只作属性定界符（文本内容的引号已被 escHtml 转成实体），
 * 因此"双引号区间内出现 < 或 >"即说明有片段被展开进了属性槽——属注入前兆，判定不安全。
 */
function _mdHasAngleInsideAttr(html) {
  let inDq = false;
  for (const c of html) {
    if (c === '"') inDq = !inDq;
    else if (inDq && (c === '<' || c === '>')) return true;
  }
  return false;
}

function _renderMarkdownSafe(text) {
  // B01：NUL 会破坏占位符机制，先剔除（Markdown 文本本就不允许 NUL）
  const esc = escHtml(String(text == null ? '' : text).replace(/\x00/g, ''));
  const lines = esc.split('\n');
  const out = [];
  let inCode = false, codeBuf = [];
  let listType = null;   // 'ul' | 'ol'
  let tableBuf = [];

  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.filter(r => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r) || /[^\s:|-]/.test(r.replace(/[|\s:|-]/g, '')));
    const parsed = tableBuf.filter(r => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r)).map(r =>
      r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim()));
    if (parsed.length >= 2) {
      const [head, ...body] = parsed;
      out.push('<table class="md-table"><thead><tr>' + head.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'
        + body.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
    } else if (parsed.length === 1) {
      out.push('<table class="md-table"><tbody><tr>' + parsed[0].map(c => `<td>${c}</td>`).join('') + '</tr></tbody></table>');
    }
    tableBuf = [];
  };
  // 行内格式（在已转义文本上）：行内代码、图片（仅 http/https）、链接（仅 http/https）、粗体、斜体。
  // E03：与服务端 Server/issueAnalysis/markdownSafe.js 同一算法（后端报告与前端内嵌预览表现必须一致）：
  //   1) 每生成一段标签立刻用 NUL 占位符保护，后续正则只在"纯文本+占位符"上运行，绝不重扫已生成 HTML；
  //   2) 占位片段只允许出现在文本上下文——href/src 只接受真实 URL，URL 含占位片段则整个构造不渲染（按纯文本保留）；
  //   3) 图片 alt 走纯文本槽展开并按属性上下文编码，不引入标签字符；
  //   4) 收尾用 _mdHasAngleInsideAttr 兜底，属性值内出现标签字符即整篇降级为全转义纯文本。
  // 说明：仅渲染 http(s) 图片；需鉴权的相对产物链接（如 work/xxx.png）不在此渲染，
  //      由"证据与产物"面板统一走 artifacts 接口（图片/下载），避免把 token 拼进 Markdown 图片地址。
  const escAttr = (v) => String(v).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inlineDeep = (s, depth) => {
    if (depth > 6) return s;
    const stash = [];
    const stashText = [];
    const mark = (html, text) => {
      const i = stash.push(html) - 1;
      stashText.push(text == null ? '' : String(text));
      return `\x00${depth}:${i}\x00`;
    };
    const marker = new RegExp(`\\x00${depth}:(\\d+)\\x00`, 'g');
    const hasMarker = new RegExp(`\\x00${depth}:\\d+\\x00`);
    const expandText = (v) => String(v).replace(marker, (_, ix) => stashText[Number(ix)] ?? '');
    const out = s
      .replace(/`([^`]+)`/g, (_, code) => mark(`<code class="md-code">${code}</code>`, code))
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (m, alt, url) => (url.includes('\x00')
        ? m
        : mark(`<img class="md-img" src="${escAttr(url)}" alt="${escAttr(expandText(alt))}" loading="lazy"/>`, expandText(alt))))
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, text, url) => (url.includes('\x00')
        ? m
        : mark(`<a href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">${inlineDeep(text, depth + 1)}</a>`, expandText(text))))
      .replace(/\*\*([^*]+)\*\*/g, (_, bold) => mark(`<b>${inlineDeep(bold, depth + 1)}</b>`, expandText(bold)))
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, prefix, em) => prefix + mark(`<i>${inlineDeep(em, depth + 1)}</i>`, expandText(em)));
    // 迭代展开本层占位符（嵌套片段含内层占位符）；深度上界防环，残留占位符一律剔除
    let expanded = out;
    for (let i = 0; i < 20 && hasMarker.test(expanded); i++) {
      expanded = expanded.replace(marker, (_, ix) => stash[Number(ix)] ?? '');
    }
    return expanded.replace(marker, '');
  };
  const inline = (s) => inlineDeep(s, 0);

  for (const raw of lines) {
    const line = raw;
    // 代码块围栏
    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push(`<pre class="md-pre"><code>${codeBuf.join('\n')}</code></pre>`);
        codeBuf = []; inCode = false;
      } else {
        flushTable(); closeList(); inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    // 表格行
    if (/^\s*\|.*\|\s*$/.test(line)) { closeList(); tableBuf.push(line); continue; }
    flushTable();

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length} class="md-h md-h${h[1].length}">${inline(h[2])}</h${h[1].length}>`); continue; }

    // 分割线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { closeList(); out.push('<hr class="md-hr"/>'); continue; }

    // 引用
    const q = line.match(/^\s*&gt;\s?(.*)$/);
    if (q) { closeList(); out.push(`<blockquote class="md-quote">${inline(q[1])}</blockquote>`); continue; }

    // 无序/有序列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) { closeList(); listType = want; out.push(`<${want} class="md-list">`); }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();

    // 空行
    if (!line.trim()) { continue; }

    // 普通段落
    out.push(`<p class="md-p">${inline(line)}</p>`);
  }
  if (inCode) out.push(`<pre class="md-pre"><code>${codeBuf.join('\n')}</code></pre>`);
  flushTable(); closeList();
  const html = out.join('\n');
  // E03/D01 兜底：属性值内出现标签字符说明占位片段被展开了进属性槽（注入前兆）。
  // 回到全转义纯文本——内容不丢，但不渲染任何标记，绝不放行可疑输出。
  if (_mdHasAngleInsideAttr(html)) return `<p class="md-p">${esc.replace(/\n/g, '<br>')}</p>`;
  return html;
}

/* ── 单个输出文件内容查看 ── */

async function showPrOutputContent(runId, fileIdx, isRestore = false) {
  const box = document.getElementById(`pr-outputs-${runId}`);
  const contentBox = document.getElementById(`pr-output-content-${runId}`);
  if (!box || !contentBox) return;
  const f = (box._files || [])[fileIdx];
  if (!f) return;

  // 自动刷新恢复：查看器已展示同一文件且内容就绪 → 完全不动（不重拉、不闪"加载中"、不丢滚动位置）
  if (isRestore && contentBox.style.display === 'block' && contentBox._currentIdx === fileIdx && contentBox._content) return;

  // 切换高亮 + 收起逻辑（恢复模式下直接展示）；高亮按 data-idx 匹配，与分组后的 DOM 顺序解耦
  const chips = box.querySelectorAll('.pr-file-chip');
  if (!isRestore && contentBox.style.display === 'block' && contentBox._currentIdx === fileIdx) {
    contentBox.style.display = 'none';
    contentBox._currentIdx = -1;
    delete _prViewingFile[runId];
    chips.forEach(c => c.classList.remove('current'));
    return;
  }
  chips.forEach(c => c.classList.toggle('current', Number(c.dataset.idx) === fileIdx));

  contentBox._currentIdx = fileIdx;
  _prViewingFile[runId] = fileIdx;
  contentBox.style.display = 'block';
  const name = f.stepName || f.filename || '未命名';
  contentBox.innerHTML = `<div style="font-size:var(--font-size-xs);color:var(--dim);padding:6px 0">加载「${escHtml(name)}」内容中…</div>`;

  try {
    const ref = encodeURIComponent(f.outputRef || f.filename || f.stepName || '');
    const r = await _prApi('GET', `/api/pr-review/runs/${encodeURIComponent(runId)}/outputs/${ref}`, null, 30000);
    if (r.status !== 200 || !r.data?.success) {
      contentBox.innerHTML = `<div class="error-msg" style="display:block">${escHtml(r.data?.message || '内容加载失败')}</div>`;
      return;
    }
    const content = r.data.content || '（空内容）';
    const truncated = content.length > 100000
      ? content.slice(0, 100000) + '\n\n…（内容过长已截断，完整内容请到 AceHarness 工作台查看）' : content;
    contentBox._content = content;
    contentBox._mdFile = /\.md$/i.test(f.filename || '') || /\.md$/i.test(name);
    contentBox.innerHTML = `
      <div class="pr-out-viewer">
        <div class="pr-out-viewer-head">
          <span class="ov-name" title="${escHtml(name)}">📄 ${escHtml(name)}</span>
          ${contentBox._mdFile ? `<button class="pr-act md-toggle" style="padding:3px 12px" onclick="window._prToggleMdView('${escHtml(runId)}')" title="切换 Markdown 可视化 / 原始文本"><span class="md-toggle-label"></span></button>` : ''}
          <button class="pr-act" style="padding:3px 12px" onclick="_copyPrOutput('${escHtml(runId)}')">📋 复制</button>
        </div>
        <div class="ov-body"></div>
      </div>`;
    window._prApplyMdView(contentBox);
    contentBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    contentBox.innerHTML = `<div class="error-msg" style="display:block">内容加载失败：${escHtml(e.message)}</div>`;
  }
}

/* Markdown 可视化开关（.md 文件）：渲染/原文切换，状态全局记忆 */
let _prMdRenderOn = localStorage.getItem('cpf-md-render') !== '0';   // 默认可视化

window._prApplyMdView = function (contentBox) {
  const body = contentBox.querySelector('.ov-body');
  const btn = contentBox.querySelector('.md-toggle-label');
  if (!body) return;
  if (_prMdRenderOn) {
    body.innerHTML = `<div class="md-body">${_renderMarkdownSafe(contentBox._content || '')}</div>`;
    if (btn) btn.textContent = '👁 可视化';
    contentBox.querySelector('.md-toggle')?.classList.add('active');
  } else {
    body.innerHTML = `<pre>${escHtml(contentBox._content || '')}</pre>`;
    if (btn) btn.textContent = '📄 原文';
    contentBox.querySelector('.md-toggle')?.classList.remove('active');
  }
};

window._prToggleMdView = function (runId) {
  _prMdRenderOn = !_prMdRenderOn;
  localStorage.setItem('cpf-md-render', _prMdRenderOn ? '1' : '0');
  const contentBox = document.getElementById(`pr-output-content-${runId}`);
  if (contentBox) window._prApplyMdView(contentBox);
};

/* 复制到剪贴板：非安全上下文（http 局域网访问）navigator.clipboard 不可用，降级 execCommand */
function _prCopyText(text, what) {
  if (!text) return;
  const done = () => { const t = $('pr-copy-toast'); if (t) { t.textContent = `已复制${what || ''}`; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1500); } };
  const fail = () => alert(`复制失败（浏览器限制），请手动选择${what || '内容'}复制`);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, fail);
    return;
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    ok ? done() : fail();
  } catch { fail(); }
}

function _copyPrOutput(runId) {
  const contentBox = document.getElementById(`pr-output-content-${runId}`);
  if (!contentBox?._content) return;
  _prCopyText(contentBox._content, '输出内容');
}

function _copyPrRunId(runId) {
  if (!runId) return;
  _prCopyText(runId, 'Run ID');
}

/* ── 自动刷新 ── */

function _startPrAutoRefresh() {
  _stopPrAutoRefresh();
  // 每 2s 更新"xx秒前刷新"提示与进行中任务的时长
  _prRefreshTimer = setInterval(async () => {
    _updatePrLivePill();
    // 每 5 个 tick（10s）真正拉取一次列表
    if (!getAuth()) { _stopPrAutoRefresh(); return; }
    _prTickCount = (_prTickCount || 0) + 1;
    _prOvAutoRefreshTicks++;
    if (_prOvAutoRefreshTicks >= 15) {
      _prOvAutoRefreshTicks = 0;
      loadGitcodePrs(); // PR 仓库扫描在后端分批执行，30s 刷新一次列表展示新完成的仓库
    }
    if (_prTickCount >= 5) {
      _prTickCount = 0;
      const openSnapshot = [..._prOpenSet];
      await _loadPrRuns(false);
      // 展开中的卡片刷新详情
      for (const runId of openSnapshot) {
        if (_prOpenSet.has(runId)) _loadPrRunDetail(runId);
      }
    } else {
      // 轻量刷新：仅更新时长显示
      _refreshDurations();
    }
  }, 2000);
}

function _refreshDurations() {
  for (const [runId, run] of Object.entries(_prRunCache)) {
    if (PR_TERMINAL.has(run.status)) continue;
    const card = document.getElementById(`pr-card-${runId}`);
    if (!card) continue;
    const durEl = card.querySelector('.pr-meta-row .pr-m:nth-child(2)');
    if (durEl) durEl.textContent = `⏱ ${_fmtPrDuration(run.startTime, run.endTime)}`;
  }
}

function _stopPrAutoRefresh() {
  if (_prRefreshTimer) { clearInterval(_prRefreshTimer); _prRefreshTimer = null; }
  _prTickCount = 0;
  _prOvAutoRefreshTicks = 0;
}

let _prTickCount = 0;

/* ── 错误提示 ── */
function _showPrErr(msg) {
  const el = $('pr-error');
  el.style.display = 'block';
  el.innerHTML = `${escHtml(msg)} · <a href="#" style="color:var(--accent);font-weight:700" onclick="event.preventDefault();manualRefreshPr()">点击重试</a>`;
}

function _hidePrErr() {
  const el = $('pr-error');
  if (el) el.style.display = 'none';
}
