/* ── 登录/注册页逻辑 ── */

/* 登录成功后的跳转目标
 *  - login.html?redirect=p-prreview → index.html#p-prreview（旧的面板 ID 形式）
 *  - login.html?redirect=/tag、/prcheck → 直接回该功能页（A05：页面由"未登录跳到登录页"引导而来）
 * Q02/B02：浏览器 URL 解析会把 /\ 归一化为 //、吞掉控制字符、折叠点段，
 * 且解析后的 pathname 仍可能以 // 开头（如 /.//evil → //evil），
 * 只拼接 pathname 再导航会被当作协议相对地址跳到站外。
 * 必须用 URL 解析器校验 origin，并直接返回解析结果的完整同源 URL（u.href），不再二次拼接。 */
function _loginRedirectTarget() {
  const params = new URLSearchParams(location.search);
  const redirect = params.get('redirect');
  if (redirect && redirect.startsWith('/')) {
    try {
      const u = new URL(redirect, location.origin);
      // 返回完整同源 URL：origin 已由解析器确定，再次导航不会重新解释出站外地址
      if (u.origin === location.origin) return u.href;
    } catch { /* 解析失败落到默认首页 */ }
    return 'index.html';
  }
  // 旧的面板 ID 形式（p-prreview → index.html#p-prreview）
  if (redirect && /^[a-z][a-z0-9-]*$/i.test(redirect)) return 'index.html#' + redirect;
  return 'index.html';
}

/* ── Tab 切换（滑动指示器） ── */
function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-register').classList.toggle('active', !isLogin);
  document.getElementById('auth-tabs').classList.toggle('register-mode', !isLogin);
  document.getElementById('form-login').hidden = !isLogin;
  document.getElementById('form-register').hidden = isLogin;
  _hideAuthMsg();
}

/* ── 密码显示/隐藏切换 ── */
function togglePw(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  if (btn) btn.textContent = show ? '🙈' : '👁';
}

/* ── 消息横幅 ── */
function _showAuthErr(msg) {
  const box = document.getElementById('auth-error');
  document.getElementById('auth-error-text').textContent = msg;
  box.hidden = false;
  document.getElementById('auth-success').hidden = true;
}

function _showAuthOk(html) {
  const box = document.getElementById('auth-success');
  document.getElementById('auth-success-text').innerHTML = html;
  box.hidden = false;
  document.getElementById('auth-error').hidden = true;
}

function _hideAuthMsg() {
  document.getElementById('auth-error').hidden = true;
  document.getElementById('auth-success').hidden = true;
}

/* ── 带超时的 fetch（注册/登录请求，防后端阻塞时无限等待） ── */
async function _authFetch(path, body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`请求超时（${timeoutMs / 1000}s），请稍后重试`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ── 登录 ── */
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) { _showAuthErr('请输入邮箱和密码'); return; }

  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = '登录中…';
  _hideAuthMsg();

  try {
    const res = await _authFetch('/api/pr-review/login', { email, password }, 20000);
    const data = await res.json().catch(() => ({}));
    if (res.status !== 200 || !data?.token) {
      _showAuthErr(data?.message || `登录失败（HTTP ${res.status}）`);
      return;
    }
    saveAuth({ token: data.token, user: data.user });
    _showAuthOk(`欢迎回来，<b>${escHtml(data.user?.username || '')}</b>！正在进入工作台…`);
    setTimeout(() => { location.href = _loginRedirectTarget(); }, 600);
  } catch (e) {
    _showAuthErr(e.message);
  } finally {
    btn.disabled = false; btn.textContent = '登 录';
  }
}

/* ── 注册 ── */
/* ── 注册邮箱验证码 ── */

let _regCodeCountdown = 0;

