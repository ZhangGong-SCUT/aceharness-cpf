/* ── Issue 分析模块（AceHarness 代理模式） ── */

let _iaCounter = 0;
const _iaTasks = {}; // idx -> { taskId, runId, dirName, issueUrl, timer, pollTimer, startTime, stage, priorityLevel, summary }

const _IA_STAGE_LABELS = {
  issueanalysis_pending:   '等待中',
  issueanalysis_fetching:  '准备中…',
  issueanalysis_analyzing: '分析中…',
  issueanalysis_complete:  '分析完成 ✓',
  failed:                  '分析失败',
  cancelled:               '已停止',
};

/* ── 使用说明折叠面板 ── */
function toggleIaHelp() {
  const panel = document.getElementById('ia-help-panel');
  const btn = document.getElementById('ia-help-btn');
  if (!panel) return;
  const show = panel.style.display === 'none';
  panel.style.display = show ? '' : 'none';
  if (btn) btn.classList.toggle('active', show);
}

const _IA_STAGE_ICONS = {
  issueanalysis_pending:   '⏳',
  issueanalysis_fetching:  '🔄',
  issueanalysis_analyzing: '🔍',
  issueanalysis_complete:  '✅',
  failed:                  '❌',
  cancelled:               '⏹️',
};

const _IA_PRIORITY_LABELS = {
  low:      { label: '低',   color: '#6a737d', bg: 'rgba(106,115,125,.15)' },
  medium:   { label: '中',   color: '#d19a66', bg: 'rgba(209,154,102,.15)' },
  high:     { label: '高',   color: '#e06c75', bg: 'rgba(224,108,117,.15)' },
  critical: { label: '紧急', color: '#fff',    bg: '#e06c75' },
};

let _iaPager = null;
let _iaUrlCheckTimer = null;
let _iaLastAuthUser = null;   // 上次加载列表时的登录用户（检测登录态变化后自动刷新）

/* ── 身份隔离辅助 ──
 * 直链（<img> / <a download> / 新标签页打开报告）无法携带 Authorization 头，
 * 后端支持 ?token= 查询参数鉴权，这里统一拼接 */
function _iaTokenQ(sep = '&') {
  const t = (typeof getAuth === 'function' ? getAuth()?.token : null) || '';
  return `${sep}token=${encodeURIComponent(t)}`;
}

/* 未登录时列表区的提示文案（空状态元素在列表容器内，会被分页清空，需重建） */
function _iaShowLoginHint() {
  const list = $('ia-tasks-list');
  const count = $('ia-task-count');
  if (list) {
    list.innerHTML = '<div id="ia-tasks-empty" class="empty-hint">🔒 <a href="login.html" style="color:var(--accent)">登录</a> 后可查看你提交的 Issue 分析任务</div>';
  }
  if (count) count.textContent = '0 个任务';
}

/* Q04：按 taskId 登记当前唯一的轮询观察者。
 * 分页器翻页时会重建任务卡片（同一 taskId 产生新 idx/新对象），
 * 旧卡片的轮询若不注销，会在后台继续发请求并累计观察者。 */
let _iaPollers = new Map();   // taskId -> idx

/* Q04/B04/C03：释放由分页器创建的任务卡片对象及其轮询。
 * 分页器每次加载都是整页重建（列表容器先清空再 renderPage），
 * 因此重建前释放全部 _fromPager 对象——这样同页重复加载也不会残留
 * 同 taskId 的旧对象、再由后续渲染按新 idx 累加。
 * 用户刚提交产生的卡片（无 _fromPager 标记）不在此列，需保留。 */
function _iaReleasePagerTasks() {
  for (const k of Object.keys(_iaTasks)) {
    const t = _iaTasks[k];
    if (t?._fromPager) {
      _stopIaPolling(Number(k));
      delete _iaTasks[k];
    }
  }
}

/* 登录态变化时清理本地任务卡片与轮询定时器 */
function _iaResetLocalTasks() {
  for (const k of Object.keys(_iaTasks)) {
    const t = _iaTasks[k];
    if (t?.timer) clearTimeout(t.timer);
    _stopIaPolling(k);
    delete _iaTasks[k];
  }
  _iaPollers.clear();
  _iaCounter = 0;
}

/* ── URL 实时校验 ── */
function _setupIaUrlCheck() {
  const input = $('ia-issue-url');
  const hint = $('ia-url-hint');
  if (!input || !hint) return;

  input.addEventListener('input', () => {
    clearTimeout(_iaUrlCheckTimer);
    const url = input.value.trim();
    if (!url) {
      hint.textContent = '';
      hint.style.color = 'var(--dim)';
      return;
    }
    _iaUrlCheckTimer = setTimeout(async () => {
      try {
        const r = await apiFetch('POST', '/api/issue-analysis/validate', { issueUrl: url }, 5000);
        if (r.data?.valid) {
          const { platform, owner, repo, issueNumber } = r.data;
          hint.textContent = `✓ ${platform} / ${owner}/${repo} #${issueNumber}`;
          hint.style.color = 'var(--ok)';
        } else {
          hint.textContent = `✗ ${r.data?.message || 'URL 格式无效'}`;
          hint.style.color = 'var(--err)';
        }
      } catch (e) {
        hint.textContent = `✗ 校验失败: ${e.message}`;
        hint.style.color = 'var(--err)';
      }
    }, 400);
  });
}

/* ── 页面加载时恢复历史任务（身份隔离：仅本人任务，admin 全量） ── */
async function initIssueAnalysisHistory() {
  const auth = (typeof getAuth === 'function') ? getAuth() : null;
  _iaLastAuthUser = auth?.user?.username || null;
  if (!auth?.user) {
    _iaResetLocalTasks();
    _iaShowLoginHint();
    return;
  }

  _iaPager = createPagination({
    apiPath: '/api/issue-analysis',
    listContainerId: 'ia-tasks-list',
    emptyId: 'ia-tasks-empty',
    countId: 'ia-task-count',
    pagerId: 'ia-pager',
    pageSize: 20,
    renderPage: (tasks, isFirstPage) => {
      // Q04/B04/C03：整页重建前释放全部分页器创建的对象（含已完成任务）与其轮询；
      // 分页器已清空列表容器，保留旧对象只会造成同 taskId 按新 idx 重复累积。
      _iaReleasePagerTasks();
      const sorted = [...tasks].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      for (const t of sorted) {
        const idx = ++_iaCounter;
        _iaTasks[idx] = {
          // B04：标记为分页器创建的卡片——翻页清扫时只清这类对象，
          // 用户刚提交产生的新卡片（未在分页数据里）保留。
          _fromPager: true,
          taskId: t.taskId,
          runId: t.runId,
          dirName: t.dirName,
          issueUrl: t.issueUrl,
          stage: t.stage,
          priorityLevel: t.priorityLevel || null,
          summary: t.summary || null,
          workbenchUrl: t.workbenchUrl || null,
          parentTaskId: t.parentTaskId || null,
          userFeedback: t.userFeedback || null,
          startTime: t.startedAt ? new Date(t.startedAt).getTime() : new Date(t.createdAt).getTime(),
          startedAt: t.startedAt || null,
          finishedAt: t.finishedAt || null,
          timer: null,
          pollTimer: null,
        };
        _createIaCard(idx, t, true);
        _updateIaStage(idx, t.stage, t);

        const incompleteStages = ['issueanalysis_pending', 'issueanalysis_fetching', 'issueanalysis_analyzing'];
        if (incompleteStages.includes(t.stage)) {
          _startIaPolling(idx);
        }
      }
    },
  });
  await _iaPager.load(1);
  _setupIaUrlCheck();
}

/* 面板切换时复检登录态：登录/退出后无需刷新页面即可刷新列表（退出时清理卡片与轮询） */
window.addEventListener('panelswitch', (e) => {
  if (e.detail?.panelId !== 'p-issueanalysis') return;
  const cur = (typeof getAuth === 'function') ? (getAuth()?.user?.username || null) : null;
  if (cur !== _iaLastAuthUser) initIssueAnalysisHistory();
});

