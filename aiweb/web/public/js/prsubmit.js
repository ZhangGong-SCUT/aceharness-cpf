/* PR 提交：展示 ace pr 生成的草稿，确认后才创建 Issue 和 PR。 */

const _ps = {
  draftId: '',
  draft: null,
  repos: [],
  branches: [],
  branchesFor: '',
  branchError: '',
  bases: new Set(),
  issueMode: 'none',
  issuePick: null,
  preflight: null,
  preflightFor: '',
  confirming: false,
  confirmTimer: null,
  submitting: false,
  loading: false,
  diffs: new Map(),
  monitors: new Map(),
  lastDraftId: '',
  descriptionsLoading: false,
  descriptionValues: null,
  checks: new Map(),
  portNotes: new Map(),
  openGroups: new Set(),
};

const PS_AUTO_MONITOR_KEY = 'cpf-pr-submit-auto-monitor';

function _psEl(id) {
  return document.getElementById(id);
}

function _psDraftId() {
  return new URLSearchParams(location.search).get('draft') || '';
}

function _psError(text) {
  const el = _psEl('ps-error');
  if (!el) return;
  el.style.display = text ? '' : 'none';
  el.textContent = text || '';
}

function _psTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function _psRepoName(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || path || '';
}

async function loadPrSubmit(force = false) {
  const body = _psEl('ps-body');
  if (!body || _ps.loading) return;
  const id = _psDraftId();
  if (!id) {
    _ps.draftId = '';
    _ps.draft = null;
    _psError('');
    await _psRenderDraftPicker();
    return;
  }
  if (!force && _ps.draft && _ps.draftId === id) return;
  _ps.loading = true;
  _psError('');
  body.innerHTML = '<div class="ps-card ps-muted">正在读取草稿…</div>';
  try {
    const result = await authApi('GET', `/api/pr-submit/drafts/${encodeURIComponent(id)}`);
    if (result.status !== 200 || !result.data?.draft) {
      _psRenderLoadError(result.data?.message || '草稿读取失败');
      return;
    }
    Object.assign(_ps, {
      draftId: id,
      draft: result.data.draft,
      repos: [],
      branches: [],
      branchesFor: '',
      branchError: '',
      bases: new Set(),
      issueMode: 'none',
      issuePick: null,
      preflight: null,
      preflightFor: '',
      confirming: false,
      diffs: new Map(),
      descriptionsLoading: false,
      descriptionValues: null,
      monitors: new Map(),
      checks: new Map(),
      portNotes: new Map(),
    });
    _ps.descriptionValues = {
      title: _ps.draft.title || '', body: _ps.draft.body || '',
      issueTitle: '', issueBody: '',
    };
    _psRenderDraft();
    void _psGenerateDescriptions(false);
    _psLoadRepos();
  } catch (error) {
    _psRenderLoadError(error.message || '草稿读取失败');
  } finally {
    _ps.loading = false;
  }
}

function _psBackButton() {
  return '<button type="button" class="ps-back" data-ps-back>← 草稿列表</button>';
}

function _psBindBack(root) {
  root.querySelectorAll('[data-ps-back]').forEach((button) => button.addEventListener('click', _psBackToList));
}

function _psRenderLoadError(message) {
  const body = _psEl('ps-body');
  body.innerHTML = `${_psBackButton()}<div class="ps-card ps-note warn">${escHtml(message)}</div>`;
  _psBindBack(body);
}

function _psOpenDraft(id) {
  history.pushState({ psFromList: true }, '', `?draft=${encodeURIComponent(id)}#p-prsubmit`);
  loadPrSubmit(true);
}

function _psBackToList() {
  if (_ps.submitting) return;
  _ps.lastDraftId = _ps.draftId || _psDraftId();
  _psCancelConfirm();
  if (history.state?.psFromList) {
    history.back();
    return;
  }
  history.pushState(null, '', `${location.pathname}#p-prsubmit`);
  loadPrSubmit(true);
}

async function _psRenderDraftPicker() {
  const body = _psEl('ps-body');
  body.innerHTML = `
    <div class="ps-card">
      <h3>选择一份草稿</h3>
      <div class="ps-hint">在改完代码的仓库里运行 <code>ace pr</code>，会生成草稿并直接打开这里。也可以打开下面最近生成的草稿。同一个问题要改到其他分支、且需要按分支适配时，在原分支运行 <code>ace pr port &lt;目标分支&gt;</code>，产生的草稿会和原来的归在同一组。</div>
      <div id="ps-recent" class="ps-recent"><div class="ps-muted">正在读取最近的草稿…</div></div>
    </div>`;
  const slot = _psEl('ps-recent');
  try {
    const result = await authApi('GET', '/api/pr-submit/drafts');
    const drafts = result.data?.drafts || [];
    if (result.status !== 200) throw new Error(result.data?.message || '读取失败');
    if (!drafts.length) {
      slot.innerHTML = '<div class="ps-muted">还没有草稿。</div>';
      return;
    }
    slot.innerHTML = _psGroupDrafts(drafts).map(_psGroupHtml).join('');
    slot.querySelectorAll('.ps-recent-item').forEach((button) => button.addEventListener('click', () => _psOpenDraft(button.dataset.id)));
    slot.querySelectorAll('.ps-group-head').forEach((head) => head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') !== 'true';
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      head.parentElement.classList.toggle('open', open);
      head.nextElementSibling.hidden = !open;
      if (open) _ps.openGroups.add(head.dataset.group);
      else _ps.openGroups.delete(head.dataset.group);
    }));
    slot.querySelector('.ps-recent-item.last')?.scrollIntoView?.({ block: 'nearest' });
  } catch (error) {
    slot.innerHTML = `<div class="ps-note warn">${escHtml(error.message || '读取失败')}</div>`;
  }
}

/**
 * 同一个问题的草稿归成一组：ace pr / ace pr port 给分支记了组号；
 * 老草稿没有组号，按「仓库目录 + 分支」归组。列表已按时间倒序。
 */
function _psGroupDrafts(drafts) {
  const known = new Map();
  for (const item of drafts) {
    if (item.groupId) known.set(`${item.repoPath}#${item.headBranch}`, item.groupId);
  }
  const groups = new Map();
  for (const item of drafts) {
    const local = `${item.repoPath}#${item.headBranch}`;
    const key = item.groupId || known.get(local) || `local:${local}`;
    if (!groups.has(key)) groups.set(key, { key, drafts: [] });
    groups.get(key).drafts.push(item);
  }
  return [...groups.values()].map((group) => {
    const seen = new Set();
    for (const item of group.drafts) {
      const local = `${item.repoPath}#${item.headBranch}`;
      item.stale = seen.has(local);
      seen.add(local);
    }
    return group;
  });
}

function _psDraftState(item) {
  if (item.pulls) return `已创建 ${item.pulls} 个 PR`;
  return `${item.commits} 个 commit${item.dirty ? ' · 有未提交文件' : ''}`;
}

function _psDraftItem(item, inGroup) {
  const last = item.id === _ps.lastDraftId;
  const port = item.port ? `<span class="ps-tag port">移植自 ${escHtml(item.port.fromBranch)}</span>` : '';
  const target = inGroup && item.trackingBranch ? `→ ${item.trackingBranch} · ` : '';
  return `<button type="button" class="ps-recent-item${last ? ' last' : ''}${item.stale ? ' stale' : ''}" data-id="${escHtml(item.id)}">
    <span class="ps-recent-title">${escHtml(item.title || '(无标题)')}${port}${item.stale ? '<span class="ps-tag">较早的草稿</span>' : ''}${last ? '<span class="ps-tag">刚才查看</span>' : ''}</span>
    <span class="ps-recent-meta">${escHtml(_psRepoName(item.repoPath))} · ${escHtml(item.headBranch)} · ${escHtml(target)}${escHtml(_psDraftState(item))} · ${escHtml(_psTime(item.createdAt))}</span>
  </button>`;
}

function _psGroupChips(group) {
  const chips = [];
  for (const item of group.drafts.filter((d) => !d.stale)) {
    if (item.pullList?.length) {
      for (const pull of item.pullList) chips.push(`<span class="ps-gchip ok">${escHtml(pull.base)} · PR #${escHtml(pull.number)}</span>`);
    } else if (item.port) {
      chips.push(`<span class="ps-gchip ${item.port.verified ? 'ok' : 'warn'}">${escHtml(item.trackingBranch || item.headBranch)} · ${item.port.verified ? '已核对' : '待核对'}</span>`);
    } else {
      chips.push(`<span class="ps-gchip">${escHtml(item.trackingBranch || item.headBranch)} · 草稿</span>`);
    }
  }
  return chips.join('');
}