async function sendRegVerifyCode() {
  const email = document.getElementById('reg-email')?.value?.trim();
  if (!email) { _showAuthErr('请先输入邮箱'); return; }

  const btn = document.getElementById('reg-send-code-btn');
  if (btn?.disabled) return;

  btn.disabled = true;
  btn.textContent = '发送中…';
  _hideAuthMsg();

  try {
    const res = await _authFetch('/api/pr-review/verify-email', { email }, 30000);
    const data = await res.json().catch(() => ({}));
    if (res.status === 200 && data?.success) {
      _showAuthOk(`验证码已发送到 <b>${escHtml(email)}</b>，请查收（10 分钟内有效）`);
      // 60 秒倒计时
      _regCodeCountdown = 60;
      const tick = () => {
        if (_regCodeCountdown <= 0) {
          btn.disabled = false;
          btn.textContent = '发送验证码';
          return;
        }
        btn.textContent = `重发(${_regCodeCountdown}s)`;
        _regCodeCountdown--;
        setTimeout(tick, 1000);
      };
      tick();
    } else {
      _showAuthErr(data?.message || '验证码发送失败');
      btn.disabled = false;
      btn.textContent = '发送验证码';
    }
  } catch (e) {
    _showAuthErr('发送失败：' + e.message);
    btn.disabled = false;
    btn.textContent = '发送验证码';
  }
}

async function doRegister() {
  const username = document.getElementById('reg-username').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const password2 = document.getElementById('reg-password2').value;
  const question = document.getElementById('reg-question').value.trim();
  const answer = document.getElementById('reg-answer').value.trim();
  const emailVerifyCode = document.getElementById('reg-verify-code')?.value?.trim() || '';

  if (!username || !email || !password || !question || !answer) {
    _showAuthErr('所有字段都不能为空'); return;
  }
  if (password.length < 6) { _showAuthErr('密码至少 6 个字符'); return; }
  if (password !== password2) { _showAuthErr('两次输入的密码不一致'); return; }
  if (!emailVerifyCode || emailVerifyCode.length !== 6) { _showAuthErr('请输入 6 位邮箱验证码（点邮箱旁边的「发送验证码」）'); return; }

  const btn = document.getElementById('register-btn');
  btn.disabled = true; btn.textContent = '创建中…';
  _hideAuthMsg();

  try {
    const res = await _authFetch('/api/pr-review/register', {
      username, email, password, question, answer, emailVerifyCode,
    }, 30000);
    const data = await res.json().catch(() => ({}));
    if (res.status !== 201 && res.status !== 200) {
      _showAuthErr(data?.message || `注册失败（HTTP ${res.status}）`);
      return;
    }

    if (data?.activated) {
      // 已激活：自动登录并跳转
      _showAuthOk(`账号创建成功，正在自动登录…`);
      const loginRes = await _authFetch('/api/pr-review/login', { email, password }, 20000);
      const loginData = await loginRes.json().catch(() => ({}));
      if (loginRes.status === 200 && loginData?.token) {
        saveAuth({ token: loginData.token, user: loginData.user });
        setTimeout(() => { location.href = _loginRedirectTarget(); }, 500);
      } else {
        _showAuthOk(`注册成功！请用邮箱 <b>${escHtml(email)}</b> 手动登录。`);
        document.getElementById('form-register').reset();
        setTimeout(() => switchAuthTab('login'), 1500);
      }
    } else {
      // 降级：需管理员审核
      const reason = data?.degradedReason
        ? `<br><span style="font-size:12px;opacity:.75">（${escHtml(data.degradedReason)}）</span>` : '';
      _showAuthOk(`${escHtml(data?.message || '注册申请已提交')}，审核通过后即可登录。${reason}`);
      document.getElementById('form-register').reset();
      setTimeout(() => switchAuthTab('login'), 2500);
    }
  } catch (e) {
    _showAuthErr(e.message);
  } finally {
    btn.disabled = false; btn.textContent = '创建账号';
  }
}