/* ── 提交 Issue 分析（需登录，任务归属提交人） ── */
async function doIssueAnalysis() {
  if (!(typeof getAuth === 'function' && getAuth()?.user)) {
    _showIaErr('请先 <a href="login.html" style="color:var(--accent)">登录</a> 后再提交 Issue 分析', true);
    return;
  }

  const issueUrl = $('ia-issue-url').value.trim();
  const accessToken = $('ia-access-token').value.trim();
  const priority = $('ia-priority').value;
  const issueType = $('ia-issue-type').value;

  if (!issueUrl) { _showIaErr('Issue URL 不能为空'); return; }

  const btn = $('ia-submit-btn');
  btn.disabled = true;
  btn.textContent = '提交中…';
  $('ia-error').style.display = 'none';

  try {
    const body = { issueUrl };
    if (accessToken) body.accessToken = accessToken;
    if (priority) body.priority = priority;
    if (issueType) body.issueType = issueType;

    const r = await authApi('POST', '/api/issue-analysis', body, 60000);
    if (r.status !== 202 || !r.data?.taskId) {
      _showIaErr(r.data?.message || `HTTP ${r.status}`);
      btn.disabled = false; btn.textContent = '▶ 开始分析';
      return;
    }

    const idx = ++_iaCounter;
    const taskId = r.data.taskId;
    const runId = r.data.runId;
    const dirName = r.data.dirName;

    _iaTasks[idx] = {
      taskId, runId, dirName, issueUrl,
      stage: 'issueanalysis_pending',
      priorityLevel: priority || null,
      summary: null,
      workbenchUrl: r.data.workbenchUrl || null,
      startTime: Date.now(),
      createdAt: new Date().toISOString(),
      timer: null,
      pollTimer: null,
    };

    _createIaCard(idx, {
      taskId, runId, dirName, issueUrl,
      stage: 'issueanalysis_pending',
      workbenchUrl: r.data.workbenchUrl || null,
      createdAt: new Date().toISOString(),
    }, false);
    _startIaPolling(idx);

    // 清空输入
    $('ia-issue-url').value = '';
    $('ia-url-hint').textContent = '';

    btn.disabled = false;
    btn.textContent = '▶ 开始分析';
  } catch (e) {
    _showIaErr(e.message);
    btn.disabled = false; btn.textContent = '▶ 开始分析';
  }
}

