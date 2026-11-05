/**
 * admin.js — 管理员平台统计
 *
 * 仅 admin 角色可见：
 *  1. nav 入口按登录角色显隐（initAuth 后校验）
 *  2. 数据接口 /api/pr-review/admin/stats 后端二次校验（403 兜底，前端隐藏只是 UX）
 *
 * 展示：注册/活跃用户、监控 PR 数、run 分布、用户明细、最近任务。
 */

/* ── 权限判定与导航显隐 ── */

function _adminIsAdmin() {
  const auth = (typeof getAuth === 'function') ? getAuth() : null;
  return auth?.user?.role === 'admin';
}

function updateAdminNav() {
  const isAdmin = _adminIsAdmin();
  const section = document.getElementById('nav-admin-section');
  const item = document.getElementById('nav-admin-item');
  if (section) section.style.display = isAdmin ? '' : 'none';
  if (item) item.style.display = isAdmin ? '' : 'none';
  // 非管理员若停留在统计面板（如登录态切换），切回健康检查
  if (!isAdmin) {
    const panel = document.getElementById('p-admin');
    if (panel && panel.style.display !== 'none' && typeof switchToPanel === 'function') {
      switchToPanel('p-health');
    }
  }
}

/* ── 数据拉取与渲染 ── */

async function refreshAdminStats() {
  const body = document.getElementById('admin-stats-body');
  if (!body) return;
  if (!_adminIsAdmin()) {
    body.innerHTML = '<div class="error-msg" style="display:block">仅管理员可查看平台统计</div>';
    return;
  }
  body.innerHTML = '<div style="font-size:var(--font-size-xs);color:var(--dim);padding:8px 0">加载统计数据中…</div>';

  try {
    const r = await authApi('GET', '/api/pr-review/admin/stats', null, 20000);
    if (r.status === 403) {
      body.innerHTML = '<div class="error-msg" style="display:block">仅管理员可查看平台统计</div>';
      updateAdminNav();
      return;
    }
    if (r.status === 401) {
      if (typeof onAuthExpired === 'function') onAuthExpired('登录已过期，请重新登录');
      return;
    }
    if (r.status !== 200 || !r.data?.success) {
      body.innerHTML = `<div class="error-msg" style="display:block">${escHtml(r.data?.message || '统计加载失败')}</div>`;
      return;
    }
    body.innerHTML = _renderAdminStats(r.data);
  } catch (e) {
    body.innerHTML = `<div class="error-msg" style="display:block">统计加载失败：${escHtml(e.message)}</div>`;
  }
}

/* 统计卡片（内联样式，复用主题变量） */
function _admCard(value, label, hint) {
  return `
    <div style="flex:1;min-width:130px;background:rgba(77,140,247,.06);border:1px solid rgba(77,140,247,.22);
                border-radius:10px;padding:12px 14px;text-align:center">
      <div style="font-size:22px;font-weight:700;color:var(--text)">${value}</div>
      <div style="font-size:var(--font-size-xs);color:var(--dim);margin-top:3px">${escHtml(label)}</div>
      ${hint ? `<div style="font-size:10px;color:var(--text-aux);margin-top:2px">${escHtml(hint)}</div>` : ''}
    </div>`;
}

