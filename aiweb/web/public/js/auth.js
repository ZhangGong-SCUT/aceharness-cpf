/* ── 全站共享登录态管理（AceHarness 账号体系） ── */

/*
 * 登录态存 localStorage（key: cpf-pr-review-auth），与 AceHarness 工作台一致。
 * 所有页面（index.html / login.html）共享：
 *   getAuth() / saveAuth() / clearAuth() — 存取
 *   validateAuth()                        — 异步校验 token（/api/pr-review/me）
 *   renderAuthHeader()                    — 渲染 header 用户区
 *   authApi()                             — 带 Authorization 的 fetch
 */

const AUTH_STORAGE_KEY = 'cpf-pr-review-auth';

/* ── 存取 ── */

function getAuth() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || 'null');
  } catch { return null; }
}

function saveAuth(auth) {
  try { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth)); } catch { /* ignore */ }
}

function clearAuth() {
  try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* ignore */ }
}

/* ── 带 Authorization 的 API 请求 ── */

async function authApi(method, path, body, timeoutMs = 30000) {
  // 公网链路（Cloudflare 隧道）间歇抖动会抛网络层错误：对幂等的 GET 自动重试 1 次。
  // POST/PUT/DELETE 不重试（避免重复提交，如开启/关闭监控）。
  const retriable = (method || 'GET').toUpperCase() === 'GET';
  try {
    return await _authApiOnce(method, path, body, timeoutMs);
  } catch (e) {
    const isNetworkErr = e.name === 'TypeError' || /fetch|network/i.test(e.message);
    if (retriable && isNetworkErr) {
      await new Promise(r => setTimeout(r, 1200));
      return await _authApiOnce(method, path, body, timeoutMs);
    }
    throw e;
  }
}

async function _authApiOnce(method, path, body, timeoutMs = 30000) {
  const auth = getAuth();
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (auth?.token) opts.headers['Authorization'] = 'Bearer ' + auth.token;
  if (body) opts.body = JSON.stringify(body);

  const controller = new AbortController();
  opts.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(path, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    // token 失效 → 清除登录态并刷新 header
    if (res.status === 401 && auth) {
      clearAuth();
      renderAuthHeader();
      if (typeof onAuthExpired === 'function') onAuthExpired('登录已过期，请重新登录');
    }
    return { status: res.status, data };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`请求超时（${timeoutMs / 1000}s）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ── 校验 token ── */

async function validateAuth() {
  const auth = getAuth();
  if (!auth?.token) return null;
  try {
    const r = await authApi('GET', '/api/pr-review/me', null, 10000);
    if (r.status === 200 && r.data?.user) {
      const updated = { token: auth.token, user: r.data.user };
      saveAuth(updated);
      return updated;
    }
    if (r.status === 401) return null; // 已被 authApi 清除
    return auth; // 网络异常时保持现状
  } catch {
    return auth; // 网络异常时保持现状
  }
}

/* ── header 用户区渲染（index.html 专用） ── */

async function ensureLocalSession() {
  try {
    const res = await fetch('/api/pr-review/local-session');
    const data = await res.json().catch(() => ({}));
    if (res.status === 200 && data?.token && data?.user) {
      const auth = { token: data.token, user: data.user, local: true };
      saveAuth(auth);
      return auth;
    }
  } catch { /* 本地会话不可用时保持未登录 */ }
  return null;
}

function renderAuthHeader() {
  const box = document.getElementById('auth-header-box');
  if (!box) return;
  const auth = getAuth();
  if (!auth?.user) {
    box.innerHTML = '';
    return;
  }
  const u = auth.user;
  box.innerHTML = `
    <span style="display:inline-flex;align-items:center;gap:6px;font-size:var(--font-size-sm)" title="${escHtml(u.email || '')}">
      <span style="width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#4d8cf7,#a855f7);
                   display:inline-flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:700">${escHtml((u.username || '?').slice(0, 1).toUpperCase())}</span>
      <b>${escHtml(u.username || '未知用户')}</b>
      ${u.role === 'admin' ? '<span style="font-size:var(--font-size-xs);color:#e5c07b;background:rgba(229,192,123,.12);border:1px solid rgba(229,192,123,.3);padding:0 6px;border-radius:8px">admin</span>' : ''}
      ${auth.local ? '<span style="font-size:var(--font-size-xs);color:var(--text-aux)">本机</span>' : ''}
    </span>
    ${auth.local ? '' : `<a href="#" onclick="event.preventDefault();doLogout()" title="退出登录"
       style="font-size:var(--font-size-xs);color:var(--dim);padding:4px 8px;border-radius:6px;text-decoration:none;cursor:pointer">退出</a>`}`;
}

/* ── 退出登录 ── */

function doLogout(msg) {
  clearAuth();
  renderAuthHeader();
  if (typeof onAuthExpired === 'function') onAuthExpired(msg || '已退出登录');
}

/* token 失效/退出时的页面回调（各页面自行覆盖实现） */
function onAuthExpired(msg) {
  // 默认实现：无操作（prreview.js 等模块会覆盖）
  if (typeof console !== 'undefined') console.info('[auth]', msg);
}

/* ── 初始化（页面 load 时调用） ── */

async function initAuth() {
  let auth = await validateAuth();
  if (!auth?.user) auth = await ensureLocalSession();
  renderAuthHeader();
  return auth;
}