/* ── 格式化时间 ── */
function _formatIaTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/* ── 从 Issue URL 提取短标识：owner/repo#编号 ── */
function _formatIaIssueShort(issueUrl) {
  if (!issueUrl) return '';
  const m = issueUrl.match(/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : issueUrl.replace(/^https?:\/\//, '').slice(0, 40);
}

/* ── 创建任务卡片 ── */
function _createIaCard(idx, t, isHistory) {
  const emptyEl = $('ia-tasks-empty');
  if (emptyEl) emptyEl.style.display = 'none';
  const countEl = $('ia-task-count');
  if (countEl) countEl.textContent = `${Object.keys(_iaTasks).length} 个任务`;

  const timeLabel = _formatIaTime(t.createdAt);
  const stageLabel = _IA_STAGE_LABELS[t.stage] || t.stage || '等待中';
  const stageClass = `s-${t.stage || 'issueanalysis_pending'}`;

  // 从 issueUrl 提取 owner/repo#编号 短标识（头部不展开也可见）
  const issueShort = _formatIaIssueShort(t.issueUrl);

  // 状态呼吸点（对齐 PR 监控卡片视觉）
  const dotCls = t.stage === 'issueanalysis_complete' ? 'd-completed'
    : (t.stage === 'failed' ? 'd-failed' : (t.stage === 'cancelled' ? 'd-stopped' : 'd-running'));

  const card = document.createElement('div');
  card.className = `task-card ia-card stage-${t.stage || 'pending'}`;
  card.id = `ia-card-${idx}`;
  card.innerHTML = `
    <div class="task-card-header" onclick="toggleIaCard(${idx})">
      <span class="tc-chevron">▶</span>
      <span class="pr-dot ${dotCls}"></span>
      <span class="tc-lib" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${escHtml(t.dirName || t.taskId)}</span>
      ${issueShort ? `<a href="${escHtml(t.issueUrl || '#')}" target="_blank" rel="noopener noreferrer" title="${escHtml(t.issueUrl)}"
         style="font-size:var(--font-size-xs);color:var(--text-aux);background:rgba(255,255,255,.05);border:1px solid var(--border);padding:2px 8px;border-radius:10px;text-decoration:none;cursor:pointer;white-space:nowrap;flex-shrink:0;font-family:var(--mono)"
         onclick="event.stopPropagation()">🐛 ${escHtml(issueShort)}</a>` : ''}
      <code id="ia-${idx}-runid-head" title="点击复制 AceHarness Run ID" style="font-family:var(--mono);font-size:var(--font-size-xs);color:var(--accent);background:rgba(77,140,247,.08);border:1px solid rgba(77,140,247,.22);padding:2px 8px;border-radius:10px;cursor:pointer;user-select:all;white-space:nowrap;flex-shrink:0" onclick="copyIaRunId(${idx})">${escHtml(t.runId || 'runId 待分配')}</code>
      <span class="tc-spacer"></span>
      <a id="ia-${idx}-workbench-link" href="${escHtml(t.workbenchUrl || '#')}" target="_blank" rel="noopener noreferrer"
         style="display:none;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;
                font-size:var(--font-size-xs);font-weight:600;background:rgba(168,85,247,.1);color:#a855f7;
                border:1px solid rgba(168,85,247,.3);text-decoration:none;cursor:pointer;white-space:nowrap;flex-shrink:0"
         onclick="event.stopPropagation()">🔗 Issue分析详情</a>
      <span class="badge-time" id="ia-${idx}-time" style="font-size:var(--font-size-xs);padding:2px 8px;border-radius:10px;background:rgba(255,255,255,.06);color:var(--dim);font-family:var(--mono);font-weight:500;flex-shrink:0">${escHtml(timeLabel)}</span>
      <span class="badge-priority" id="ia-${idx}-priority-badge" style="display:none"></span>
      <span class="badge-stage ${stageClass}" id="ia-${idx}-badge">${escHtml(stageLabel)}</span>
      <span class="tc-elapsed" id="ia-${idx}-elapsed" style="display:none">0s</span>
    </div>
    <div class="task-card-body" id="ia-${idx}-body">
      <div class="tc-meta" title="${escHtml(t.issueUrl || '')}" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Issue：${escHtml(t.issueUrl || '')}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap">
        <span style="font-size:var(--font-size-xs);color:var(--text-aux)">Run ID：</span>
        <code id="ia-${idx}-runid" title="点击复制" style="font-family:var(--mono);font-size:var(--font-size-xs);color:var(--accent);background:rgba(77,140,247,.08);border:1px solid rgba(77,140,247,.22);padding:2px 8px;border-radius:6px;cursor:pointer;user-select:all;white-space:nowrap" onclick="copyIaRunId(${idx})">${escHtml(t.runId || '未启动')}</code>
        <span id="ia-${idx}-runid-copied" style="font-size:var(--font-size-xs);color:var(--ok);display:none">✓ 已复制</span>
      </div>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px 20px">
        <div style="display:flex;align-items:center;gap:14px">
          <div class="pipe-icon" id="ia-${idx}-icon" style="width:40px;height:40px;font-size:var(--font-size-lg);border:2px solid var(--border2);border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--surface2)">📋</div>
          <div style="flex:1">
            <div style="font-size:var(--font-size-md);font-weight:600;color:#fff;margin-bottom:4px">Issue 智能分析</div>
            <div style="font-size:var(--font-size-xs);color:var(--text-aux);font-family:var(--mono)" id="ia-${idx}-stage-txt">${escHtml(stageLabel)}</div>
            <div id="ia-${idx}-summary" style="font-size:var(--font-size-xs);color:var(--text-aux);margin-top:4px;display:none"></div>
            <div id="ia-${idx}-flags" style="margin-top:4px;display:${_iaFlagsHtml(t.metadata).show ? 'flex' : 'none'};gap:6px;flex-wrap:wrap">${_iaFlagsHtml(t.metadata).html}</div>
            <div id="ia-${idx}-phase" style="font-size:var(--font-size-xs);color:var(--dim);margin-top:2px;display:none"></div>
          </div>
          <div id="ia-${idx}-dl-wrap" style="display:none;flex-direction:column;gap:6px;align-items:flex-end">
            <a id="ia-${idx}-report-link" href="/api/issue-analysis/${escHtml(t.taskId || '')}/final-review${_iaTokenQ('?')}" target="_blank"
               style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:6px;
                      font-size:var(--font-size-sm);font-weight:600;background:rgba(58,181,113,.12);color:var(--ok);
                      border:1px solid rgba(58,181,113,.3);text-decoration:none;cursor:pointer;white-space:nowrap">
              ↗ 在线预览
            </a>
            <a href="/api/issue-analysis/${escHtml(t.taskId || '')}/final-review${_iaTokenQ('?')}" download
               style="display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:6px;
                      font-size:var(--font-size-xs);font-weight:600;background:rgba(77,140,247,.1);color:var(--accent);
                      border:1px solid rgba(77,140,247,.3);text-decoration:none;cursor:pointer;white-space:nowrap">
              ↓ 下载报告
            </a>
          </div>
        </div>
      </div>
      <div id="ia-${idx}-error" class="error-msg" style="display:none;margin-top:8px"></div>
      <div id="ia-${idx}-timeline-zone" style="display:none;margin-top:10px"></div>
      <div id="ia-${idx}-artifacts-zone" style="display:none;margin-top:10px"></div>
      <div id="ia-${idx}-report-zone" style="display:none;margin-top:10px"></div>
      <div id="ia-${idx}-patch-zone" style="display:none;margin-top:10px"></div>
      <div id="ia-${idx}-feedback-zone" style="display:none;margin-top:10px"></div>
    </div>`;

  const list = $('ia-tasks-list');
  list.insertBefore(card, list.firstChild);

  // 默认折叠
  const body = document.getElementById(`ia-${idx}-body`);
  if (body) body.style.display = 'none';

  // 已完成的历史任务：显示固定时长
  const task = _iaTasks[idx];
  if (isHistory && task.finishedAt && task.startedAt) {
    const durationMs = new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime();
    const durationSec = Math.floor(Math.max(0, durationMs) / 1000);
    const elapsedEl = document.getElementById(`ia-${idx}-elapsed`);
    if (elapsedEl) {
      elapsedEl.textContent = durationSec < 60 ? `${durationSec}s` : `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;
      elapsedEl.style.display = 'inline';
    }
  } else if (!isHistory) {
    // 新任务：启动计时器
    _iaTasks[idx].timer = setInterval(() => {
      const s = Math.floor((Date.now() - _iaTasks[idx].startTime) / 1000);
      const el = document.getElementById(`ia-${idx}-elapsed`);
      if (el) el.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    }, 1000);
  }
}

/* ── 内嵌渲染诊断报告（完成态自动加载，可折叠） ── */
async function _renderIaReport(idx) {
  const zone = document.getElementById(`ia-${idx}-report-zone`);
  const task = _iaTasks[idx];
  if (!zone || !task?.taskId || zone._loaded) return;
  zone._loaded = true;
  zone.innerHTML = '<div style="font-size:var(--font-size-xs);color:var(--dim);padding:6px 0">正在加载诊断报告…</div>';
  zone.style.display = 'block';
  try {
    const r = await authApi('GET', `/api/issue-analysis/${task.taskId}/final-review?format=json`, null, 30000);
    if (r.status === 404) {
      zone.style.display = 'none';   // 无报告（failed 未沉淀）：静默隐藏，不打扰
      return;
    }
    if (r.status !== 200 || !r.data?.success) {
      zone.innerHTML = `<div style="font-size:var(--font-size-xs);color:var(--dim);padding:6px 0">报告加载失败：${escHtml(r.data?.message || 'HTTP ' + r.status)}</div>`;
      return;
    }
    const md = r.data.content || '';
    // 报告较长：默认折叠显示头部摘要（前 3 段），点开全文
    const shortIdx = Math.min(md.indexOf('\n## ', md.indexOf('\n## ') + 1) > -1 ? md.indexOf('\n## ', md.indexOf('\n## ') + 1) : 600, 900);
    zone.innerHTML = `
      <div class="ia-report-viewer">
        <div class="ia-report-head">
          <span class="ov-name">📋 诊断报告（内嵌预览）</span>
          <span class="tc-spacer"></span>
          <button class="pr-act" style="padding:3px 12px" onclick="window._iaToggleReport(${idx})"><span class="ia-report-toggle-label"></span></button>
        </div>
        <div class="md-body ia-report-full"></div>
      </div>`;
    const fullEl = zone.querySelector('.ia-report-full');
    fullEl.innerHTML = _renderMarkdownSafe(md);
    // 默认折叠：限制高度，按钮提示展开
    zone._expanded = false;
    window._iaToggleReport = function (i) {
      const z = document.getElementById(`ia-${i}-report-zone`);
      if (!z) return;
      z._expanded = !z._expanded;
      const body = z.querySelector('.ia-report-full');
      body.style.maxHeight = z._expanded ? 'none' : '300px';
      z.querySelector('.ia-report-toggle-label').textContent = z._expanded ? '⤒ 收起' : '⤓ 展开全文';
    };
    fullEl.style.maxHeight = '300px';
    zone.querySelector('.ia-report-toggle-label').textContent = '⤓ 展开全文';
  } catch (e) {
    zone.innerHTML = `<div style="font-size:var(--font-size-xs);color:var(--dim);padding:6px 0">报告加载失败：${escHtml(e.message)}</div>`;
  }
}

/* ── 修复补丁 diff 视图（GitCode 风格：文件卡片 + 红绿行 + 行号） ── */

/** 解析 unified diff 文本 → [{ file, adds, dels, hunks: [{ header, lines: [{type,oldNo,newNo,text}] }] }] */
function _parseUnifiedDiff(text) {
  const files = [];
  const lines = String(text || '').split('\n');
  let cur = null, hunk = null, oldNo = 0, newNo = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
      cur = { file: (m ? m[2] : line.slice(11)).trim(), adds: 0, dels: 0, hunks: [], isBinary: false };
      files.push(cur); hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) { cur.isBinary = true; continue; }
    if (line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('similarity') || line.startsWith('rename ')) continue;
    const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s*(.*)$/);
    if (hm) {
      hunk = { header: line, context: hm[5] || '', lines: [] };
      cur.hunks.push(hunk);
      oldNo = parseInt(hm[1], 10); newNo = parseInt(hm[3], 10);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) { hunk.lines.push({ type: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) }); cur.adds++; }
    else if (line.startsWith('-')) { hunk.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) }); cur.dels++; }
    else if (line.startsWith('\\')) { hunk.lines.push({ type: 'meta', oldNo: null, newNo: null, text: line.slice(1) }); }
    else { hunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) }); }
  }
  return files;
}

/** 字符级差异高亮：配对的旧/新行，公共前后缀外的部分标深色底（GitCode word-diff 效果） */
function _charDiff(a, b) {
  const A = String(a ?? ''), B = String(b ?? '');
  if (!A || !B || A === B) return { aHtml: null, bHtml: null };
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const aMid = A.slice(pre, A.length - suf), bMid = B.slice(pre, B.length - suf);
  if (!aMid && !bMid) return { aHtml: null, bHtml: null };
  return {
    aHtml: escHtml(A.slice(0, pre)) + '<span style="background:rgba(248,81,73,.32);border-radius:2px">' + escHtml(aMid) + '</span>' + escHtml(A.slice(A.length - suf)),
    bHtml: escHtml(B.slice(0, pre)) + '<span style="background:rgba(46,160,67,.32);border-radius:2px">' + escHtml(bMid) + '</span>' + escHtml(B.slice(B.length - suf)),
  };
}

/** hunk 行配对（split 视图）：连续 del 块与 add 块逐行配对（剩余靠左/右），ctx 两边同显 */
function _pairHunkLines(lines) {
  const pairs = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === 'ctx' || l.type === 'meta') {
      pairs.push({ left: l.type === 'ctx' ? l : null, right: l.type === 'ctx' ? l : null, meta: l.type === 'meta' ? l : null });
      i++; continue;
    }
    const dels = [], adds = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const d = dels[k] || null, a = adds[k] || null;
      const hl = (d && a) ? _charDiff(d.text, a.text) : { aHtml: null, bHtml: null };
      pairs.push({ left: d, right: a, aHtml: hl.aHtml, bHtml: hl.bHtml });
    }
  }
  return pairs;
}

/** split 行渲染：grid 7 列（38px 14px 1fr | 2px | 38px 14px 1fr），左=修改前，右=修改后 */
function _renderIaSplitRow(p) {
  if (p.meta) {
    return `<div style="padding:1px 8px;font-family:var(--mono);font-size:var(--font-size-xs);color:var(--text-aux);font-style:italic">${escHtml(p.meta.text)}</div>`;
  }
  const cell = (line, side, hlHtml) => {
    const isPresent = Boolean(line);
    const bg = !isPresent ? 'rgba(127,145,166,.06)'
      : line.type === 'del' ? 'rgba(248,81,73,.15)'
      : line.type === 'add' ? 'rgba(46,160,67,.15)' : 'transparent';
    const no = isPresent ? (side === 'L' ? line.oldNo : line.newNo) : '';
    const mark = isPresent ? (line.type === 'del' ? '-' : line.type === 'add' ? '+' : '') : '';
    // 深色主题色板：删除 #ff7b72 / 新增 #7ee787（GitCode dark 同系亮色），行号用 --text-aux
    const fg = isPresent && line.type === 'del' ? '#ff7b72' : isPresent && line.type === 'add' ? '#7ee787' : 'var(--text-aux)';
    const content = isPresent ? (hlHtml || escHtml(line.text)) : '';
    const color = isPresent && line.type === 'ctx' ? 'var(--text)' : 'var(--text)';
    const opacity = isPresent && line.type === 'ctx' ? '.82' : '1';
    return `
      <div style="min-width:0;padding:1px 6px;text-align:right;color:var(--text-aux);user-select:none;background:${bg}">${no}</div>
      <div style="min-width:0;text-align:center;color:${fg};font-weight:700;user-select:none;background:${bg}">${mark}</div>
      <div style="min-width:0;padding:1px 8px;white-space:pre-wrap;word-break:break-all;color:${color};opacity:${opacity};background:${bg}">${content || '&nbsp;'}</div>`;
  };
  return `
    <div style="display:grid;grid-template-columns:38px 14px minmax(0,1fr) 2px 38px 14px minmax(0,1fr);align-items:stretch">
      ${cell(p.left, 'L', p.aHtml)}
      <div style="background:rgba(127,145,166,.25)"></div>
      ${cell(p.right, 'R', p.bHtml)}
    </div>`;
}

/** 渲染单个文件卡片（可折叠） */
function _renderIaPatchFile(fi, fileIdx, patchLabel) {
  const fileHead = fileIdx.file.split('/').pop();
  const total = fileIdx.hunks.reduce((s, h) => s + h.lines.length, 0);
  const id = `${patchLabel}-f${fi}`;
  return `
    <div style="border:1px solid rgba(127,145,166,.25);border-radius:8px;overflow:hidden;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(127,145,166,.08);cursor:pointer"
           onclick="window._iaTogglePatchFile('${id}', this)">
        <span style="font-size:var(--font-size-xs);color:var(--text-aux)">▾</span>
        <span style="font-family:var(--mono);font-size:var(--font-size-xs);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="${escHtml(fileIdx.file)}">${escHtml(fileHead)}</span>
        <span style="font-family:var(--mono);font-size:10px;color:var(--text-aux);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%" title="${escHtml(fileIdx.file)}">${escHtml(fileIdx.file)}</span>
        <span style="font-family:var(--mono);font-size:var(--font-size-xs);font-weight:700;color:#7ee787;white-space:nowrap">+${fileIdx.adds}</span>
        <span style="font-family:var(--mono);font-size:var(--font-size-xs);font-weight:700;color:#ff7b72;white-space:nowrap">-${fileIdx.dels}</span>
      </div>
      <div id="iapf-${id}" data-open="1">
        ${fileIdx.isBinary ? `<div style="padding:10px;font-size:var(--font-size-xs);color:var(--text-aux)">二进制文件，无法展示文本 diff</div>` : `
        <div style="display:grid;grid-template-columns:38px 14px minmax(0,1fr) 2px 38px 14px minmax(0,1fr);border-bottom:1px solid rgba(127,145,166,.15);background:rgba(127,145,166,.06);font-size:var(--font-size-xs);color:var(--text-aux)">
          <div style="grid-column:1/4;text-align:center;padding:2px 0">修改前</div>
          <div style="grid-column:5/8;text-align:center;padding:2px 0">修改后</div>
        </div>
        <div style="font-family:var(--mono);font-size:var(--font-size-xs);line-height:1.55">
          ${fileIdx.hunks.map(h => `
            <div style="padding:2px 8px;background:rgba(56,139,253,.1);font-family:var(--mono);font-size:var(--font-size-xs);color:#6cb2ff">${escHtml(h.header)}${h.context ? ' <span style="color:var(--text-aux)">' + escHtml(h.context) + '</span>' : ''}</div>
            ${_pairHunkLines(h.lines).map(p => _renderIaSplitRow(p)).join('')}
          `).join('')}
        </div>
        ${total > 600 ? '<div style="padding:4px 10px;font-size:var(--font-size-xs);color:var(--text-aux)">行数较多，已完整展示</div>' : ''}`}
      </div>
    </div>`;
}

/** 终态任务渲染补丁 diff 视图（懒加载 work/fix.patch 与 fix-engine.patch） */
async function _renderIaPatch(idx) {
  const zone = document.getElementById(`ia-${idx}-patch-zone`);
  const task = _iaTasks[idx];
  if (!zone || !task?.taskId || zone._loaded) return;
  zone._loaded = true;

  const patchDefs = [
    { ref: 'work/fix.patch', label: '框架仓（flutter_flutter）' },
    { ref: 'work/fix-engine.patch', label: '引擎仓（flutter_engine）' },
  ];
  const sections = [];
  for (const def of patchDefs) {
    try {
      const r = await authApi('GET', `/api/issue-analysis/${task.taskId}/artifacts/file?ref=${encodeURIComponent(def.ref)}&format=json`, null, 30000);
      if (r.status !== 200 || !r.data?.success) continue;
      const content = r.data.content || '';
      if (!content.trim() || content.trim() === '') continue;   // 空 patch（修复落在另一仓）跳过
      const files = _parseUnifiedDiff(content);
      if (!files.length) continue;
      const adds = files.reduce((s, f) => s + f.adds, 0);
      const dels = files.reduce((s, f) => s + f.dels, 0);
      sections.push(`
        <div style="margin-bottom:8px;font-size:var(--font-size-xs);color:var(--text-aux)">
          <b style="color:var(--text)">${escHtml(def.label)}</b>
          <span style="font-family:var(--mono);margin-left:8px;color:#7ee787">+${adds}</span>
          <span style="font-family:var(--mono);color:#ff7b72">-${dels}</span>
          <span style="color:var(--text-aux);margin-left:8px">${files.length} 个文件</span>
        </div>
        ${files.map((f, i) => _renderIaPatchFile(i, f, `${idx}-${def.ref.replace(/\W/g, '')}`)).join('')}`);
    } catch { /* 单个 patch 拉取失败不阻塞整体 */ }
  }

  if (!sections.length) {
    zone.style.display = 'none';
    return;
  }
  zone.style.display = 'block';
  zone.innerHTML = `
    <div class="ia-report-viewer">
      <div class="ia-report-head">
        <span class="ov-name">📝 修复代码变更（diff）</span>
        <span class="tc-spacer"></span>
        <a href="/api/issue-analysis/${escHtml(task.taskId)}/artifacts/file?ref=work/fix-engine.patch&download=1${_iaTokenQ()}" download
           style="font-size:var(--font-size-xs);color:var(--accent);text-decoration:none;padding:3px 10px">下载 .patch</a>
      </div>
      <div style="padding:10px 12px">${sections.join('<div style="height:14px"></div>')}</div>
    </div>`;

  // 文件折叠
  window._iaTogglePatchFile = function (id, headEl) {
    const body = document.getElementById(`iapf-${id}`);
    if (!body) return;
    const open = body.dataset.open === '1';
    body.dataset.open = open ? '0' : '1';
    body.style.display = open ? 'none' : '';
    headEl.firstElementChild.textContent = open ? '▸' : '▾';
  };
}

/* ── 用户反馈迭代区（终态任务显示：反馈输入框 + 迭代链 + 对比入口） ── */
async function _renderIaFeedback(idx) {
  const zone = document.getElementById(`ia-${idx}-feedback-zone`);
  const task = _iaTasks[idx];
  if (!zone || !task?.taskId || zone._loaded) return;
  zone._loaded = true;

  // 迭代链（根任务 + 全部轮次）
  let chain = null;
  try {
    const r = await authApi('GET', `/api/issue-analysis/${task.taskId}/iterations`, null, 15000);
    if (r.status === 200 && r.data?.success) chain = r.data;
  } catch { /* ignore */ }

  const rounds = chain?.iterations || [null];
  const userRounds = rounds.filter(x => x?.isUserRound);
  const isIterateRoot = chain && chain.iterations.length > 1;
  const iterBadge = task.parentTaskId
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:var(--font-size-xs);font-weight:600;background:rgba(168,85,247,.12);color:#a855f7;border:1px solid rgba(168,85,247,.3);margin-left:8px">💬 反馈迭代轮</span>`
    : (isIterateRoot ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:var(--font-size-xs);font-weight:600;background:rgba(77,140,247,.1);color:var(--accent);border:1px solid rgba(77,140,247,.3);margin-left:8px">AI 基准轮 · 已迭代 ${userRounds.length} 次</span>` : '');

  zone.style.display = 'block';
  zone.innerHTML = `
    <div class="ia-report-viewer">
      <div class="ia-report-head">
        <span class="ov-name">💬 修复反馈${iterBadge}</span>
      </div>
      <div style="padding:10px 12px">
        ${task.userFeedback ? `
          <div style="margin-bottom:10px;padding:8px 10px;border-radius:8px;background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.2)">
            <div style="font-size:var(--font-size-xs);font-weight:600;color:#a855f7;margin-bottom:4px">本轮用户意见</div>
            <div style="font-size:var(--font-size-xs);color:var(--text-aux);white-space:pre-wrap">${escHtml(task.userFeedback.length > 300 ? task.userFeedback.slice(0, 300) + '…' : task.userFeedback)}</div>
          </div>` : ''}
        <div style="font-size:var(--font-size-xs);color:var(--dim);margin-bottom:6px">
          对修复方案不满意？提交修改意见，将从「方案设计」阶段重新收敛（复用复现 Demo 与根因结论，不全量重跑；黄金标志保持冻结，用户建议同样需过真机验证）。
        </div>
        <textarea id="ia-${idx}-feedback-input" rows="3" placeholder="例：建议不要用 instanceof 判断，改用鸭子类型检查 e.code 属性是否存在；或：修复应该同时覆盖 EventChannel 的 cancel 路径…"
          style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(127,145,166,.3);background:rgba(15,23,42,.4);color:var(--text);font-size:var(--font-size-sm);resize:vertical;font-family:inherit"></textarea>
        <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
          <button id="ia-${idx}-feedback-btn" class="pr-act" style="padding:6px 16px;font-weight:600"
            onclick="window._iaSubmitFeedback(${idx})">提交反馈，开始迭代</button>
          <span id="ia-${idx}-feedback-hint" style="font-size:var(--font-size-xs);color:var(--dim)"></span>
        </div>
      </div>
    </div>`;

  window._iaSubmitFeedback = async function (i) {
    const z = document.getElementById(`ia-${i}-feedback-zone`);
    const input = document.getElementById(`ia-${i}-feedback-input`);
    const btn = document.getElementById(`ia-${i}-feedback-btn`);
    const hint = document.getElementById(`ia-${i}-feedback-hint`);
    const text = (input?.value || '').trim();
    if (!text) { hint.textContent = '请先输入反馈内容'; return; }
    btn.disabled = true;
    hint.textContent = '正在创建迭代任务…';
    try {
      const r = await authApi('POST', `/api/issue-analysis/${_iaTasks[i].taskId}/feedback`, { feedback: text }, 60000);
      if (r.status === 200 && r.data?.success) {
        hint.textContent = `已创建迭代任务 ${r.data.taskId}，正在从方案设计阶段重新收敛…`;
        setTimeout(() => { if (typeof initIssueAnalysisHistory === 'function') initIssueAnalysisHistory(); }, 1500);
      } else {
        hint.textContent = `提交失败：${escHtml(r.data?.message || 'HTTP ' + r.status)}`;
        btn.disabled = false;
      }
    } catch (e) {
      hint.textContent = `提交失败：${escHtml(e.message)}`;
      btn.disabled = false;
    }
  };
}

/* ── 卡片折叠 ── */
function toggleIaCard(idx) {
  const card = document.getElementById(`ia-card-${idx}`);
  const body = document.getElementById(`ia-${idx}-body`);
  if (!card || !body) return;
  const isOpen = card.classList.toggle('open');
  body.style.display = isOpen ? '' : 'none';
  if (isOpen) _ensureIaExtras(idx);
}

/* ── 展开卡片时懒加载：诊断时间线 + 产物面板 ── */
async function _ensureIaExtras(idx) {
  const task = _iaTasks[idx];
  if (!task?.taskId) return;
  _renderIaTimeline(idx);
  _renderIaArtifacts(idx);
}

/* ── 诊断时间线（16 步，点击看步骤日志） ── */
async function _renderIaTimeline(idx) {
  const zone = document.getElementById(`ia-${idx}-timeline-zone`);
  const task = _iaTasks[idx];
  if (!zone || !task?.taskId || zone._loaded) return;

  let steps = task.ahSteps;
  if (!steps || !steps.length) {
    // 历史任务/未轮询到：主动拉一次状态
    try {
      const r = await authApi('GET', `/api/issue-analysis/${task.taskId}/status`, null, 15000);
      if (r.status === 200 && r.data?.task?.aceharnessStatus?.stepLogs) {
        steps = r.data.task.aceharnessStatus.stepLogs;
        task.ahSteps = steps;
      }
    } catch { /* ignore */ }
  }
  if (!steps || !steps.length) return;

  zone._loaded = true;
  zone.style.display = 'block';

  // 按阶段分组（stepName 形如「信息采集-Issue信息采集」）
  const groups = [];
  for (const s of steps) {
    const sep = (s.stepName || '').indexOf('-');
    const phase = sep > 0 ? s.stepName.slice(0, sep) : '流程';
    const name = sep > 0 ? s.stepName.slice(sep + 1) : s.stepName;
    let g = groups.find(x => x.phase === phase);
    if (!g) { g = { phase, items: [] }; groups.push(g); }
    g.items.push({ ...s, _name: name });
  }

  const rows = groups.map((g, gi) => `
    <div class="ia-tl-phase">${escHtml(g.phase)}
      <span class="ia-tl-count">${g.items.length} 步</span></div>
    ${g.items.map((s, si) => {
      const icon = s.status === 'completed' ? '✅' : (s.status === 'failed' ? '❌' : (s.status === 'running' ? '🔄' : '⏳'));
      const time = s.timestamp ? new Date(s.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      const kb = s.outputBytes ? ` · ${(s.outputBytes / 1024).toFixed(0)}KB` : '';
      const hasLog = s.outputRef && s.status === 'completed';
      return `
      <div class="ia-tl-item ${hasLog ? 'clickable' : ''}" ${hasLog ? `onclick="toggleIaStepLog(${idx}, '${gi}_${si}')"` : ''}>
        <span class="ia-tl-icon">${icon}</span>
        <span class="ia-tl-name">${escHtml(s._name)}</span>
        <span class="ia-tl-meta">${escHtml(time)}${kb}</span>
        ${hasLog ? '<span class="ia-tl-arrow">▸</span>' : ''}
      </div>
      <div class="ia-tl-log" id="ia-${idx}-tllog-${gi}_${si}" style="display:none"></div>`;
    }).join('')}`).join('');

  zone.innerHTML = `
    <div class="ia-report-viewer">
      <div class="ia-report-head">
        <span class="ov-name">🧭 诊断时间线（点击步骤查看日志）</span>
        <span class="tc-spacer"></span>
        <span style="font-size:var(--font-size-xs);color:var(--dim)">${steps.length} 个步骤</span>
      </div>
      <div class="ia-tl-body">${rows}</div>
    </div>`;
}

/* ── 展开/收起单个步骤日志 ── */
async function toggleIaStepLog(idx, key) {
  const logEl = document.getElementById(`ia-${idx}-tllog-${key}`);
  const zone = document.getElementById(`ia-${idx}-timeline-zone`);
  if (!logEl || !zone) return;
  const task = _iaTasks[idx];
  const steps = task?.ahSteps || [];

  if (logEl.style.display !== 'none') { logEl.style.display = 'none'; return; }
  logEl.style.display = 'block';

  if (!logEl._loaded) {
    logEl._loaded = true;
    // key 形如 "gi_si"，从 groups 重建索引
    const [gi, si] = String(key).split('_').map(Number);
    const groups = [];
    for (const s of steps) {
      const sep = (s.stepName || '').indexOf('-');
      const phase = sep > 0 ? s.stepName.slice(0, sep) : '流程';
      let g = groups.find(x => x.phase === phase);
      if (!g) { g = { phase, items: [] }; groups.push(g); }
      g.items.push(s);
    }
    const s = groups[gi]?.items[si];
    if (!s?.outputRef) { logEl.innerHTML = '<div class="ia-tl-log-empty">无日志</div>'; return; }

    logEl.innerHTML = '<div class="ia-tl-log-empty">加载中…</div>';
    // 优先读归档顶层完整版（arch/{stepName}.md），404 再回退 step-logs 截断版
    const fallbackRef = s.outputRef.replace(/^\/+/, '').replace(/^outputs\//, 'arch/');
    const fullRef = `arch/${s.stepName}.md`;
    const fetchRef = async (ref) => {
      const r = await authApi('GET', `/api/issue-analysis/${task.taskId}/artifacts/file?ref=${encodeURIComponent(ref)}&format=json`, null, 30000);
      return (r.status === 200 && r.data?.success) ? r.data.content : null;
    };
    try {
      let md = await fetchRef(fullRef);
      if (md == null) md = await fetchRef(fallbackRef);
      if (md == null) {
        logEl.innerHTML = '<div class="ia-tl-log-empty">日志不存在（run 目录可能已被清理）</div>';
        return;
      }
      const LIMIT = 120 * 1024;
      const truncated = md.length > LIMIT;
      logEl.innerHTML = `
        <div class="md-body ia-tl-log-md">${_renderMarkdownSafe(truncated ? md.slice(0, LIMIT) : md)}</div>
        ${truncated ? `<div class="ia-tl-log-empty">… 内容过长已截断，
          <a href="/api/issue-analysis/${escHtml(task.taskId)}/artifacts/file?ref=${encodeURIComponent(fullRef)}&download=1${_iaTokenQ()}" target="_blank">下载全文</a></div>` : ''}`;
    } catch (e) {
      logEl.innerHTML = `<div class="ia-tl-log-empty">日志加载失败：${escHtml(e.message)}</div>`;
    }
  }
}

/* ── 产物面板：截图画廊（按复现/修复分组）+ 日志/补丁文件 ── */
async function _renderIaArtifacts(idx) {
  const zone = document.getElementById(`ia-${idx}-artifacts-zone`);
  const task = _iaTasks[idx];
  if (!zone || !task?.taskId || zone._loaded) return;
  zone._loaded = true;

  let data = null;
  try {
    const r = await authApi('GET', `/api/issue-analysis/${task.taskId}/artifacts`, null, 15000);
    if (r.status === 200 && r.data?.success) data = r.data;
  } catch { /* ignore */ }
  if (!data) return;

  const { images = [], logs = [], files = [] } = data;
  if (!images.length && !logs.length && !files.length) { zone.style.display = 'none'; return; }
  zone.style.display = 'block';

  const base = `/api/issue-analysis/${task.taskId}/artifacts/file`;

  // 截图按语义分组：修复验证（fix_*）最优先，其次问题复现（before/after/s*/reset）
  const groups = { fix: [], repro: [], other: [] };
  const seen = {}; // md5 去重：画面完全相同的截图合并显示并标注
  for (const im of images) {
    const meta = { ...im, _title: _iaImgTitle(im.name) };
    if (im.md5) {
      if (seen[im.md5]) { seen[im.md5]._dupCount++; continue; }
      seen[im.md5] = meta;
      meta._dupCount = 1;
    }
    groups[_iaImgGroup(im.name)].push(meta);
  }

  const gallery = images.length ? `
    <div class="ia-art-gallery">
      ${groups.fix.length ? `
        <div class="ia-art-group-head fix">🟢 修复验证截图（${groups.fix.length}）<span>修复后真机回测，对照黄金标志</span></div>` : ''}
      ${groups.fix.map((im, i) => _iaThumb(base, im, `fix${i}`)).join('')}
      ${groups.repro.length ? `
        <div class="ia-art-group-head repro">🔴 问题复现截图（${groups.repro.length}）<span>⬜ 操作前基线 → 🔴 复现后对比，OHOS vs Android</span></div>` : ''}
      ${groups.repro.map((im, i) => _iaThumb(base, im, `repro${i}`)).join('')}
      ${groups.other.length ? `
        <div class="ia-art-group-head">📷 其他截图（${groups.other.length}）</div>` : ''}
      ${groups.other.map((im, i) => _iaThumb(base, im, `other${i}`)).join('')}
    </div>` : '';

  const fileRow = (f) => `
    <a class="ia-art-file" href="#" data-ref="${escHtml(f.ref)}" data-name="${escHtml(f.name)}" title="下载 ${escHtml(f.name)}">
      <span class="ia-art-ficon">${f.kind === 'patch' ? '🩹' : (f.kind === 'markdown' ? '📄' : (f.kind === 'text' ? '📝' : '📦'))}</span>
      <span class="ia-art-fname">${escHtml(f.name)}</span>
      <span class="ia-art-fsize">${_fmtIaSize(f.size)}</span>
    </a>`;

  const fileList = (logs.length || files.length) ? `
    <div class="ia-art-section">📎 运行产物与日志（${logs.length + files.length}）</div>
    <div class="ia-art-files">${logs.map(fileRow).join('')}${files.map(fileRow).join('')}</div>` : '';

  zone.innerHTML = `
    <div class="ia-report-viewer">
      <div class="ia-report-head">
        <span class="ov-name">🗂 诊断证据（点击截图页内放大）</span>
      </div>
      <div style="padding:10px 14px">
        ${gallery}
        ${fileList}
      </div>
    </div>`;

  // A08：下载走带 Authorization 的 Blob 获取（原生 <a> 无法携带凭证，裸链会 401）
  zone.querySelectorAll('.ia-art-file').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      _iaDownloadArtifact(`${base}?ref=${encodeURIComponent(el.dataset.ref)}&download=1`, el.dataset.name);
    });
  });

  // 绑定灯箱数据（点击缩略图页内打开，不跳新页）
  zone._lbItems = [
    ...groups.fix, ...groups.repro, ...groups.other,
  ].map(im => ({ src: `${base}?ref=${encodeURIComponent(im.ref)}`, title: im._title, name: im.name, size: im.size }));
  zone.querySelectorAll('.ia-art-thumb').forEach((el, i) => {
    el.addEventListener('click', (e) => { e.preventDefault(); openIaLightbox(zone._lbItems, i); });
  });
}

/* ── 带登录态的二进制获取（A08：<img>/<a> 原生请求无法携带 Authorization） ── */

/** fetch 带 Authorization 并返回对象 URL；401 时明确提示登录失效 */
async function _iaAuthFetchBlobUrl(path) {
  const auth = (typeof getAuth === 'function') ? getAuth() : null;
  const res = await fetch(path, {
    headers: auth?.token ? { Authorization: 'Bearer ' + auth.token } : {},
  });
  if (res.status === 401) throw new Error('登录已失效，请重新登录');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

/** 下载产物文件：带凭证拉 Blob 后用对象 URL 触发浏览器下载 */
async function _iaDownloadArtifact(path, name) {
  try {
    const url = await _iaAuthFetchBlobUrl(path);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'artifact';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    alert(`下载失败：${e.message}`);
  }
}

/* ── 截图缩略图 ── */
function _iaThumb(base, im, _key) {
  const dupBadge = im._dupCount > 1
    ? `<span class="ia-art-dup" title="另有 ${im._dupCount - 1} 张画面完全相同的截图（多场景共用画面），已合并">×${im._dupCount} 同画面</span>` : '';
  return `
    <a class="ia-art-thumb" href="${base}?ref=${encodeURIComponent(im.ref)}" title="${escHtml(im.name)} · ${_fmtIaSize(im.size)}">
      <img src="${base}?ref=${encodeURIComponent(im.ref)}${_iaTokenQ()}" loading="lazy" alt="${escHtml(im.name)}">
      <span class="ia-art-caption">${escHtml(im._title)}${dupBadge}</span>
    </a>`;
}

/* ── 截图文件名 → 分组 ── */
function _iaImgGroup(name) {
  const n = String(name || '').toLowerCase();
  if (/^fix/.test(n)) return 'fix';
  if (/before|after|^s\d|reset/.test(n)) return 'repro';
  return 'other';
}

/* ── 截图文件名 → 人话标题 ── */
function _iaImgTitle(name) {
  const n = String(name || '').toLowerCase().replace(/\.(png|jpe?g|gif|webp|bmp)$/, '');
  const plat = n.includes('ohos') ? 'OHOS' : (n.includes('android') ? 'Android' : '');
  if (/^fix/.test(n)) {
    const rest = n.replace(/^fix_?/, '').replace(/_/g, ' ').trim();
    return `🔧 修复验证${rest ? ' · ' + rest : ''}`;
  }
  if (n.includes('before')) return `⬜ 操作前基线${plat ? ' · ' + plat : ''}`;
  const sm = n.match(/^s(\d+)/);
  if (n.includes('reset')) return `🔁 复位后${plat ? ' · ' + plat : ''}`;
  if (n.includes('after')) {
    if (sm) return `🔴 场景 S${sm[1]} 复现后${plat ? ' · ' + plat : ''}`;
    return `🔴 复现后（问题现象）${plat ? ' · ' + plat : ''}`;
  }
  return name;
}

/* ── 页内灯箱：全屏查看 / 左右切换 / ESC 或点遮罩关闭 ──
   注意：灯箱 DOM 与监听器均单例，openIaLightbox 只更新状态并渲染，
   避免重复绑定导致旧闭包（旧 cur/旧图片列表）互相覆盖、切换乱跳 */
let _iaLbItems = [];
let _iaLbCur = 0;
let _iaLbObjUrl = null;   // 灯箱当前图片的对象 URL（关闭/切换时回收）
let _iaLbSeq = 0;         // 快速连按左右切换时的竞态序号

function openIaLightbox(items, startIdx) {
  if (!items?.length) return;
  _iaLbItems = items;
  _iaLbCur = Math.max(0, Math.min(startIdx || 0, items.length - 1));

  let box = document.getElementById('ia-lightbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'ia-lightbox';
    box.innerHTML = `
      <div class="ia-lb-backdrop"></div>
      <button class="ia-lb-close" title="关闭 (Esc)">✕</button>
      <button class="ia-lb-prev" title="上一张 (←)">‹</button>
      <button class="ia-lb-next" title="下一张 (→)">›</button>
      <div class="ia-lb-stage">
        <img class="ia-lb-img" alt="">
        <div class="ia-lb-bar">
          <span class="ia-lb-title"></span>
          <span class="ia-lb-count"></span>
        </div>
      </div>`;
    document.body.appendChild(box);
    // 监听器只绑定一次，操作模块级状态
    box.querySelector('.ia-lb-backdrop').addEventListener('click', closeIaLightbox);
    box.querySelector('.ia-lb-close').addEventListener('click', closeIaLightbox);
    box.querySelector('.ia-lb-prev').addEventListener('click', () => _iaLbNav(-1));
    box.querySelector('.ia-lb-next').addEventListener('click', () => _iaLbNav(1));
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('ia-lightbox')?.style.display !== 'flex') return;
      if (e.key === 'Escape') closeIaLightbox();
      else if (e.key === 'ArrowLeft') _iaLbNav(-1);
      else if (e.key === 'ArrowRight') _iaLbNav(1);
    });
  }

  box.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  _iaLbRender();
}