function _renderAdminStats(d) {
  const us = d.userStats || {};
  const rs = d.runStats || {};
  const users = d.users || [];
  const fmtTime = (iso) => {
    if (!iso) return '-';
    const t = new Date(iso);
    return `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  };

  /* ① 概览卡片 */
  const cards = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      ${_admCard(us.total ?? 0, '注册用户', `7 日新增 ${us.new7d ?? 0}`)}
      ${_admCard(us.active1d ?? 0, '今日活跃', '24h 内有登录')}
      ${_admCard(us.active7d ?? 0, '7 日活跃', `30 日 ${us.active30d ?? 0}`)}
      ${_admCard(rs.activePrs ?? 0, '监控中的 PR', `活跃 PR run ${rs.activePrRuns ?? rs.activeRuns ?? 0}`)}
      ${_admCard(rs.totalPrs ?? 0, '累计监控 PR', `累计 PR run ${rs.totalPrRuns ?? rs.totalRuns ?? 0}`)}
      ${_admCard(rs.totalIssueRuns ?? 0, '累计 Issue 分析', `进行中 ${rs.activeIssueRuns ?? 0} · 反馈迭代含内`)}
    </div>`;

  /* ② 用户明细表 */
  const userRows = users.map(u => `
    <tr>
      <td><b>${escHtml(u.username || '-')}</b>${u.role === 'admin' ? ' <span style="font-size:10px;color:#e5c07b">admin</span>' : ''}</td>
      <td>${u.gitcodeUsername
        ? `<a href="https://gitcode.com/${encodeURIComponent(u.gitcodeUsername.split(',')[0].trim())}" target="_blank" rel="noopener" style="color:#7fa8ff;text-decoration:none">${escHtml(u.gitcodeUsername)} ↗</a>`
        : '<span style="color:var(--dim)">未绑定</span>'}</td>
      <td style="color:var(--dim)">${escHtml(u.email || '-')}</td>
      <td>${u.status === 'active' ? '<span style="color:#7ee2a8">正常</span>'
        : u.status === 'pending' ? '<span style="color:#f5b942">待审核</span>'
        : `<span style="color:var(--dim)">${escHtml(u.status || '-')}</span>`}</td>
      <td>${escHtml(fmtTime(u.createdAt))}</td>
      <td>${u.lastLoginAt ? escHtml(fmtTime(u.lastLoginAt))
        : '<span style="color:var(--dim)">从未登录</span>'}</td>
    </tr>`).join('');

  /* ③ 监控分布（按状态 + 按用户） */
  const statusChips = Object.entries(rs.byStatus || {}).map(([s, n]) => {
    const color = s === 'completed' ? '#7ee2a8' : s === 'running' ? '#7fa8ff'
      : s === 'crashed' ? '#ff7676' : s === 'stopped' ? '#f5b942' : 'var(--dim)';
    return `<span style="font-size:11px;padding:2px 10px;border-radius:10px;border:1px solid currentColor;color:${color};margin:2px">${escHtml(s)} · ${n}</span>`;
  }).join('');

  const userBars = (rs.byUser || []).slice(0, 10).map(u => {
    const max = Math.max(...(rs.byUser || []).map(x => x.total), 1);
    const pct = Math.round((u.total / max) * 100);
    return `
      <div style="display:flex;align-items:center;gap:8px;margin:4px 0">
        <span style="min-width:100px;font-size:var(--font-size-xs);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(u.user)}">${escHtml(u.user)}${u.gitcode ? ` <span style="color:var(--dim);font-size:10px">(${escHtml(u.gitcode)})</span>` : ''}</span>
        <div style="flex:1;height:8px;background:rgba(122,133,164,.15);border-radius:4px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#4d8cf7,#a855f7)"></div>
        </div>
        <span style="font-size:11px;color:var(--dim);min-width:110px;text-align:right">
          ${u.total} 次 · PR ${u.prs}${u.issues ? ` · Issue ${u.issues}` : ''}${u.active ? ` · <span style="color:#7fa8ff">活跃 ${u.active}</span>` : ''}</span>
      </div>`;
  }).join('');

  /* ④ 最近任务（含启动方式：手动=用户在 UI 开启 / 自动=webhook 唤醒 / 反馈迭代=Issue 反馈重跑） */
  const modeBadge = (m) => {
    if (m === 'manual') return '<span style="font-size:10px;padding:1px 8px;border-radius:9px;border:1px solid rgba(95,214,155,.4);color:#5fd69b">手动</span>';
    if (m === 'note') return '<span style="font-size:10px;padding:1px 8px;border-radius:9px;border:1px solid rgba(127,168,255,.4);color:#7fa8ff">自动·评论</span>';
    if (m === 'merge_request') return '<span style="font-size:10px;padding:1px 8px;border-radius:9px;border:1px solid rgba(127,168,255,.4);color:#7fa8ff">自动·PR更新</span>';
    if (m === 'feedback') return '<span style="font-size:10px;padding:1px 8px;border-radius:9px;border:1px solid rgba(192,132,252,.4);color:#c084fc">反馈迭代</span>';
    if (m) return `<span style="font-size:10px;padding:1px 8px;border-radius:9px;border:1px solid rgba(160,171,200,.4);color:#a0abc8">自动·${escHtml(m)}</span>`;
    return '<span style="font-size:10px;padding:1px 8px;border-radius:9px;border:1px solid rgba(160,171,200,.3);color:var(--dim)">未知</span>';
  };
  const typeBadge = (t) => t === 'issue'
    ? '<span style="font-size:10px;padding:1px 8px;border-radius:9px;border:1px solid rgba(56,189,248,.4);color:#38bdf8" title="Issue 智能诊断任务">Issue</span>'
    : '<span style="font-size:10px;padding:1px 8px;border-radius:9px;border:1px solid rgba(127,168,255,.4);color:#7fa8ff" title="PR 监控检视任务">PR</span>';
  const recentRows = (rs.recent || []).map(r => `
    <tr>
      <td>${typeBadge(r.type)}</td>
      <td><b>${r.repo ? escHtml(String(r.repo).split('/').pop() || '') + ' ' : ''}#${r.type === 'issue' ? (r.issue ?? '-') : (r.pr ?? '-')}</b></td>
      <td>${modeBadge(r.startMode)}</td>
      <td>${escHtml(r.owner || '-')}
        ${r.ownerIsAdmin ? '<span style="font-size:10px;color:#e5c07b;margin-left:4px" title="管理员账号启动">admin</span>' : ''}</td>
      <td>${escHtml(r.status)}</td>
      <td style="color:var(--dim)">${escHtml(fmtTime(r.startTime))}</td>
      <td style="font-family:var(--mono);font-size:10px;color:var(--dim);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(r.runId)}">${escHtml(r.runId)}</td>
    </tr>`).join('');

  return `
    ${cards}
    <div style="font-size:var(--font-size-xs);color:var(--text-aux);font-weight:600;margin:12px 0 6px">👥 用户明细（${users.length} 人 · 待审核 ${us.pending ?? 0}）</div>
    <div class="adm-table-wrap"><table class="md-table" style="width:100%">
      <thead><tr><th>用户名</th><th>GitCode</th><th>邮箱</th><th>状态</th><th>注册时间</th><th>最后登录</th></tr></thead>
      <tbody>${userRows || '<tr><td colspan="6" style="color:var(--dim)">暂无用户</td></tr>'}</tbody>
    </table></div>

    <div style="font-size:var(--font-size-xs);color:var(--text-aux);font-weight:600;margin:16px 0 6px">🔀 任务分布（PR 监控 + Issue 分析）</div>
    <div style="margin-bottom:8px">${statusChips || '<span style="color:var(--dim);font-size:var(--font-size-xs)">暂无监控记录</span>'}</div>
    ${userBars || ''}

    <div style="font-size:var(--font-size-xs);color:var(--text-aux);font-weight:600;margin:16px 0 6px">🕐 最近 ${(rs.recent || []).length} 条任务（手动 = 用户在平台开启 · 自动 = webhook 唤醒 · 反馈迭代 = Issue 诊断反馈重跑）</div>
    <div class="adm-table-wrap"><table class="md-table" style="width:100%">
      <thead><tr><th>类型</th><th>对象</th><th>启动方式</th><th>启动者</th><th>状态</th><th>开始时间</th><th>Run ID</th></tr></thead>
      <tbody>${recentRows || '<tr><td colspan="7" style="color:var(--dim)">暂无任务</td></tr>'}</tbody>
    </table></div>
    <div style="font-size:10px;color:var(--dim);margin-top:10px">统计生成于 ${escHtml(fmtTime(d.generatedAt))} · 数据源：AceHarness 同机目录（users.json + runs/*）</div>`;
}

/* ── 生命周期：面板切换刷新 + 登录态变化刷新导航 ── */

window.addEventListener('panelswitch', (e) => {
  if (e.detail?.panelId === 'p-admin') {
    updateAdminNav();
    refreshAdminStats();
  }
});

window.addEventListener('load', () => {
  updateAdminNav();
  // initAuth 是异步校验（可能刷新 localStorage 中的用户信息），延迟再校准一次导航显隐
  setTimeout(updateAdminNav, 800);
});