/* ── 初始化 ── */
(async function initLoginPage() {
  // 已登录用户直接跳转工作台
  const auth = await validateAuth();
  if (auth?.user) {
    _showAuthOk(`已登录为 <b>${escHtml(auth.user.username || '')}</b>，正在进入工作台…`);
    setTimeout(() => { location.href = _loginRedirectTarget(); }, 500);
  }

  // 回车提交
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });

  // 从 URL 参数定位 Tab（?tab=register）
  if (new URLSearchParams(location.search).get('tab') === 'register') {
    switchAuthTab('register');
  }
})();

/* ═══════════ 忘记密码（邮箱验证码） ═══════════ */

function showForgotPassword() {
  document.getElementById('forgot-modal').style.display = 'flex';
  backToStep1();
  setTimeout(() => document.getElementById('forgot-email')?.focus(), 100);
}

function hideForgotPassword() {
  document.getElementById('forgot-modal').style.display = 'none';
}

function backToStep1() {
  _showForgotStep('step1');
  _showForgotError('');
}

function _showForgotStep(step) {
  for (const s of ['step1', 'step2', 'result']) {
    const el = document.getElementById(`forgot-${s}`);
    if (!el) continue;
    el.style.display = s === step ? (s === 'step1' ? 'flex' : s === 'step2' ? 'flex' : 'flex') : 'none';
  }
}

function _showForgotError(msg) {
  const el = document.getElementById('forgot-error');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function _setForgotBtnLoading(btn, loading, text) {
  if (!btn) return;
  btn.disabled = loading;
  btn.style.opacity = loading ? '.5' : '';
  btn.textContent = loading ? '⏳ 处理中…' : text;
}

async function _forgotApi(body) {
  const resp = await fetch('/api/pr-review/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function sendResetCode() {
  const email = document.getElementById('forgot-email')?.value?.trim();
  if (!email) return _showForgotError('请输入注册邮箱');

  const btn = document.getElementById('forgot-send-btn');
  _setForgotBtnLoading(btn, true, '发送验证码');
  _showForgotError('');

  try {
    const r = await _forgotApi({ step: 'send-code', email });
    if (r.status === 200 && r.data?.success) {
      document.getElementById('forgot-email-display').textContent = email;
      document.getElementById('forgot-code').value = '';
      document.getElementById('forgot-newpwd').value = '';
      _showForgotStep('step2');
      setTimeout(() => document.getElementById('forgot-code')?.focus(), 100);
    } else {
      _showForgotError(r.data?.message || r.data?.error || '发送失败，请稍后重试');
    }
  } catch (e) {
    _showForgotError('网络异常：' + e.message);
  } finally {
    _setForgotBtnLoading(btn, false, '发送验证码');
  }
}

async function resetPassword() {
  const email = document.getElementById('forgot-email')?.value?.trim();
  const code = document.getElementById('forgot-code')?.value?.trim();
  const newPassword = document.getElementById('forgot-newpwd')?.value;

  if (!code || code.length !== 6) return _showForgotError('请输入 6 位验证码');
  if (!newPassword || newPassword.length < 6) return _showForgotError('新密码至少 6 个字符');

  const btn = document.getElementById('forgot-reset-btn');
  _setForgotBtnLoading(btn, true, '重置密码');
  _showForgotError('');

  try {
    const r = await _forgotApi({ step: 'verify-and-reset', email, code, newPassword });
    if (r.status === 200 && r.data?.success) {
      document.getElementById('forgot-result-icon').textContent = '✅';
      document.getElementById('forgot-result-msg').innerHTML =
        '密码重置成功！<br/>请使用 <b>新密码</b> 和原邮箱 <b>' + escHtml(email) + '</b> 登录';
      _showForgotStep('result');
    } else {
      _showForgotError(r.data?.message || r.data?.error || '重置失败');
    }
  } catch (e) {
    _showForgotError('网络异常：' + e.message);
  } finally {
    _setForgotBtnLoading(btn, false, '重置密码');
  }
}

// 回车提交（验证码步骤）
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('forgot-code')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') resetPassword();
  });
  document.getElementById('forgot-newpwd')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') resetPassword();
  });
  // 点击遮罩关闭
  document.getElementById('forgot-modal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) hideForgotPassword();
  });
});