function _iaLbNav(dir) {
  if (!_iaLbItems.length) return;
  _iaLbCur = (_iaLbCur + dir + _iaLbItems.length) % _iaLbItems.length;
  _iaLbRender();
}

function _iaLbRender() {
  const box = document.getElementById('ia-lightbox');
  const it = _iaLbItems[_iaLbCur];
  if (!box || !it) return;
  box.querySelector('.ia-lb-title').textContent = `${it.title || it.name}（${_fmtIaSize(it.size)}）`;
  box.querySelector('.ia-lb-count').textContent = `${_iaLbCur + 1} / ${_iaLbItems.length}`;
  box.querySelector('.ia-lb-prev').style.display = _iaLbItems.length > 1 ? '' : 'none';
  box.querySelector('.ia-lb-next').style.display = _iaLbItems.length > 1 ? '' : 'none';

  // A08：灯箱图改用带 Authorization 的 Blob 获取（裸 src 无法携带凭证 → 401 白屏）
  const img = box.querySelector('.ia-lb-img');
  if (_iaLbObjUrl) { URL.revokeObjectURL(_iaLbObjUrl); _iaLbObjUrl = null; }
  img.src = '';
  img.style.opacity = '0.25';
  const seq = ++_iaLbSeq;
  _iaAuthFetchBlobUrl(it.src).then((url) => {
    if (seq !== _iaLbSeq) { URL.revokeObjectURL(url); return; }  // 已切到下一张，丢弃迟到的响应
    _iaLbObjUrl = url;
    img.src = url;
    img.style.opacity = '';
  }).catch((e) => {
    if (seq !== _iaLbSeq) return;
    img.style.opacity = '';
    box.querySelector('.ia-lb-title').textContent = `加载失败：${e.message}`;
  });
}

