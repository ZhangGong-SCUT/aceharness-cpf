/* ── ① 健康检查 ── */

let _semaphoreTimer = null;

async function doHealth() {
  try {
    const r = await apiFetch('GET', '/api/alive');
    renderOut('health-out', r);
    const ok = r.status === 200 && r.data?.status === 'ok';
    $('health-dot').style.background = ok ? 'var(--ok)' : 'var(--err)';
    $('health-label').style.color    = ok ? 'var(--ok)' : 'var(--err)';
    $('health-label').textContent    = ok ? '正常' : '异常';
  } catch (e) {
    renderErr('health-out', e.message);
    $('health-dot').style.background = 'var(--err)';
    $('health-label').textContent    = '无法连接';
    $('health-label').style.color    = 'var(--err)';
  }
}

async function doCopilotHealth() {
  try {
    // A07：/api/alive/copilot 需要登录态，必须走带 Authorization 的 authApi
    const r = await authApi('GET', '/api/alive/copilot');
    if (r.status === 401) { renderErr('health-copilot-out', '登录已失效，请重新登录'); return; }
    renderOut('health-copilot-out', r);
  } catch (e) {
    renderErr('health-copilot-out', e.message);
  }
}

/* F09：Issue 诊断链健康（新口径：按任务记录统计活跃数，依赖分别探活） */
async function doIssueChainHealth() {
  try {
    // A07：同上，需带登录凭证；401 表示登录失效，不是依赖不可用
    const r = await authApi('GET', '/api/issue-analysis/health');
    if (r.status === 401) { renderErr('health-issuechain-out', '登录已失效，请重新登录'); return; }
    renderOut('health-issuechain-out', r);
  } catch (e) {
    renderErr('health-issuechain-out', e.message);
  }
}

/* ── 信号量状态轮询 ── */

async function fetchSemaphoreStatus() {
  try {
    const r = await apiFetch('GET', '/api/queue/status');
    if (r.status === 200 && r.data?.success) {
      const sem = r.data.semaphore;
      if (!sem) return;

      const currentEl = $('semaphore-current');
      const maxEl     = $('semaphore-max');
      const waitingEl = $('semaphore-waiting');
      const waitCntEl = $('semaphore-waiting-count');
      const pillEl    = $('semaphore-pill');

      if (currentEl) currentEl.textContent = sem.current;
      if (maxEl)     maxEl.textContent     = sem.max;

      // 显示等待数
      if (sem.waiting > 0) {
        if (waitingEl) waitingEl.style.display = 'inline-flex';
        if (waitCntEl) waitCntEl.textContent = sem.waiting;
      } else {
        if (waitingEl) waitingEl.style.display = 'none';
      }

      // 高负载警告样式：使用率 >= 80%
      const usage = sem.current / sem.max;
      if (pillEl) {
        pillEl.classList.toggle('semaphore-busy', usage >= 0.8);
      }
    }
  } catch (e) {
    // 静默失败，不影响页面
  }
}

/**
 * 启动信号量状态轮询（每 5 秒）
 */
function startSemaphorePolling() {
  if (_semaphoreTimer) return;  // 防止重复启动
  fetchSemaphoreStatus();  // 立即获取一次
  _semaphoreTimer = setInterval(fetchSemaphoreStatus, 5000);
}