function _psGroupHtml(group) {
  if (group.drafts.length === 1) return _psDraftItem(group.drafts[0], false);
  const head = group.drafts.find((item) => !item.port) || group.drafts[0];
  const open = _ps.openGroups.has(group.key) || group.drafts.some((item) => item.id === _ps.lastDraftId);
  return `<div class="ps-group${open ? ' open' : ''}">
    <button type="button" class="ps-group-head" data-group="${escHtml(group.key)}" aria-expanded="${open}">
      <span class="ps-caret" aria-hidden="true">▸</span>
      <span class="ps-group-main">
        <span class="ps-recent-title">${escHtml(head.title || '(无标题)')}<span class="ps-tag">${group.drafts.length} 份草稿</span></span>
        <span class="ps-recent-meta">${escHtml(_psRepoName(head.repoPath))} · 最近 ${escHtml(_psTime(group.drafts[0].createdAt))}</span>
        <span class="ps-gchips">${_psGroupChips(group)}</span>
      </span>
    </button>
    <div class="ps-group-body"${open ? '' : ' hidden'}>${group.drafts.map((item) => _psDraftItem(item, true)).join('')}</div>
  </div>`;
}

function _psRenderDraft() {
  const d = _ps.draft;
  const body = _psEl('ps-body');
  const commits = d.commits || [];
  const files = d.files || [];
  const added = files.reduce((sum, item) => sum + (item.added || 0), 0);
  const removed = files.reduce((sum, item) => sum + (item.removed || 0), 0);
  const status = !commits.length
    ? '<span class="ps-status warn">没有新的 commit</span>'
    : '<span class="ps-status ok">可以提交</span>';
  const dirtyNote = d.dirty ? `
    <div class="ps-note warn">
      工作区还有 ${d.dirtyFiles?.length || 0} 个文件没有提交，它们不会进入 PR。如果其中有这次修复需要的文件，在终端重新运行 <code>ace pr</code> 选上它们。
      <details><summary>查看文件</summary><ul class="ps-plain">${(d.dirtyFiles || []).slice(0, 50).map((f) => `<li>${escHtml(f)}</li>`).join('')}</ul></details>
    </div>` : '';
  const noTracking = !d.trackingRef
    ? '<div class="ps-note warn">没有找到对比基准，无法判断这次要提交哪些 commit。在终端重新运行 <code>ace pr</code> 选择，或用 <code>ace pr --base origin/&lt;分支&gt;</code> 指定。</div>'
    : '';
  const baseLabel = { upstream: '跟踪分支', saved: '上次选择', chosen: '手动选择', auto: '自动选择' }[d.baseSource] || '';
  body.innerHTML = `
    <div class="ps-wrap">
      ${_psBackButton()}
      <section class="ps-card">
        <div class="ps-head">
          <div>
            <div class="ps-title">${escHtml(_psRepoName(d.repoPath))}</div>
            <div class="ps-sub" title="${escHtml(d.repoPath)}">${escHtml(d.repoPath)}</div>
          </div>
          ${status}
        </div>
        <div class="ps-row ps-meta">
          <span class="ps-tag">分支 ${escHtml(d.headBranch)}</span>
          ${d.port ? `<span class="ps-tag port" title="由 ace pr port 从 ${escHtml(d.port.fromBranch)} 移植过来">移植自 ${escHtml(d.port.fromBranch)}</span>` : ''}
          <span class="ps-tag" title="PR 只包含比它多出的 commit">${d.trackingRef ? `对比 ${escHtml(d.trackingRef)}${baseLabel ? `（${baseLabel}）` : ''}` : '没有对比基准'}</span>
          <span>${commits.length} 个 commit · ${files.length} 个文件 · <b class="ps-add">+${added}</b> <b class="ps-del">−${removed}</b></span>
          <span class="ps-aside">草稿 ${escHtml(d.id)} · ${escHtml(_psTime(d.createdAt))}</span>
        </div>
        ${dirtyNote}${noTracking}
        <details class="ps-details"${commits.length && commits.length <= 3 ? ' open' : ''}>
          <summary>本次改动</summary>
          <ul class="ps-plain ps-commits">${commits.map((c) => `<li><code>${escHtml(c.sha.slice(0, 8))}</code> ${escHtml(c.subject)}</li>`).join('') || '<li class="ps-muted">没有 commit</li>'}</ul>
          <div class="ps-row ps-files-head">
            <span class="ps-hint">点文件名查看 diff，再点一次收起</span>
            <button type="button" id="ps-diff-collapse" class="ps-link ps-aside" hidden>全部收起</button>
          </div>
          <div class="ps-files" id="ps-files">${files.map((f, index) => `
            <div class="ps-file-item">
              <button type="button" class="ps-file" data-index="${index}" aria-expanded="false">
                <span class="ps-caret" aria-hidden="true">▸</span>
                <span class="ps-file-path" title="${escHtml(f.path)}">${escHtml(f.path)}</span>
                <span class="ps-file-stat"><b class="ps-add">+${f.added}</b> <b class="ps-del">−${f.removed}</b></span>
              </button>
              <div class="ps-diff-slot" hidden></div>
            </div>`).join('')}</div>
        </details>
      </section>

      <div class="ps-cols">
      <div class="ps-col">
      <section class="ps-card">
        <h3><span class="ps-step">1</span>目标仓库</h3>
        <div id="ps-remote-chips" class="ps-row"></div>
        <div class="ps-row">
          <input id="ps-repo-search" class="ps-input ps-grow" placeholder="搜索仓库名" aria-label="搜索目标仓库" autocomplete="off" spellcheck="false">
          <span id="ps-repo-count" class="ps-aside"></span>
        </div>
        <select id="ps-repo" class="ps-input" aria-label="目标仓库"></select>
        <div id="ps-fork"></div>
      </section>

      <section class="ps-card">
        <h3><span class="ps-step">2</span>目标分支<span id="ps-base-count" class="ps-aside"></span></h3>
        <div class="ps-hint">每个目标分支单独开一个 PR。代码先推到你的 fork，不直接推上游。勾选其他分支会先预演移植，核对无误后才能提交。</div>
        <div id="ps-base-chips" class="ps-row"></div>
        <div id="ps-base-hint"></div>
        <input id="ps-branch-search" class="ps-input" placeholder="搜索分支，例如 3.41" aria-label="搜索目标分支" autocomplete="off" spellcheck="false">
        <div id="ps-branches" class="ps-list ps-branch-list" role="group" aria-label="目标分支"></div>
      </section>
      </div>

      <div class="ps-col">
      <section class="ps-card">
        <h3><span class="ps-step">3</span>关联 Issue<span class="ps-aside">可选</span></h3>
        <div class="ps-row ps-seg" role="radiogroup" aria-label="Issue">
          <button type="button" class="pr-chip" data-mode="none" role="radio">不关联</button>
          <button type="button" class="pr-chip" data-mode="existing" role="radio">关联已有 Issue</button>
          <button type="button" class="pr-chip" data-mode="create" role="radio">新建 Issue</button>
        </div>
        <div id="ps-issue-existing" hidden>
          <div class="ps-row">
            <input id="ps-issue-query" class="ps-input ps-grow" placeholder="Issue 编号、地址或标题关键字" aria-label="查找 Issue" autocomplete="off">
            <button type="button" id="ps-issue-find" class="btn btn-ghost">查找</button>
          </div>
          <div id="ps-issue-scope" class="ps-hint"></div>
          <div id="ps-issue-pick"></div>
          <div id="ps-issue-hits"></div>
        </div>
        <div id="ps-issue-create" hidden>
          <input id="ps-issue-title" class="ps-input" placeholder="Issue 标题" aria-label="Issue 标题">
          <textarea id="ps-issue-desc" class="ps-input" placeholder="问题现象、复现步骤和预期结果" aria-label="Issue 说明"></textarea>
          <div class="ps-hint">已根据 commit 和代码 diff 自动生成中文 Issue 草稿，可直接修改。新建 Issue 需要 GitCode 令牌的 Issue 权限为「读写」。</div>
          <button type="button" id="ps-issue-regenerate" class="ps-link">重新生成 Issue 和 PR 内容</button>
          <div id="ps-description-status" class="ps-hint" role="status"></div>
        </div>
      </section>

      <section class="ps-card">
        <h3><span class="ps-step">4</span>PR 内容</h3>
        <label class="ps-label" for="ps-title">标题 <span id="ps-title-count" class="ps-aside"></span></label>
        <input id="ps-title" class="ps-input" maxlength="200" value="${escHtml(d.title || '')}">
        <label class="ps-label" for="ps-body-text">说明</label>
        <textarea id="ps-body-text" class="ps-input ps-body-text">${escHtml(d.body || '')}</textarea>
        <div class="ps-row">
          <span class="ps-hint">根据 commit 和真实代码 diff 自动生成英文草稿；测试未执行时会明确标注，修改不会被自动覆盖。</span>
          <button type="button" id="ps-pr-regenerate" class="ps-link ps-aside">重新生成</button>
        </div>
        <div class="ps-hint">关联 Issue 后，末尾加上 <code>#编号</code>（GitCode 门禁靠它识别），创建成功后评论 <code>start build</code>。</div>
      </section>
      </div>
      </div>

      <section class="ps-card ps-port" id="ps-port" hidden>
        <h3>移植核对<span id="ps-port-count" class="ps-aside"></span></h3>
        <div class="ps-hint">不同分支的代码有差异，移植过去的改动不能照搬。逐个文件对照「源分支的改动」和「目标分支上的改动」，确认意图一致、并在目标分支上验证过，再点「确认移植无误」。核对结果绑定到具体 commit，代码再变需要重新核对。</div>
        <div id="ps-port-list"></div>
      </section>

      <section class="ps-card ps-confirm">
        <h3><span class="ps-step">5</span>确认提交</h3>
        <ul id="ps-plan" class="ps-plan"></ul>
        <ul id="ps-blockers" class="ps-blockers"></ul>
        <label class="ps-check">
          <input type="checkbox" id="ps-auto-monitor">
          <span>提交成功后，直接为新建的 PR 开启 PR 监控</span>
        </label>
        <div id="ps-monitor-hint" class="ps-hint" hidden></div>
        <div class="ps-row">
          <button type="button" id="ps-submit" class="btn btn-primary">确认提交</button>
          <button type="button" id="ps-cancel" class="btn btn-ghost" hidden>取消</button>
          <span id="ps-submit-hint" class="ps-aside"></span>
        </div>
        <div id="ps-result"></div>
      </section>
    </div>`;

  _psEl('ps-repo-search').addEventListener('input', _psFillRepoOptions);
  _psEl('ps-repo-search').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.target.value = ''; _psFillRepoOptions(); }
  });
  _psEl('ps-repo').addEventListener('change', () => _psSetRepo(_psEl('ps-repo').value));
  _psEl('ps-branch-search').addEventListener('input', _psFillBranches);
  _psEl('ps-branch-search').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.target.value = ''; _psFillBranches(); }
  });
  document.querySelectorAll('.ps-seg [data-mode]').forEach((button) => button.addEventListener('click', () => {
    _ps.issueMode = button.dataset.mode;
    _psRenderIssue();
    _psRenderConfirm();
    if (_ps.issueMode === 'existing' && !_ps.issuePick && !_psEl('ps-issue-hits').innerHTML) _psFindIssues();
  }));
  _psEl('ps-issue-find').addEventListener('click', _psFindIssues);
  for (const id of ['ps-issue-regenerate', 'ps-pr-regenerate']) {
    _psEl(id).addEventListener('click', () => _psGenerateDescriptions(true));
  }
  _psEl('ps-issue-query').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); _psFindIssues(); }
  });
  for (const id of ['ps-issue-query', 'ps-issue-title', 'ps-title', 'ps-body-text', 'ps-issue-desc']) {
    _psEl(id).addEventListener('input', _psRenderConfirm);
  }
  _psBindBack(body);
  _psEl('ps-submit').addEventListener('click', _psSubmit);
  _psEl('ps-cancel').addEventListener('click', _psCancelConfirm);
  _psEl('ps-files').querySelectorAll('.ps-file').forEach((button) => button.addEventListener('click', () => _psToggleDiff(button)));
  _psEl('ps-diff-collapse').addEventListener('click', _psCollapseDiffs);
  const autoMonitor = _psEl('ps-auto-monitor');
  autoMonitor.checked = _psAutoMonitorSaved();
  autoMonitor.addEventListener('change', () => {
    try { localStorage.setItem(PS_AUTO_MONITOR_KEY, autoMonitor.checked ? '1' : '0'); } catch { /* 隐私模式 */ }
    _psRenderConfirm();
  });
  _psRenderRemoteChips();
  _psRenderIssue();
  _psRenderBases();
  _psRenderConfirm();
  _psRenderResults();
}