function closeIaLightbox() {
  const box = document.getElementById('ia-lightbox');
  if (box) {
    box.style.display = 'none';
    box.querySelector('.ia-lb-img').src = '';
  }
  if (_iaLbObjUrl) { URL.revokeObjectURL(_iaLbObjUrl); _iaLbObjUrl = null; }
  _iaLbSeq++;  // 作废在途请求
  document.body.style.overflow = '';
}

/* ── 文件大小格式化 ── */
function _fmtIaSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/* ── 复制 AceHarness Run ID ── */
function copyIaRunId(idx) {
  const task = _iaTasks[idx];
  const runId = task?.runId;
  if (!runId) return;
  const done = () => {
    const tip = document.getElementById(`ia-${idx}-runid-copied`);
    if (tip) {
      tip.style.display = 'inline';
      setTimeout(() => { tip.style.display = 'none'; }, 1500);
    }
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(runId).then(done).catch(() => _copyIaRunIdFallback(runId, done));
  } else {
    _copyIaRunIdFallback(runId, done);
  }
}

function _copyIaRunIdFallback(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    done();
  } catch { /* ignore */ }
}

/* ── 轮询时同步 Run ID（新建任务启动后 runId 可能延迟到达） ── */

/* F01/F04/R06：归档完整度与验证状态徽标——"完成"不得掩盖归档异常/验证受限 */
function _iaFlagsHtml(metadata) {
  const md = metadata || {};
  const flags = [];
  const as = md.artifactStatus?.status || null;
  const vs = md.verificationStatus || null;
  if (as === 'failed') flags.push({ text: '⚠ 归档失败（可只重试归档）', color: 'var(--err, #e5534b)', bg: 'rgba(229,83,75,.12)', bd: 'rgba(229,83,75,.35)' });
  else if (as === 'partial') flags.push({ text: '⚠ 归档不完整', color: 'var(--warn, #d29922)', bg: 'rgba(210,153,34,.12)', bd: 'rgba(210,153,34,.35)' });
  if (vs === 'evidence_conflict') flags.push({ text: '⚠ 验证结论冲突（需复核）', color: 'var(--danger, #f85149)', bg: 'rgba(248,81,73,.12)', bd: 'rgba(248,81,73,.35)' });
  else if (vs === 'needs_runtime_validation') flags.push({ text: '◔ 验证受限（需运行时复核）', color: 'var(--warn, #d29922)', bg: 'rgba(210,153,34,.12)', bd: 'rgba(210,153,34,.35)' });
  else if (vs === 'evidence_incomplete') flags.push({ text: '◔ 证据不全', color: 'var(--dim)', bg: 'rgba(139,148,158,.12)', bd: 'rgba(139,148,158,.3)' });
  return {
    show: flags.length > 0,
    html: flags.map(f => `<span style="font-size:var(--font-size-xs);padding:2px 8px;border-radius:10px;background:${f.bg};color:${f.color};border:1px solid ${f.bd};font-weight:600">${f.text}</span>`).join(''),
  };
}

