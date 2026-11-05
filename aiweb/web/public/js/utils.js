/* ── 通用工具函数 ── */

const $ = id => document.getElementById(id);

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/**
 * 提交按钮防重复点击保护
 * 在按钮 disabled 期间阻止重复提交，提交成功后延迟恢复按钮
 *
 * @param {HTMLButtonElement} btn       - 提交按钮元素
 * @param {string}            loadingText - 提交中显示的文字，如 '提交中…'
 * @param {string}            normalText - 正常状态显示的文字，如 '▶ 开始检视'
 * @param {number}            [cooldownMs=5000] - 提交成功后按钮冷却时间（毫秒），防止快速连点
 */
function guardSubmit(btn, loadingText, normalText, cooldownMs = 5000) {
  if (!btn || btn.disabled) return false;  // 按钮已禁用，拦截
  btn.disabled = true;
  btn.textContent = loadingText;
  btn._guardNormalText = normalText;
  btn._guardCooldownMs = cooldownMs;
  return true;
}

/**
 * 恢复提交按钮（提交成功后延迟恢复）
 * @param {HTMLButtonElement} btn
 */
function guardSubmitRestore(btn) {
  if (!btn) return;
  const normalText = btn._guardNormalText || '提交';
  const cooldown = btn._guardCooldownMs || 5000;
  setTimeout(() => {
    if (btn.disabled) {
      btn.disabled = false;
      btn.textContent = normalText;
    }
  }, cooldown);
}

/**
 * 立即恢复提交按钮（提交失败时无需等待冷却）
 * @param {HTMLButtonElement} btn
 */