/**
 * 初次生成直接填入；手动重新生成时若用户已经改过，先让用户明确选择是否覆盖。
 * 生成期间的编辑原样保留，避免慢请求覆盖用户刚输入的内容。
 */
async function _psGenerateDescriptions(manual) {
  if (!_ps.draft?.commits?.length || _ps.descriptionsLoading) return;
  const draftId = _ps.draftId;
  const fields = {
    title: _psEl('ps-title'), body: _psEl('ps-body-text'),
    issueTitle: _psEl('ps-issue-title'), issueBody: _psEl('ps-issue-desc'),
  };
  const original = manual ? (_ps.descriptionValues || {
    title: _ps.draft.title || '', body: _ps.draft.body || '',
    issueTitle: '', issueBody: '',
  }) : _ps.descriptionValues;
  const current = Object.fromEntries(Object.entries(fields).map(([key, el]) => [key, el?.value || '']));
  const edited = manual && Object.entries(original).some(([key, value]) => current[key] !== value);
  if (edited && !window.confirm('重新生成会覆盖已经修改的 Issue 和 PR 标题、正文。确定重新生成吗？')) return;
  _ps.descriptionsLoading = true;
  for (const id of ['ps-issue-regenerate', 'ps-pr-regenerate']) {
    const button = _psEl(id);
    if (button) { button.disabled = true; button.textContent = '正在生成…'; }
  }
  const status = _psEl('ps-description-status');
  if (status) status.textContent = '正在读取真实代码 diff，按 Issue 和 PR 模板生成描述…';
  try {
    const result = await authApi('POST', `/api/pr-submit/drafts/${encodeURIComponent(draftId)}/descriptions`, {}, 120000);
    if (draftId !== _ps.draftId) return;
    if (result.status !== 200) throw new Error(result.data?.message || '生成失败');
    const generated = result.data;
    const values = {
      title: generated.pr?.title || generated.title || _ps.draft.title || '',
      body: generated.pr?.body || '',
      issueTitle: generated.issue?.title || generated.pr?.title || _ps.draft.title || '',
      issueBody: generated.issue?.body || '',
    };
    for (const [key, el] of Object.entries(fields)) {
      const latest = el?.value || '';
      if (el && current[key] === original[key] && latest === original[key]) el.value = values[key];
    }
    _ps.descriptionValues = { ...values };
    if (status) status.textContent = `${generated.warning || '已生成，可直接修改；提交前请核对问题描述和实际验证结果。'}${generated.truncated ? ' 代码 diff 较大，仅使用部分内容辅助生成。' : ''}`;
    _psRenderConfirm();
  } catch (error) {
    if (status && draftId === _ps.draftId) status.textContent = `${error.message || '生成失败'}。可以继续手动填写，或稍后重试。`;
  } finally {
    if (draftId === _ps.draftId) {
      _ps.descriptionsLoading = false;
      for (const [id, label] of [['ps-issue-regenerate', '重新生成 Issue 和 PR 内容'], ['ps-pr-regenerate', '重新生成']]) {
        const button = _psEl(id);
        if (button) { button.disabled = false; button.textContent = label; }
      }
    }
  }
}

function _psDiffHtml(text, truncated) {
  if (!text.trim()) return '<div class="ps-muted ps-pad">没有文本差异（可能只改了文件权限）</div>';
  let oldLine = 0;
  let newLine = 0;
  const rows = [];
  for (const line of text.split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push(`<div class="ps-dl hunk"><span class="ps-ln"></span><span class="ps-ln"></span><span class="ps-code">${escHtml(line)}</span></div>`);
    } else if (/^Binary files /.test(line)) {
      rows.push('<div class="ps-dl meta"><span class="ps-ln"></span><span class="ps-ln"></span><span class="ps-code">二进制文件，不显示内容</span></div>');
    } else if (line.startsWith('+')) {
      rows.push(`<div class="ps-dl add"><span class="ps-ln"></span><span class="ps-ln">${newLine++}</span><span class="ps-code">${escHtml(line)}</span></div>`);
    } else if (line.startsWith('-')) {
      rows.push(`<div class="ps-dl del"><span class="ps-ln">${oldLine++}</span><span class="ps-ln"></span><span class="ps-code">${escHtml(line)}</span></div>`);
    } else if (line.startsWith(' ')) {
      rows.push(`<div class="ps-dl"><span class="ps-ln">${oldLine++}</span><span class="ps-ln">${newLine++}</span><span class="ps-code">${escHtml(line)}</span></div>`);
    } else if (line && !line.startsWith('\\')) {
      rows.push(`<div class="ps-dl meta"><span class="ps-ln"></span><span class="ps-ln"></span><span class="ps-code">${escHtml(line)}</span></div>`);
    }
  }
  const more = truncated ? '<div class="ps-note warn">diff 太长，只显示前 300 KB，完整内容请在本地用 git diff 查看。</div>' : '';
  return `<div class="ps-diff">${rows.join('')}</div>${more}`;
}

function _psSyncCollapseAll() {
  const any = Boolean(document.querySelector('#ps-files .ps-file[aria-expanded="true"]'));
  const button = _psEl('ps-diff-collapse');
  if (button) button.hidden = !any;
}