/* ── 状态轮询（代理到 AceHarness） ── */
function _startIaPolling(idx) {
  const task = _iaTasks[idx];
  if (!task || task.pollActive) return;
  // Q04：同一 taskId 只保留一个观察者——新卡片（新 idx）取代旧卡片的轮询，
  // 翻页/重复渲染不会为同一任务累积多个轮询实例。
  const prevIdx = _iaPollers.get(task.taskId);
  if (prevIdx != null && prevIdx !== idx) _stopIaPolling(prevIdx);
  _iaPollers.set(task.taskId, idx);
  task.pollActive = true;
  const generation = task.pollGeneration = (task.pollGeneration || 0) + 1;
  const current = () => _iaTasks[idx] === task && task.pollActive && task.pollGeneration === generation;
  let delay = 1500;
  let lastProgress = '';
  const poll = async () => {
    try {
      const r = await authApi('GET', `/api/issue-analysis/${task.taskId}/status`, null, 15000);
      if (!current()) return;
      if (r.status === 401 || r.status === 403) { _stopIaPolling(idx); return; }
      if (r.status !== 200 || !r.data?.task) throw new Error('状态暂不可用');
      const t = r.data.task;
      const ah = t.aceharnessStatus;
      _updateIaStage(idx, t.stage, { ...t, currentPhase: ah?.currentPhase, currentStep: ah?.currentStep });
      if (['issueanalysis_complete', 'failed', 'cancelled'].includes(t.stage)) {
        _stopIaPolling(idx);
        return;
      }
      const progress = [t.stage, ah?.currentPhase, ah?.currentStep].join('|');
      delay = t.queryUnavailable ? Math.min(15000, Math.max(5000, delay * 1.5))
        : progress !== lastProgress ? 1500 : Math.min(10000, Math.round(delay * 1.5));
      lastProgress = progress;
    } catch (e) {
      if (current()) {
        delay = Math.min(15000, Math.max(5000, delay * 1.5));
        const phase = document.getElementById(`ia-${idx}-phase`);
        if (phase) { phase.textContent = '状态查询暂不可用，正在重试；任务状态保留'; phase.style.display = 'block'; }
      }
    } finally {
      // Schedule only after the preceding request settles; long tasks have no fixed polling cutoff.
      if (current()) task.pollTimer = setTimeout(poll, document.hidden ? Math.max(30000, delay) : delay);
    }
  };
  poll();
}