function guardSubmitReset(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = btn._guardNormalText || '提交';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function colorJson(str) {
  return str.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    m => {
      if (/^"/.test(m)) return /:$/.test(m)
        ? `<span style="color:#7ec8e3">${m}</span>`
        : `<span style="color:#a8cc8c">${m}</span>`;
      if (/true|false/.test(m)) return `<span style="color:#d19a66">${m}</span>`;
      if (/null/.test(m))       return `<span style="color:#e06c75">${m}</span>`;
      return `<span style="color:#c678dd">${m}</span>`;
    }
  );
}

function pill(code) {
  const cls = code < 300 ? 's2xx' : code < 500 ? 's4xx' : 's5xx';
  return `<span class="status-pill ${cls}">HTTP ${code}</span>`;
}

function renderOut(id, { status, data, elapsed }) {
  const box = $(id);
  box.classList.remove('empty');
  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  box.innerHTML =
    `<button class="copy-btn" onclick="copyBox('${id}')">复制</button>` +
    `<div style="color:var(--dim);margin-bottom:6px">${ts()}  ${pill(status)}  ${elapsed}ms</div>` +
    `<div>${colorJson(escHtml(json))}</div>`;
}

function renderErr(id, msg) {
  const box = $(id);
  box.classList.remove('empty');
  box.innerHTML = `<span style="color:var(--err)">[错误] ${escHtml(msg)}</span>`;
}

/**
 * 通用 API 请求函数（带超时保护）
 * @param {string} method - HTTP 方法
 * @param {string} path   - 请求路径
 * @param {object} [body] - 请求体
 * @param {number} [timeoutMs=30000] - 超时时间（毫秒），默认 30s
 *   SSE 请求不应使用此函数（EventSource 自行管理连接生命周期）
 */
async function apiFetch(method, path, body, timeoutMs = 30000) {
  const t0 = Date.now();
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);

  // AbortController 实现超时，防止后端阻塞时前端无限等待
  const controller = new AbortController();
  opts.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(path, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, elapsed: Date.now() - t0 };
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`请求超时（${timeoutMs / 1000}s）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function copyBox(id) {
  const text = $(id).innerText.replace(/^复制\n/, '');
  navigator.clipboard.writeText(text).then(() => {
    const btn = $(id).querySelector('.copy-btn');
    btn.textContent = '已复制';
    setTimeout(() => btn.textContent = '复制', 1500);
  });
}

/* ── 通用分页管理器 ── */

/**
 * 创建一个分页管理器实例
 * @param {object} opts
 * @param {string} opts.apiPath        - API 路径，如 '/api/codecheck'
 * @param {string} opts.listContainerId - 任务列表容器 DOM ID
 * @param {string} opts.emptyId        - 空状态提示 DOM ID
 * @param {string} opts.countId        - 任务计数 DOM ID
 * @param {string} opts.pagerId        - 分页控件容器 DOM ID
 * @param {function} opts.renderPage   - 回调 (tasks, isFirstPage) => void，渲染当前页任务
 * @param {function} [opts.onPageChange] - 回调 (page) => void，翻页后额外操作
 * @param {number} [opts.pageSize=20]  - 每页条数
 * @returns {object} 分页管理器
 */
function createPagination(opts) {
  const pg = {
    apiPath: opts.apiPath,
    listContainerId: opts.listContainerId,
    emptyId: opts.emptyId,
    countId: opts.countId,
    pagerId: opts.pagerId,
    renderPage: opts.renderPage,
    onPageChange: opts.onPageChange || (() => {}),
    pageSize: opts.pageSize || 20,
    currentPage: 1,
    total: 0,
    totalPages: 1,
    loading: false,
  };

  /** 加载指定页数据 */
  pg.load = async function(page = 1) {
    if (pg.loading) return;
    pg.loading = true;
    try {
      // 分页数据源可能是登录保护接口（如 /api/issue-analysis）：优先走带 token 的 authApi，
      // 否则会拿到 401 {success:false} 而静默渲染空白列表
      const fetcher = (typeof authApi === 'function') ? authApi : apiFetch;
      const r = await fetcher('GET', `${pg.apiPath}?page=${page}&pageSize=${pg.pageSize}`);
      if (!r.data?.success) {
        console.warn(`分页加载被拒绝 [${pg.apiPath}]: HTTP ${r.status}`, r.data?.message || '');
        return;
      }

      pg.currentPage = r.data.page || page;
      pg.total = r.data.total || 0;
      pg.totalPages = r.data.totalPages || 1;

      const tasks = r.data.tasks || [];
      const listEl = $(pg.listContainerId);
      if (listEl) listEl.innerHTML = '';

      // 隐藏空状态
      const emptyEl = $(pg.emptyId);
      if (emptyEl) emptyEl.style.display = tasks.length > 0 ? 'none' : '';

      // 更新计数
      const countEl = $(pg.countId);
      if (countEl) countEl.textContent = `${pg.total} 个任务`;

      // 渲染任务卡片
      pg.renderPage(tasks, page === 1);

      // 渲染分页控件
      pg._renderPager();

      pg.onPageChange(page);
    } catch (e) {
      console.error(`分页加载失败 [${pg.apiPath}]:`, e.message);
    } finally {
      pg.loading = false;
    }
  };

  /** 上一页 */
  pg.prev = function() {
    if (pg.currentPage > 1) pg.load(pg.currentPage - 1);
  };

  /** 下一页 */
  pg.next = function() {
    if (pg.currentPage < pg.totalPages) pg.load(pg.currentPage + 1);
  };

  /** 跳转到指定页 */
  pg.go = function(page) {
    if (page >= 1 && page <= pg.totalPages) pg.load(page);
  };

  /** 渲染分页控件 */
  pg._renderPager = function() {
    const container = $(pg.pagerId);
    if (!container) return;

    // 只有 1 页时不显示分页控件
    if (pg.totalPages <= 1) {
      container.innerHTML = '';
      return;
    }

    const cur = pg.currentPage;
    const total = pg.totalPages;

    // 生成页码按钮（最多显示 7 个，当前页居中）
    const pages = [];
    if (total <= 7) {
      for (let i = 1; i <= total; i++) pages.push(i);
    } else {
      pages.push(1);
      if (cur > 4) pages.push('...');
      const start = Math.max(2, cur - 1);
      const end = Math.min(total - 1, cur + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (cur < total - 3) pages.push('...');
      pages.push(total);
    }

    // 全局函数名：连字符替换为下划线（cc-pager → cc_pager_go）
    const fnName = pg.pagerId.replace(/-/g, '_') + '_go';

    let html = '<div class="pagination">';
    // 上一页
    html += `<button class="page-btn ${cur === 1 ? 'disabled' : ''}" ${cur === 1 ? 'disabled' : `onclick="${fnName}(${cur - 1})"`}>‹</button>`;
    // 页码
    for (const p of pages) {
      if (p === '...') {
        html += '<span class="page-ellipsis">…</span>';
      } else {
        html += `<button class="page-btn ${p === cur ? 'active' : ''}" onclick="${fnName}(${p})">${p}</button>`;
      }
    }
    // 下一页
    html += `<button class="page-btn ${cur === total ? 'disabled' : ''}" ${cur === total ? 'disabled' : `onclick="${fnName}(${cur + 1})"`}>›</button>`;
    html += `<span class="page-info">${cur}/${total} 页，共 ${pg.total} 条</span>`;
    html += '</div>';

    container.innerHTML = html;
  };

  // 暴露全局跳转函数（onclick 内联调用需要，连字符替换为下划线）
  window[pg.pagerId.replace(/-/g, '_') + '_go'] = (page) => pg.go(page);

  return pg;
}