function _psCloseDiff(button) {
  button.setAttribute('aria-expanded', 'false');
  button.closest('.ps-file-item')?.classList.remove('open');
  const slot = button.nextElementSibling;
  if (slot) { slot.hidden = true; slot.innerHTML = ''; }
}

function _psCollapseDiffs() {
  document.querySelectorAll('#ps-files .ps-file[aria-expanded="true"]').forEach(_psCloseDiff);
  _psSyncCollapseAll();
}

async function _psToggleDiff(button) {
  const file = _ps.draft?.files?.[Number(button.dataset.index)];
  const slot = button.nextElementSibling;
  if (!file || !slot) return;
  if (button.getAttribute('aria-expanded') === 'true') {
    _psCloseDiff(button);
    _psSyncCollapseAll();
    return;
  }
  button.setAttribute('aria-expanded', 'true');
  button.closest('.ps-file-item')?.classList.add('open');
  slot.hidden = false;
  _psSyncCollapseAll();
  let cached = _ps.diffs.get(file.path);
  if (!cached) {
    slot.innerHTML = '<div class="ps-muted ps-pad">正在读取 diff…</div>';
    const draftId = _ps.draftId;
    try {
      const result = await authApi('GET', `/api/pr-submit/drafts/${encodeURIComponent(draftId)}/diff?path=${encodeURIComponent(file.path)}`);
      if (result.status !== 200) throw new Error(result.data?.message || 'diff 读取失败');
      cached = { diff: result.data.diff || '', truncated: Boolean(result.data.truncated) };
      if (draftId === _ps.draftId) _ps.diffs.set(file.path, cached);
    } catch (error) {
      if (button.getAttribute('aria-expanded') === 'true') {
        slot.innerHTML = `<div class="ps-note warn">${escHtml(error.message || 'diff 读取失败')}</div>`;
      }
      return;
    }
  }
  if (button.getAttribute('aria-expanded') === 'true') slot.innerHTML = _psDiffHtml(cached.diff, cached.truncated);
}

function _psSelectedRepo() {
  return _psEl('ps-repo')?.value || '';
}

async function _psLoadRepos() {
  const count = _psEl('ps-repo-count');
  try {
    const result = await authApi('GET', '/api/pr-submit/repos');
    if (result.status !== 200) throw new Error(result.data?.message || '仓库列表读取失败');
    _ps.repos = result.data.repos || [];
  } catch (error) {
    _ps.repos = [];
    if (count) count.textContent = error.message || '仓库列表读取失败';
  }
  for (const remote of [...(_ps.draft?.remotes || [])].reverse()) {
    const full = `${remote.owner}/${remote.repo}`;
    if (!_ps.repos.some((repo) => repo.toLowerCase() === full.toLowerCase())) _ps.repos.unshift(full);
  }
  _psFillRepoOptions();
  const initial = _ps.draft?.suggestedTarget || '';
  if (initial) _psSetRepo(initial);
  else _psRenderConfirm();
}

function _psRenderRemoteChips() {
  const slot = _psEl('ps-remote-chips');
  if (!slot) return;
  const remotes = _ps.draft?.remotes || [];
  if (!remotes.length) {
    slot.innerHTML = '<span class="ps-hint">本地仓库没有可识别的 GitCode 远程，请在下面选择目标仓库。</span>';
    return;
  }
  const current = _psSelectedRepo().toLowerCase();
  slot.innerHTML = '<span class="ps-hint">本地远程：</span>' + remotes.map((remote) => {
    const full = `${remote.owner}/${remote.repo}`;
    return `<button type="button" class="pr-chip${full.toLowerCase() === current ? ' active' : ''}" data-repo="${escHtml(full)}">${escHtml(remote.name)} · ${escHtml(full)}</button>`;
  }).join('');
  slot.querySelectorAll('[data-repo]').forEach((button) => button.addEventListener('click', () => _psSetRepo(button.dataset.repo)));
}

function _psFillRepoOptions() {
  const select = _psEl('ps-repo');
  if (!select) return;
  const query = (_psEl('ps-repo-search')?.value || '').trim().toLowerCase();
  const current = select.value;
  const matched = query ? _ps.repos.filter((repo) => repo.toLowerCase().includes(query)) : _ps.repos.slice();
  const pinned = current && !matched.includes(current) ? [current] : [];
  select.innerHTML = '<option value="">请选择目标仓库</option>'
    + pinned.map((repo) => `<option value="${escHtml(repo)}">${escHtml(repo)}（当前）</option>`).join('')
    + matched.map((repo) => `<option value="${escHtml(repo)}">${escHtml(repo)}</option>`).join('');
  if (current) select.value = current;
  const count = _psEl('ps-repo-count');
  if (count && _ps.repos.length) count.textContent = query ? `匹配 ${matched.length} / ${_ps.repos.length}` : `共 ${_ps.repos.length} 个`;
}

function _psSetRepo(repo) {
  const select = _psEl('ps-repo');
  if (!select) return;
  if (repo && !_ps.repos.includes(repo)) _ps.repos.unshift(repo);
  select.value = repo || '';
  if (select.value !== (repo || '')) {
    select.insertAdjacentHTML('beforeend', `<option value="${escHtml(repo)}">${escHtml(repo)}</option>`);
    select.value = repo;
  }
  _psFillRepoOptions();
  _ps.bases = new Set();
  _ps.checks = new Map();
  _ps.issuePick = null;
  _ps.preflight = null;
  _psCancelConfirm();
  _psRenderRemoteChips();
  _psRenderIssue();
  const hits = _psEl('ps-issue-hits');
  if (hits) hits.innerHTML = '';
  if (_ps.issueMode === 'existing') _psFindIssues();
  _psLoadBranches();
  _psLoadPreflight();
}

async function _psLoadPreflight() {
  const repo = _psSelectedRepo();
  const slot = _psEl('ps-fork');
  _ps.preflightFor = repo;
  if (!slot) return;
  if (!repo) { slot.innerHTML = ''; _psRenderConfirm(); return; }
  if (_psProjectMismatch()) {
    _ps.preflight = null;
    _psRenderFork();
    _psRenderConfirm();
    return;
  }
  slot.innerHTML = '<div class="ps-note">正在检查推送用的 fork…</div>';
  try {
    const result = await authApi('GET', `/api/pr-submit/drafts/${encodeURIComponent(_ps.draftId)}/preflight?repo=${encodeURIComponent(repo)}`);
    if (_ps.preflightFor !== repo) return;
    if (result.status !== 200) throw new Error(result.data?.message || '检查失败');
    _ps.preflight = result.data;
  } catch (error) {
    if (_ps.preflightFor !== repo) return;
    _ps.preflight = { error: error.message || '检查失败' };
  }
  _psRenderFork();
  _psRenderConfirm();
}

/** 本地仓库的远程里没有同名仓库，说明草稿和目标仓库不是同一个项目。 */
function _psProjectMismatch() {
  const repoName = (_psSelectedRepo().split('/')[1] || '').toLowerCase();
  const remotes = (_ps.draft?.remotes || []).filter((item) => item.repo);
  return Boolean(repoName && remotes.length && !remotes.some((item) => item.repo.toLowerCase() === repoName));
}

function _psRenderFork() {
  const slot = _psEl('ps-fork');
  const pre = _ps.preflight;
  if (!slot || (!pre && !_psProjectMismatch())) return;
  const repoName = _psSelectedRepo().split('/')[1] || '';
  if (_psProjectMismatch()) {
    const local = _psRepoName(_ps.draft.repoPath);
    const remotes = _ps.draft.remotes.filter((item) => item.repo)
      .map((item) => `<code>${escHtml(item.name)}</code> → ${escHtml(item.owner)}/${escHtml(item.repo)}`).join('、');
    slot.innerHTML = `<div class="ps-note warn">这份草稿来自本地仓库 <b>${escHtml(local)}</b>（远程：${remotes}），和 <code>${escHtml(repoName)}</code> 不是同一个项目，不能提交到这里。要给 <b>${escHtml(_psSelectedRepo())}</b> 提 PR，请在对应的本地仓库目录里运行 <code>ace pr</code>，或回到草稿列表打开那份草稿。</div>`;
  } else if (pre.error) {
    slot.innerHTML = `<div class="ps-note warn">${escHtml(pre.error)}</div>`;
  } else if (!pre.tokenConfigured) {
    slot.innerHTML = '<div class="ps-note warn">还没有绑定 GitCode 令牌。到「PR 监控」页点「🔑 令牌」绑定后再提交。</div>';
  } else if (!pre.fork) {
    slot.innerHTML = `<div class="ps-note warn">本地仓库 <b>${escHtml(_psRepoName(_ps.draft?.repoPath))}</b> 没有 ${escHtml(pre.login)} 名下的 <code>${escHtml(repoName)}</code> fork 远程。先在 GitCode 上 fork，再执行 <code>git remote add fork https://gitcode.com/${escHtml(pre.login)}/${escHtml(repoName)}.git</code>，然后重新运行 <code>ace pr</code>。</div>`;
  } else if (`${pre.fork.owner}/${pre.fork.repo}`.toLowerCase() === _psSelectedRepo().toLowerCase()) {
    slot.innerHTML = `<div class="ps-note ok">目标仓库就是你自己的仓库，提交分支直接推到 <b>${escHtml(pre.fork.owner)}/${escHtml(pre.fork.repo)}</b>（本地远程 ${escHtml(pre.fork.name)}）。</div>`;
  } else {
    slot.innerHTML = `<div class="ps-note ok">推送到 fork <b>${escHtml(pre.fork.owner)}/${escHtml(pre.fork.repo)}</b>（本地远程 ${escHtml(pre.fork.name)}），以 ${escHtml(pre.login)} 的身份创建 PR。</div>`;
  }
}