function _stopIaPolling(idx) {
  const task = _iaTasks[idx];
  if (!task) return;
  task.pollActive = false;
  task.pollGeneration = (task.pollGeneration || 0) + 1;
  if (task.pollTimer) { clearTimeout(task.pollTimer); task.pollTimer = null; }
  if (task.pollTimeout) { clearTimeout(task.pollTimeout); task.pollTimeout = null; }
  if (task.timer) { clearInterval(task.timer); task.timer = null; }
  // Q04：仅当登记表仍指向本 idx 时才摘除（避免新观察者注册后被旧对象误删）
  if (_iaPollers.get(task.taskId) === idx) _iaPollers.delete(task.taskId);
}

/* ── 阶段 UI 更新 ── */
function _updateIaStage(idx, stage, data) {
  const task = _iaTasks[idx];
  if (task) {
    task.stage = stage;
    const rid = data?.runId || data?.analysisSessionId;
    if (rid) task.runId = rid;
    if (data?.priorityLevel) task.priorityLevel = data.priorityLevel;
    if (data?.summary) task.summary = data.summary;
    if (data?.startedAt) task.startedAt = data.startedAt;
    if (data?.finishedAt) task.finishedAt = data.finishedAt;
  }

  // 同步 Run ID 展示（头部徽章 + 展开面板，新建任务首次轮询到 runId 时更新）
  const runIdEl = document.getElementById(`ia-${idx}-runid`);
  if (runIdEl && task?.runId && runIdEl.textContent !== task.runId) {
    runIdEl.textContent = task.runId;
  }
  const runIdHeadEl = document.getElementById(`ia-${idx}-runid-head`);
  if (runIdHeadEl && task?.runId && runIdHeadEl.textContent !== task.runId) {
    runIdHeadEl.textContent = task.runId;
  }

  const badge = document.getElementById(`ia-${idx}-badge`);
  if (badge) {
    badge.textContent = _IA_STAGE_LABELS[stage] || stage;
    badge.className = `badge-stage s-${stage}`;
  }

  const stageTxt = document.getElementById(`ia-${idx}-stage-txt`);
  if (stageTxt) {
    stageTxt.textContent = _IA_STAGE_LABELS[stage] || stage;
  }

  // 根据状态更新图标
  const iconEl = document.getElementById(`ia-${idx}-icon`);
  if (iconEl) {
    iconEl.textContent = _IA_STAGE_ICONS[stage] || '📋';
  }

  // AceHarness 实时阶段信息
  const phaseEl = document.getElementById(`ia-${idx}-phase`);
  if (phaseEl) {
    const phase = data?.currentPhase;
    const step = data?.currentStep;
    if (data?.queryUnavailable) {
      phaseEl.textContent = '状态查询暂不可用，正在重试；任务状态保留';
      phaseEl.style.display = 'block';
    } else if (phase || step) {
      phaseEl.textContent = `阶段: ${phase || '-'}  步骤: ${step || '-'}`;
      phaseEl.style.display = 'block';
    }
  }

  // 存储步骤数据；时间线已展开时实时刷新进度
  if (data?.aceharnessStatus?.stepLogs) {
    task.ahSteps = data.aceharnessStatus.stepLogs;
    const tlZone = document.getElementById(`ia-${idx}-timeline-zone`);
    if (tlZone && tlZone._loaded && !['issueanalysis_complete', 'failed', 'cancelled'].includes(stage)) {
      tlZone._loaded = false;
      _renderIaTimeline(idx);
    }
  }

  // 优先级徽章
  const priorityBadge = document.getElementById(`ia-${idx}-priority-badge`);
  if (priorityBadge && task?.priorityLevel) {
    const p = _IA_PRIORITY_LABELS[task.priorityLevel];
    if (p) {
      priorityBadge.textContent = `优先级: ${p.label}`;
      priorityBadge.style.cssText = `font-size:var(--font-size-xs);padding:2px 8px;border-radius:10px;background:${p.bg};color:${p.color};font-family:var(--mono);font-weight:600;flex-shrink:0`;
      priorityBadge.style.display = 'inline';
    }
  }

  // 摘要
  const summaryEl = document.getElementById(`ia-${idx}-summary`);
  if (summaryEl && task?.summary) {
    const truncated = task.summary.length > 120 ? task.summary.slice(0, 120) + '…' : task.summary;
    summaryEl.textContent = truncated;
    summaryEl.style.display = 'block';
  }

  // F01/F04/R06：归档完整度与验证状态透传——"完成"不得掩盖归档异常/验证受限
  const flagsEl = document.getElementById(`ia-${idx}-flags`);
  if (flagsEl) {
    const flags = _iaFlagsHtml(data?.metadata || task?.metadata);
    flagsEl.innerHTML = flags.html;
    flagsEl.style.display = flags.show ? 'flex' : 'none';
  }

  // 完成/失败后显示下载按钮 + 内嵌渲染诊断报告（无需跳页）
  // failed 也尝试拉报告：诊断结论为"无法诊断"时同样产出有效报告（如 Issue 内容不可见）
  const dlWrap = document.getElementById(`ia-${idx}-dl-wrap`);
  if (dlWrap && (stage === 'issueanalysis_complete' || stage === 'failed')) {
    dlWrap.style.display = 'flex';
    _renderIaReport(idx);
    _renderIaPatch(idx);
    _renderIaFeedback(idx);
  }

  // 有 workbenchUrl 时显示 AceHarness 工作台跳转按钮（不需要等完成）
  const workbenchLink = document.getElementById(`ia-${idx}-workbench-link`);
  if (workbenchLink) {
    const url = task?.workbenchUrl || data?.workbenchUrl;
    if (url) {
      workbenchLink.href = url;
      workbenchLink.style.display = 'inline-flex';
    }
  }

  // 失败时显示错误
  const errorEl = document.getElementById(`ia-${idx}-error`);
  if (errorEl && stage === 'failed') {
    errorEl.textContent = data?.error || '分析失败';
    errorEl.style.display = 'block';
  }

  // 卡片状态
  const card = document.getElementById(`ia-card-${idx}`);
  if (card) {
    const terminalStages = ['issueanalysis_complete', 'failed', 'cancelled'];
    if (terminalStages.includes(stage)) {
      card.classList.remove('running');
      if (stage === 'issueanalysis_complete') {
        card.classList.add('task-done');
      } else if (stage === 'failed') {
        card.classList.add('task-failed');
      } else {
        card.classList.add('task-cancelled');
      }
    }
  }

  // 完成后停止计时器，显示固定时长
  if (stage === 'issueanalysis_complete' && task) {
    _stopIaPolling(idx);
    if (task.startedAt && task.finishedAt) {
      const durationMs = new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime();
      const durationSec = Math.floor(Math.max(0, durationMs) / 1000);
      const elapsedEl = document.getElementById(`ia-${idx}-elapsed`);
      if (elapsedEl) {
        elapsedEl.textContent = durationSec < 60 ? `${durationSec}s` : `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;
        elapsedEl.style.display = 'inline';
      }
    }
  }
}

/* ── 错误提示 ── */
function _showIaErr(msg, isHtml = false) {
  const el = $('ia-error');
  el.style.display = 'block';
  if (isHtml) el.innerHTML = '错误：' + msg;
  else el.textContent = '错误：' + msg;
}