async function _psLoadBranches() {
  const box = _psEl('ps-branches');
  const repo = _psSelectedRepo();
  _ps.branchesFor = repo;
  _ps.branches = [];
  _ps.branchError = '';
  if (!box) return;
  if (!repo) {
    box.innerHTML = '<div class="ps-muted ps-pad">先选择目标仓库</div>';
    _psRenderBases();
    _psRenderConfirm();
    return;
  }
  box.innerHTML = '<div class="ps-muted ps-pad">正在读取分支…</div>';
  try {
    const result = await authApi('GET', `/api/pr-submit/branches?repo=${encodeURIComponent(repo)}`);
    if (_ps.branchesFor !== repo) return;
    if (result.status !== 200) throw new Error(result.data?.message || '分支读取失败');
    const tracking = _ps.draft?.trackingBranch || '';
    const names = result.data.branches || [];
    _ps.branches = tracking && names.includes(tracking) ? [tracking, ...names.filter((name) => name !== tracking)] : names;
    if (tracking && names.includes(tracking)) _ps.bases.add(tracking);
  } catch (error) {
    if (_ps.branchesFor !== repo) return;
    _ps.branchError = error.message || '分支读取失败';
  }
  _psFillBranches();
  _psRenderBases();
  _psRenderConfirm();
}

function _psFillBranches() {
  const box = _psEl('ps-branches');
  if (!box) return;
  if (_ps.branchError) { box.innerHTML = `<div class="ps-note warn">${escHtml(_ps.branchError)}</div>`; return; }
  if (!_ps.branches.length) { box.innerHTML = '<div class="ps-muted ps-pad">这个仓库没有返回分支</div>'; return; }
  const query = (_psEl('ps-branch-search')?.value || '').trim().toLowerCase();
  const tracking = _ps.draft?.trackingBranch || '';
  const shown = _ps.branches.filter((name) => !query || name.toLowerCase().includes(query));
  if (!shown.length) { box.innerHTML = '<div class="ps-muted ps-pad">没有匹配的分支</div>'; return; }
  box.innerHTML = shown.map((name) => `
    <label class="ps-option${_ps.bases.has(name) ? ' selected' : ''}">
      <input type="checkbox" value="${escHtml(name)}"${_ps.bases.has(name) ? ' checked' : ''}>
      <span class="ps-grow">${escHtml(name)}</span>
      ${name === tracking ? '<span class="ps-tag">跟踪分支</span>' : ''}
    </label>`).join('');
  box.querySelectorAll('input[type="checkbox"]').forEach((input) => input.addEventListener('change', () => {
    if (input.checked) _ps.bases.add(input.value);
    else _ps.bases.delete(input.value);
    input.closest('.ps-option')?.classList.toggle('selected', input.checked);
    _psRenderBases();
    _psRenderConfirm();
  }));
}

function _psRenderBases() {
  const chips = _psEl('ps-base-chips');
  const count = _psEl('ps-base-count');
  const hint = _psEl('ps-base-hint');
  if (!chips) return;
  const bases = [..._ps.bases];
  chips.innerHTML = bases.length
    ? bases.map((name) => `<span class="ps-chip">${escHtml(name)}<button type="button" aria-label="移除 ${escHtml(name)}" data-base="${escHtml(name)}">×</button></span>`).join('')
    : '<span class="ps-muted">还没有选择目标分支</span>';
  chips.querySelectorAll('[data-base]').forEach((button) => button.addEventListener('click', () => {
    _ps.bases.delete(button.dataset.base);
    _psFillBranches();
    _psRenderBases();
    _psRenderConfirm();
  }));
  if (count) count.textContent = bases.length ? `已选 ${bases.length} 个 · 将创建 ${bases.length} 个 PR` : '';
  const tracking = _ps.draft?.trackingBranch || '';
  if (hint) {
    hint.innerHTML = tracking && _ps.branches.length && !_ps.branches.includes(tracking)
      ? `<div class="ps-note">当前跟踪的 <code>${escHtml(tracking)}</code> 不在这个仓库里，请手动选择目标分支。</div>`
      : '';
  }
  _psSyncPort();
}

function _psRenderIssue() {
  document.querySelectorAll('.ps-seg [data-mode]').forEach((button) => {
    const on = button.dataset.mode === _ps.issueMode;
    button.classList.toggle('active', on);
    button.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  const existing = _psEl('ps-issue-existing');
  const create = _psEl('ps-issue-create');
  if (existing) existing.hidden = _ps.issueMode !== 'existing';
  if (create) create.hidden = _ps.issueMode !== 'create';
  const pick = _psEl('ps-issue-pick');
  if (pick) {
    pick.innerHTML = _ps.issuePick
      ? `<div class="ps-note ok">已选择 <a href="${escHtml(_ps.issuePick.url)}" target="_blank" rel="noopener noreferrer">#${escHtml(_ps.issuePick.number)}</a> ${escHtml(_ps.issuePick.title)} ${_psIssueState(_ps.issuePick)} <button type="button" class="ps-link" id="ps-issue-clear">换一个</button></div>`
      : '';
    _psEl('ps-issue-clear')?.addEventListener('click', () => { _ps.issuePick = null; _psRenderIssue(); _psRenderConfirm(); });
  }
}

function _psIssueState(issue) {
  return issue.state && issue.state !== 'open' ? '<span class="ps-tag">已关闭</span>' : '';
}

async function _psFindIssues() {
  const hits = _psEl('ps-issue-hits');
  const scope = _psEl('ps-issue-scope');
  const repo = _psSelectedRepo();
  const query = (_psEl('ps-issue-query')?.value || '').trim();
  if (!hits) return;
  if (!repo) { hits.innerHTML = '<div class="ps-note warn">先选择目标仓库</div>'; return; }
  hits.innerHTML = '<div class="ps-muted">正在查找…</div>';
  try {
    const result = await authApi('GET', `/api/pr-submit/issues?repo=${encodeURIComponent(repo)}&q=${encodeURIComponent(query)}`);
    if (repo !== _psSelectedRepo()) return;
    if (result.status !== 200) throw new Error(result.data?.message || '查找失败');
    const issues = result.data.issues || [];
    if (scope) scope.textContent = result.data.login ? `只显示 ${result.data.login} 在 ${repo} 创建的 Issue` : '';
    if (!issues.length) {
      hits.innerHTML = result.data.hidden
        ? `<div class="ps-note warn">${escHtml(/^\d+$/.test(query) ? `#${query}` : query)} 不是你创建的 Issue，不能关联。</div>`
        : `<div class="ps-muted">${query ? '没有匹配的 Issue' : '你在这个仓库还没有创建过 Issue，可以改选「新建 Issue」'}</div>`;
      return;
    }
    hits.innerHTML = `<div class="ps-list">${issues.map((issue, index) => `
      <button type="button" class="ps-option ps-issue-hit" data-index="${index}">
        <span class="ps-tag">#${escHtml(issue.number)}</span><span class="ps-grow">${escHtml(issue.title)}</span>${_psIssueState(issue)}
      </button>`).join('')}</div>`;
    hits.querySelectorAll('.ps-issue-hit').forEach((button) => button.addEventListener('click', () => {
      _ps.issuePick = issues[Number(button.dataset.index)];
      hits.innerHTML = '';
      _psRenderIssue();
      _psRenderConfirm();
    }));
  } catch (error) {
    hits.innerHTML = `<div class="ps-note warn">${escHtml(error.message || '查找失败')}</div>`;
  }
}

function _psPending() {
  const done = new Set((_ps.draft?.results?.pulls || []).filter((item) => item.url).map((item) => item.base));
  return [..._ps.bases].filter((base) => !done.has(base));
}

/** 需要移植核对的目标分支：草稿自己的基准分支（仅移植草稿）和其他所有分支。 */
function _psPortEntries() {
  const d = _ps.draft;
  if (!d?.commits?.length || !_psSelectedRepo() || _psProjectMismatch()) return [];
  return _psPending()
    .filter((base) => base !== d.trackingBranch || d.port)
    .map((base) => ({ base, kind: base === d.trackingBranch ? 'port' : 'pick' }));
}

function _psPortFrom(entry) {
  const d = _ps.draft;
  return entry.kind === 'port' ? d.port.fromBranch : (d.trackingBranch || d.headBranch);
}

function _psSyncPort() {
  for (const entry of _psPortEntries()) {
    if (!_ps.checks.has(entry.base)) _psLoadPortEntry(entry);
  }
  _psRenderPort();
}

async function _psLoadPortEntry(entry, refresh = false) {
  const { base, kind } = entry;
  const draftId = _ps.draftId;
  const repo = _psSelectedRepo();
  const set = (value) => {
    if (draftId !== _ps.draftId || repo !== _psSelectedRepo()) return;
    _ps.checks.set(base, { kind, ...value });
    _psRenderPort();
    _psRenderConfirm();
  };
  const api = `/api/pr-submit/drafts/${encodeURIComponent(draftId)}`;
  try {
    if (kind === 'pick') {
      let preview = _ps.draft.previews?.[base];
      if (refresh || !preview || preview.target !== repo) {
        set({ state: 'previewing' });
        const result = await authApi('POST', `${api}/preview`, { repo, base }, 180000);
        if (result.status !== 200 || !result.data?.preview) throw new Error(result.data?.message || '预演失败');
        preview = result.data.preview;
        if (draftId === _ps.draftId) _ps.draft.previews = { ...(_ps.draft.previews || {}), [base]: preview };
      }
      if (!preview.ok) return set({ state: 'conflict', preview });
      if (preview.empty) return set({ state: 'empty', preview });
    }
    set({ state: 'checking' });
    const result = await authApi('GET', `${api}/port-check${kind === 'pick' ? `?base=${encodeURIComponent(base)}` : ''}`);
    if (result.status !== 200 || !result.data?.check) throw new Error(result.data?.message || '移植核对读取失败');
    set({ state: 'ready', check: result.data.check });
  } catch (error) {
    set({ state: 'error', message: error.message || '移植核对读取失败' });
  }
}

const PS_PORT_STATUS = {
  missing: ['err', '目标分支没改'],
  extra: ['warn', '目标分支多改'],
  adapted: ['warn', '有适配'],
  same: ['ok', '一致'],
};

function _psPortSection(entry) {
  const item = _ps.checks.get(entry.base) || { state: 'previewing' };
  const from = _psPortFrom(entry);
  const base = escHtml(entry.base);
  const retry = `<button type="button" class="btn btn-ghost" data-act="retry" data-base="${base}">重新预演</button>`;
  const drop = `<button type="button" class="btn btn-ghost" data-act="drop" data-base="${base}">不提交这个分支</button>`;
  let status = '';
  let body = '';
  if (item.state === 'previewing') {
    status = '<span class="ps-muted">正在预演…</span>';
    body = `<div class="ps-hint">在 ${base} 的最新代码上预演 cherry-pick，不会改动你的工作区。</div>`;
  } else if (item.state === 'checking') {
    status = '<span class="ps-muted">正在对比…</span>';
  } else if (item.state === 'error') {
    status = '<span class="ps-status err">出错</span>';
    body = `<div class="ps-note warn">${escHtml(item.message)}</div><div class="ps-row">${entry.kind === 'pick' ? retry : `<button type="button" class="btn btn-ghost" data-act="reload" data-base="${base}">重试</button>`}</div>`;
  } else if (item.state === 'conflict') {
    const p = item.preview;
    const files = p.conflicts.length ? `：${p.conflicts.map((f) => `<code>${escHtml(f)}</code>`).join('、')}` : `（${escHtml(p.reason)}）`;
    status = '<span class="ps-status err">有冲突</span>';
    body = `<div class="ps-note warn">在 commit <code>${escHtml((p.conflictCommit || '').slice(0, 8))}</code> 上无法自动移植${files}。网页上不能解决冲突：在本地仓库运行 <code>ace pr port ${base}</code>，会在独立目录里检出 ${base} 并停在冲突上；解决、适配并验证后在那个目录运行 <code>ace pr</code>，新草稿会和这份归到同一组。</div>
      <div class="ps-row">${drop}${retry}</div>`;
  } else if (item.state === 'empty') {
    status = '<span class="ps-status ok">已包含</span>';
    body = `<div class="ps-note">${base} 已经包含这些改动，不需要再提 PR。</div><div class="ps-row">${drop}</div>`;
  } else {
    const check = item.check;
    const s = check.summary;
    const verified = check.verification;
    const differs = s.adapted + s.missing + s.extra;
    status = verified ? '<span class="ps-status ok">已核对</span>' : '<span class="ps-status warn">待核对</span>';
    const counts = Object.entries(PS_PORT_STATUS)
      .filter(([key]) => s[key])
      .map(([key, [tone, label]]) => `<span class="ps-pstat ${tone}">${label} ${s[key]}</span>`).join('');
    const files = check.files.map((file, index) => {
      const [tone, label] = PS_PORT_STATUS[file.status];
      return `<div class="ps-pf-item">
        <button type="button" class="ps-pf" data-base="${base}" data-index="${index}" aria-expanded="false">
          <span class="ps-caret" aria-hidden="true">▸</span>
          <span class="ps-file-path" title="${escHtml(file.path)}">${escHtml(file.path)}</span>
          <span class="ps-pstat ${tone}">${label}</span>
        </button>
        <div class="ps-pf-body" hidden></div>
      </div>`;
    }).join('');
    const missingHint = s.missing
      ? '<div class="ps-hint">「目标分支没改」：源分支改了这个文件，目标分支上没有对应改动。可能是目标分支已有这段代码，也可能是漏改了。</div>'
      : '';
    const note = _ps.portNotes.get(check.key) || '';
    const verify = verified
      ? `<div class="ps-note ok">已核对${verified.by ? ` · ${escHtml(verified.by)}` : ''} · ${escHtml(_psTime(verified.at))}${verified.note ? ` · ${escHtml(verified.note)}` : ''}</div>${entry.kind === 'pick' ? `<div class="ps-row">${retry}</div>` : ''}`
      : `<textarea class="ps-input ps-port-note" data-base="${base}" aria-label="${base} 核对说明" placeholder="${differs
        ? `有 ${differs} 个文件和源分支不一致，写一句说明（必填），例如：3.41 上接口改名为 systemLocale，已编译验证`
        : '可选：怎么验证的，例如：已在目标分支编译并跑过相关用例'}">${escHtml(note)}</textarea>
        <div class="ps-row">
          <button type="button" class="btn btn-primary" data-act="verify" data-base="${base}"${(differs && !note.trim()) || item.saving ? ' disabled' : ''}>${item.saving ? '正在保存…' : '确认移植无误'}</button>
          ${entry.kind === 'pick' ? retry : ''}
          ${item.verifyError ? `<span class="ps-err-text">${escHtml(item.verifyError)}</span>` : ''}
        </div>`;
    body = `<div class="ps-row ps-pstats">${counts || '<span class="ps-muted">两边都没有文件改动</span>'}</div>
      <div class="ps-pfiles">${files}</div>${missingHint}${verify}`;
  }
  return `<div class="ps-port-entry" data-base="${base}">
    <div class="ps-port-head"><span><code>${escHtml(from)}</code> → <code>${base}</code></span>${entry.kind === 'port' ? '<span class="ps-tag port">ace pr port 移植</span>' : '<span class="ps-tag">自动 cherry-pick</span>'}<span class="ps-grow"></span>${status}</div>
    ${body}
  </div>`;
}

function _psRenderPort() {
  const card = _psEl('ps-port');
  const list = _psEl('ps-port-list');
  if (!card || !list) return;
  const entries = _psPortEntries();
  card.hidden = !entries.length;
  if (!entries.length) { list.innerHTML = ''; return; }
  const open = [...list.querySelectorAll('.ps-pf[aria-expanded="true"]')].map((b) => `${b.dataset.base}\n${b.dataset.index}`);
  const typing = list.contains(document.activeElement) && document.activeElement.matches('.ps-port-note')
    ? { base: document.activeElement.dataset.base, at: document.activeElement.selectionStart }
    : null;
  const done = entries.filter((entry) => _ps.checks.get(entry.base)?.check?.verification).length;
  const count = _psEl('ps-port-count');
  if (count) count.textContent = `已核对 ${done} / ${entries.length}`;
  list.innerHTML = entries.map(_psPortSection).join('');
  list.querySelectorAll('.ps-pf').forEach((button) => {
    button.addEventListener('click', () => _psTogglePortFile(button));
    if (open.includes(`${button.dataset.base}\n${button.dataset.index}`)) _psTogglePortFile(button);
  });
  list.querySelectorAll('.ps-port-note').forEach((area) => area.addEventListener('input', () => {
    const item = _ps.checks.get(area.dataset.base);
    if (!item?.check) return;
    _ps.portNotes.set(item.check.key, area.value);
    const differs = item.check.summary.adapted + item.check.summary.missing + item.check.summary.extra;
    const button = area.parentElement.querySelector('[data-act="verify"]');
    if (button && !item.saving) button.disabled = Boolean(differs) && !area.value.trim();
  }));
  if (typing) {
    const area = [...list.querySelectorAll('.ps-port-note')].find((el) => el.dataset.base === typing.base);
    if (area) { area.focus(); area.setSelectionRange(typing.at, typing.at); }
  }
  list.querySelectorAll('[data-act]').forEach((button) => button.addEventListener('click', () => {
    const entry = entries.find((item) => item.base === button.dataset.base);
    if (!entry) return;
    if (button.dataset.act === 'verify') _psVerifyPort(entry);
    else if (button.dataset.act === 'retry') _psLoadPortEntry(entry, true);
    else if (button.dataset.act === 'reload') _psLoadPortEntry(entry);
    else if (button.dataset.act === 'drop') {
      _ps.bases.delete(entry.base);
      _psFillBranches();
      _psRenderBases();
      _psRenderConfirm();
    }
  }));
}

function _psTogglePortFile(button) {
  const file = _ps.checks.get(button.dataset.base)?.check?.files?.[Number(button.dataset.index)];
  const slot = button.nextElementSibling;
  if (!file || !slot) return;
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
  button.closest('.ps-pf-item')?.classList.toggle('open', open);
  slot.hidden = !open;
  if (!open) { slot.innerHTML = ''; return; }
  const item = _ps.checks.get(button.dataset.base);
  const side = (label, text) => `<div class="ps-pf-side"><div class="ps-label">${label}</div>${text ? _psDiffHtml(text, false) : '<div class="ps-muted ps-pad">这一侧没有改动</div>'}</div>`;
  slot.innerHTML = `<div class="ps-pf-cols">
    ${side(`源分支 <code>${escHtml(item.check.from)}</code> 的改动`, file.source)}
    ${side(`目标分支 <code>${escHtml(item.check.to)}</code> 上的改动`, file.target)}
  </div>`;
}

async function _psVerifyPort(entry) {
  const item = _ps.checks.get(entry.base);
  const check = item?.check;
  if (!check || item.saving) return;
  const draftId = _ps.draftId;
  item.saving = true;
  item.verifyError = '';
  _psRenderPort();
  try {
    const result = await authApi('POST', `/api/pr-submit/drafts/${encodeURIComponent(draftId)}/verify`, {
      base: entry.kind === 'pick' ? entry.base : '',
      key: check.key,
      note: _ps.portNotes.get(check.key) || '',
    });
    if (result.status !== 200 || !result.data?.verification) throw new Error(result.data?.message || '保存失败');
    check.verification = result.data.verification;
  } catch (error) {
    item.verifyError = error.message || '保存失败';
  } finally {
    item.saving = false;
  }
  if (draftId !== _ps.draftId) return;
  _psRenderPort();
  _psRenderConfirm();
}

function _psPortBlockers() {
  return _psPortEntries().map((entry) => {
    const item = _ps.checks.get(entry.base);
    const base = entry.base;
    if (!item || item.state === 'previewing') return `正在预演移植到 ${base}`;
    if (item.state === 'checking') return `正在对比 ${base} 的移植结果`;
    if (item.state === 'error') return `${base}：${item.message}`;
    if (item.state === 'conflict') return `${base} 预演有冲突：取消勾选，或用 ace pr port ${base} 在独立目录移植`;
    if (item.state === 'empty') return `${base} 已经包含这些改动，取消勾选`;
    if (!item.check.verification) return `在「移植核对」里确认 ${_psPortFrom(entry)} → ${base}`;
    return '';
  }).filter(Boolean);
}

function _psBlockers() {
  const d = _ps.draft;
  const list = [];
  if (!d) return ['草稿还没有读取'];
  if (!d.commits?.length) list.push('相对对比基准没有新的 commit，在终端重新运行 ace pr');
  if (!_psSelectedRepo()) list.push('选择目标仓库');
  else if (_psProjectMismatch()) list.push('目标仓库和本地仓库不是同一个项目');
  else if (!_ps.preflight) list.push('正在检查推送用的 fork');
  else if (_ps.preflight.error) list.push(_ps.preflight.error);
  else if (!_ps.preflight.tokenConfigured) list.push('绑定 GitCode 令牌');
  else if (!_ps.preflight.fork) list.push('添加你自己的 fork 远程');
  if (!_ps.bases.size) list.push('至少选择一个目标分支');
  else if (!_psPending().length) list.push('选中的分支都已经创建过 PR');
  list.push(..._psPortBlockers());
  if (!(_psEl('ps-title')?.value || '').trim()) list.push('填写 PR 标题');
  if (_ps.issueMode === 'existing' && !_ps.issuePick && !d.results?.issue) list.push('从列表里选择一个自己的 Issue，或改为「不关联」');
  if (_ps.issueMode === 'create' && !d.results?.issue && !(_psEl('ps-issue-title')?.value || '').trim()) list.push('填写新 Issue 的标题');
  return list;
}

function _psRenderConfirm() {
  const plan = _psEl('ps-plan');
  const blockers = _psEl('ps-blockers');
  const button = _psEl('ps-submit');
  if (!plan || !button) return;
  const repo = _psSelectedRepo();
  const pending = _psPending();
  const fork = _ps.preflight?.fork;
  const issueResult = _ps.draft?.results?.issue;
  const lines = [];
  if (fork) lines.push(`把提交推到 <b>${escHtml(fork.owner)}/${escHtml(fork.repo)}</b>，每个目标分支一个 <code>submit/…</code> 分支`);
  if (repo && pending.length) lines.push(`在 <b>${escHtml(repo)}</b> 创建 ${pending.length} 个 PR：${pending.map((b) => `<code>${escHtml(b)}</code>`).join('、')}`);
  const picked = _psPortEntries().filter((entry) => entry.kind === 'pick').map((entry) => entry.base);
  if (picked.length) lines.push(`${picked.map((b) => `<code>${escHtml(b)}</code>`).join('、')} 推送「移植核对」里确认过的那份代码，目标分支有新提交时会要求重新预演`);
  if (issueResult) lines.push(`Issue：已关联 <a href="${escHtml(issueResult.url)}" target="_blank" rel="noopener noreferrer">#${escHtml(issueResult.number)}</a>`);
  else if (_ps.issueMode === 'none') lines.push('Issue：不关联');
  else if (_ps.issueMode === 'existing') lines.push(`Issue：关联 ${_ps.issuePick ? `#${escHtml(_ps.issuePick.number)}` : '（未选择）'}`);
  else lines.push(`Issue：新建「${escHtml((_psEl('ps-issue-title')?.value || '').trim() || '（未填写）')}」`);
  if (_ps.issueMode !== 'none' || issueResult) lines.push('每个 PR 的说明带上这个 Issue 编号，创建后再核对有没有多关联其他 Issue');
  lines.push('每个 PR 创建后评论 start build');
  const eligible = _psMonitorEligible(repo);
  const autoMonitor = _psEl('ps-auto-monitor');
  const monitorHint = _psEl('ps-monitor-hint');
  if (autoMonitor) autoMonitor.disabled = Boolean(repo) && !eligible;
  if (monitorHint) {
    monitorHint.hidden = !repo || eligible;
    monitorHint.textContent = 'PR 监控只支持 CPF-Flutter 组织下的仓库，这个目标仓库不会自动开启。';
  }
  lines.push(_psAutoMonitorOn()
    ? `提交成功后为新建的 ${pending.length} 个 PR 开启 PR 监控`
    : '不自动开启 PR 监控，提交后也可以在结果里单独加入');
  plan.innerHTML = lines.map((line) => `<li>${line}</li>`).join('');
  const list = _psBlockers();
  blockers.innerHTML = list.map((item) => `<li>${escHtml(item)}</li>`).join('');
  blockers.hidden = !list.length;
  const blocked = list.length > 0 || _ps.submitting;
  if (blocked && _ps.confirming) _psCancelConfirm();
  button.disabled = blocked;
  if (!_ps.confirming) button.textContent = pending.length ? `确认提交（创建 ${pending.length} 个 PR）` : '确认提交';
  const hint = _psEl('ps-submit-hint');
  if (hint) hint.textContent = list.length ? `还差 ${list.length} 项` : '';
}

function _psCancelConfirm() {
  _ps.confirming = false;
  clearTimeout(_ps.confirmTimer);
  const button = _psEl('ps-submit');
  const cancel = _psEl('ps-cancel');
  if (cancel) cancel.hidden = true;
  if (button) {
    button.classList.remove('btn-danger');
    button.classList.add('btn-primary');
    const pending = _psPending();
    button.textContent = pending.length ? `确认提交（创建 ${pending.length} 个 PR）` : '确认提交';
  }
}

async function _psSubmit() {
  if (_psBlockers().length || _ps.submitting) return;
  const button = _psEl('ps-submit');
  if (!_ps.confirming) {
    _ps.confirming = true;
    button.textContent = `再点一次，推送并创建 ${_psPending().length} 个 PR`;
    button.classList.remove('btn-primary');
    button.classList.add('btn-danger');
    _psEl('ps-cancel').hidden = false;
    _ps.confirmTimer = setTimeout(_psCancelConfirm, 8000);
    return;
  }
  _psCancelConfirm();
  const issue = { mode: _ps.issueMode };
  if (_ps.issueMode === 'existing') issue.url = `#${_ps.issuePick.number}`;
  if (_ps.issueMode === 'create') {
    issue.title = _psEl('ps-issue-title')?.value || '';
    issue.body = _psEl('ps-issue-desc')?.value || '';
  }
  _ps.submitting = true;
  _psSyncBack();
  button.disabled = true;
  button.textContent = '正在推送并创建 PR…';
  _psError('');
  const draftId = _ps.draftId;
  try {
    const result = await authApi('POST', `/api/pr-submit/drafts/${encodeURIComponent(draftId)}/submit`, {
      target: _psSelectedRepo(),
      bases: [..._ps.bases],
      title: _psEl('ps-title')?.value || '',
      body: _psEl('ps-body-text')?.value || '',
      issue,
    }, 300000);
    if (draftId !== _ps.draftId) return;
    if (result.data?.draft) _ps.draft = result.data.draft;
    if (result.status !== 200) _psError(result.data?.message || '提交没有全部完成');
  } catch (error) {
    if (draftId === _ps.draftId) _psError(error.message || '提交失败');
  } finally {
    _ps.submitting = false;
    _psSyncBack();
    _psRenderResults();
    if (draftId === _ps.draftId) {
      for (const pull of _ps.draft?.results?.pulls || []) {
        if (!pull.url && /重新预演/.test(pull.error || '') && _ps.checks.has(pull.base)) {
          _psLoadPortEntry({ base: pull.base, kind: 'pick' }, true);
        }
      }
      _psRenderBases();
    }
    _psRenderConfirm();
  }
  if (draftId === _ps.draftId && _psAutoMonitorOn()) {
    for (const pull of _ps.draft?.results?.pulls || []) {
      if (pull.url && !_ps.monitors.has(pull.url)) await _psStartMonitor(pull);
    }
  }
}

function _psSyncBack() {
  document.querySelectorAll('#ps-body [data-ps-back]').forEach((back) => {
    back.disabled = _ps.submitting;
    back.title = _ps.submitting ? '正在提交，完成后再返回' : '';
  });
}

function _psAutoMonitorSaved() {
  try { return localStorage.getItem(PS_AUTO_MONITOR_KEY) === '1'; } catch { return false; }
}

function _psMonitorEligible(repo) {
  return /^cpf-flutter\//i.test(repo || '');
}

function _psAutoMonitorOn() {
  const box = _psEl('ps-auto-monitor');
  return Boolean(box?.checked && !box.disabled && _psMonitorEligible(_psSelectedRepo()));
}

function _psPullRepo(pull) {
  return pull.repo || _psSelectedRepo();
}

function _psRenderResults() {
  const slot = _psEl('ps-result');
  const results = _ps.draft?.results;
  if (!slot) return;
  if (!results) { slot.innerHTML = ''; return; }
  const pulls = results.pulls || [];
  const failed = pulls.filter((item) => item.error).length;
  const issue = results.issue?.url
    ? `<div class="ps-result-row"><span class="ps-status ok">Issue</span><a href="${escHtml(results.issue.url)}" target="_blank" rel="noopener noreferrer">#${escHtml(results.issue.number)}</a><span class="ps-grow">${escHtml(results.issue.title || '')}</span></div>`
    : '';
  const rows = pulls.map((item, index) => {
    if (!item.url) {
      return `<div class="ps-result-row"><span class="ps-status err">失败</span><code>${escHtml(item.base)}</code><span class="ps-grow ps-err-text">${escHtml(item.error || '未创建')}</span></div>`;
    }
    const notes = [
      item.build === 'started' ? '<span class="ps-status ok">start build</span>' : '',
      item.build === 'failed' ? `<span class="ps-err-text">start build 评论失败${item.buildError ? `：${escHtml(item.buildError)}` : ''}</span>` : '',
      item.linkWarning ? `<span class="ps-err-text">${escHtml(item.linkWarning)}</span>` : '',
    ].filter(Boolean).join('');
    return `<div class="ps-result-row"><span class="ps-status ok">已创建</span><code>${escHtml(item.base)}</code><a href="${escHtml(item.url)}" target="_blank" rel="noopener noreferrer">PR #${escHtml(item.number)}</a><span class="ps-grow">${notes}</span>${_psMonitorCell(item, index)}</div>`;
  }).join('');
  const monitored = [..._ps.monitors.values()].some((m) => m.state === 'ok' || m.state === 'queued' || m.state === 'exists');
  slot.innerHTML = `<div class="ps-results">
    <div class="ps-label">提交结果</div>${issue}${rows}
    ${failed ? `<div class="ps-hint">修好失败原因后再点「确认提交」，只补做失败的 ${failed} 个分支，已创建的不会重复。</div>` : ''}
    ${monitored ? '<div class="ps-hint">监控进度在左侧「PR 监控」页查看。<button type="button" class="ps-link" id="ps-goto-monitor">打开 PR 监控</button></div>' : ''}
  </div>`;
  slot.querySelectorAll('.ps-monitor').forEach((button) => button.addEventListener('click', () => {
    const pull = pulls[Number(button.dataset.index)];
    if (pull) _psStartMonitor(pull);
  }));
  _psEl('ps-goto-monitor')?.addEventListener('click', () => {
    const pull = pulls.find((item) => {
      const state = _ps.monitors.get(item.url);
      return state && (state.state === 'ok' || state.state === 'queued' || state.state === 'exists');
    }) || pulls.find((item) => item.url);
    _psOpenMonitor(pull);
  });
}

function _psOpenMonitor(pull) {
  const state = pull?.url ? _ps.monitors.get(pull.url) : null;
  const target = {
    number: String(pull?.number || ''),
    repo: pull ? _psPullRepo(pull) : _psSelectedRepo(),
    runId: state?.runId || '',
  };
  if (typeof revealSubmittedPr === 'function') revealSubmittedPr(target);
  else if (typeof switchToPanel === 'function') switchToPanel('p-prreview');
}

function _psMonitorCell(pull, index) {
  const state = _ps.monitors.get(pull.url);
  if (state?.state === 'pending') return '<span class="ps-muted">正在开启监控…</span>';
  if (state?.state === 'ok') return '<span class="ps-status ok">监控已开启</span>';
  if (state?.state === 'queued') return '<span class="ps-status ok">已加入启动队列</span>';
  if (state?.state === 'exists') return '<span class="ps-status ok">已在监控中</span>';
  if (!_psMonitorEligible(_psPullRepo(pull))) return '';
  const error = state?.state === 'error' ? `<span class="ps-err-text">${escHtml(state.message)}</span>` : '';
  const label = state?.state === 'error' ? '重试加入监控' : '加入 PR 监控';
  return `${error}<button type="button" class="btn btn-ghost ps-monitor" data-index="${index}">${label}</button>`;
}

async function _psStartMonitor(pull) {
  _ps.monitors.set(pull.url, { state: 'pending' });
  _psRenderResults();
  try {
    const result = await authApi('POST', '/api/pr-review/monitor/start', { number: String(pull.number), repo: _psPullRepo(pull) }, 90000);
    if (result.status === 200 && result.data?.success) {
      _ps.monitors.set(pull.url, {
        state: result.data.queued ? 'queued' : 'ok',
        runId: result.data.runId || '',
      });
    } else if (result.status === 409) {
      _ps.monitors.set(pull.url, { state: 'exists', runId: result.data?.runId || '' });
    }
    else _ps.monitors.set(pull.url, { state: 'error', message: result.data?.message || '开启监控失败' });
  } catch (error) {
    _ps.monitors.set(pull.url, { state: 'error', message: error.message || '开启监控失败' });
  }
  _psRenderResults();
}

window.addEventListener('panelswitch', (event) => {
  if (event.detail?.panelId === 'p-prsubmit') loadPrSubmit();
});

window.addEventListener('popstate', () => {
  const panel = _psEl('p-prsubmit');
  if (location.hash !== '#p-prsubmit' || !panel || panel.style.display === 'none') return;
  if (!_psDraftId() && _ps.draftId) _ps.lastDraftId = _ps.draftId;
  _psCancelConfirm();
  loadPrSubmit();
});
