import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const publicDir = new URL('../../web/public/', import.meta.url);
const utilsSrc = await readFile(new URL('js/utils.js', publicDir), 'utf8');
const issueSrc = await readFile(new URL('js/issueanalysis.js', publicDir), 'utf8');
// 详情页与 PR 页共用 prreview.js 中已有的安全 Markdown 渲染器。
// 只加载该纯函数段，不启动 PR 列表等无关业务逻辑。
const prSrc = await readFile(new URL('js/prreview.js', publicDir), 'utf8');
const markdownSrc = prSrc.slice(prSrc.indexOf('/* ── Markdown 安全渲染'), prSrc.indexOf('/* ── 辅助：Artifact'));
const navSrc = await readFile(new URL('js/navigation.js', publicDir), 'utf8');

// JSDOM 也实现了 Performance API，不能让它把测试浏览器窗口当作真实标签页定时刷新。
const testWindows = new Set();
afterEach(() => {
  for (const window of testWindows) window.close();
  testWindows.clear();
});

const TASK = {
  taskId: 'ia-history-1',
  runId: 'run-history-1',
  dirName: 'flutter_flutter#2590',
  issueUrl: 'https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2590',
  stage: 'issueanalysis_complete',
  createdAt: '2026-11-16T05:19:00.000Z',
  startedAt: '2026-11-16T05:19:10.000Z',
  finishedAt: '2026-11-16T06:00:30.000Z',
  summary: '替代环境已复测，原始 API 24 环境仍需运行验证。',
  workbenchUrl: 'http://127.0.0.1:3000/workbench',
  metadata: { verificationStatus: 'needs_runtime_validation', artifactStatus: { status: 'complete' } },
  aceharnessStatus: {
    currentPhase: '完成', currentStep: null,
    stepLogs: [{ stepName: '问题复现-问题复现', status: 'completed', timestamp: '2026-11-16T05:34:00.000Z', outputRef: 'outputs/step.md' }],
  },
};

function setup({ detail = false, status = 200, task = TASK, artifactStatus = 200, diagnosis = null } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <main ${detail ? 'class="ia-detail-main"' : 'id="main"'}>
      <div id="ia-tasks-empty"></div><div id="ia-task-count"></div><div id="ia-tasks-list"></div><div id="ia-pager"></div>
      <div id="ia-detail-loading"></div><div id="ia-detail-error" style="display:none"></div>
      <h1 id="ia-detail-title"></h1><a id="ia-detail-issue"></a>
      <code id="ia-detail-runid"></code><code id="ia-detail-taskid"></code><span id="ia-detail-created"></span>
      <a id="ia-detail-workbench" style="display:none"></a><button id="ia-detail-copy"></button><button id="ia-detail-stop"></button>
      <div id="ia-detail-body"></div><div id="auth-header-box"></div>
    </main>
  </body>`, {
    url: detail ? `http://127.0.0.1:8080/issue-analysis.html?task=${encodeURIComponent(task.taskId)}` : 'http://127.0.0.1:8080/#p-issueanalysis',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  testWindows.add(window);
  const calls = [];
  const navigations = [];
  window.localStorage.setItem('cpf-pr-review-auth', JSON.stringify({ token: 'test-token', user: { username: 'tester', role: 'admin' } }));
  window.__navigate = (url) => navigations.push(url);
  // JSDOM 不允许改写 Location.assign；仅将导航调用替换成事件，业务函数保持原样。
  window.addEventListener('ia-test-navigate', (event) => window.__navigate(event.detail));
  window.eval('window.__pendingLoadListeners = []; const originalAddEventListener = window.addEventListener; window.addEventListener = function(type, listener, options) { if (type === "load") { window.__pendingLoadListeners.push(listener); return; } return originalAddEventListener.call(this, type, listener, options); };');
  window.eval(utilsSrc);
  window.eval(markdownSrc);
  window.$ = (id) => window.document.getElementById(id);
  window.getAuth = () => JSON.parse(window.localStorage.getItem('cpf-pr-review-auth') || 'null');
  for (const name of ['initVisitStats', 'initSessionStats', 'doHealth', 'startSemaphorePolling', 'initAuth', 'initPrReviewHistory', 'initIssueAnalysisHistory']) window[name] = async () => {};
  window.authApi = async (method, path) => {
    calls.push({ method, path });
    const { pathname, searchParams } = new URL(path, 'http://localhost');
    if (pathname === '/api/issue-analysis') return { status: 200, data: { success: true, page: 1, pageSize: 20, total: 1, totalPages: 1, tasks: [task] } };
    if (pathname.endsWith('/status')) return { status, data: status === 200 ? { success: true, task } : { success: false, message: status === 403 ? '只能查看自己提交的 Issue 分析任务' : '任务不存在' } };
    if (pathname.endsWith('/failure-diagnosis')) return diagnosis
      ? { status: 200, data: { success: true, diagnosis } }
      : { status: 503, data: { success: false, message: '分诊暂不可用' } };
    if (pathname.endsWith('/final-review')) return { status: 200, data: { success: true, content: '# 完整诊断报告\n\n## 验证边界\n\n保留 API 24 待运行验证结论。' } };
    if (pathname.endsWith('/artifacts')) return artifactStatus === 200
      ? { status: 200, data: { success: true, images: [], files: [{ name: 'fix.patch', ref: 'work/fix.patch', kind: 'patch', size: 512 }], logs: [] } }
      : { status: artifactStatus, data: { success: false, message: '诊断证据暂时无法读取' } };
    if (pathname.endsWith('/iterations')) return { status: 200, data: { success: true, iterations: [null] } };
    if (pathname.endsWith('/artifacts/file')) return { status: 200, data: { success: true, content: searchParams.get('ref').includes('patch') ? 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new' : '# 复现日志' } };
    throw new Error(`unexpected request: ${method} ${path}`);
  };
  window.alert = () => {};
  window.confirm = () => false;
  const script = issueSrc.replace(
    'window.location.assign(_iaDetailUrl(task.taskId));',
    "window.dispatchEvent(new CustomEvent('ia-test-navigate', { detail: _iaDetailUrl(task.taskId) }));",
  );
  window.eval(script);
  window.eval(navSrc);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); };
  return { window, calls, navigations, settle, $: id => window.document.getElementById(id) };
}

test('无本地登录态也提交启动请求，由服务端处理本机身份', async () => {
  const ui = setup();
  ui.window.localStorage.removeItem('cpf-pr-review-auth');
  const values = {
    'ia-issue-url': TASK.issueUrl, 'ia-access-token': '', 'ia-priority': '', 'ia-issue-type': '',
  };
  for (const [id, value] of Object.entries(values)) {
    const input = ui.window.document.createElement('input');
    input.id = id;
    input.value = value;
    ui.window.document.body.appendChild(input);
  }
  for (const id of ['ia-submit-btn', 'ia-error', 'ia-url-hint']) {
    const element = ui.window.document.createElement(id === 'ia-error' ? 'div' : 'button');
    element.id = id;
    ui.window.document.body.appendChild(element);
  }
  ui.window.authApi = async (method, path, body) => {
    ui.calls.push({ method, path, body });
    if (method === 'POST' && path === '/api/issue-analysis') {
      return { status: 202, data: { success: true, taskId: 'ia-no-login', runId: 'run-no-login' } };
    }
    return { status: 200, data: { success: true, valid: true } };
  };
  await ui.window.doIssueAnalysis();
  const submissions = ui.calls.filter(call => call.method === 'POST' && call.path === '/api/issue-analysis');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].body.issueUrl, TASK.issueUrl);
  assert.equal(ui.$('ia-error').style.display, 'none');
});

test('历史列表是轻量摘要，点击真实导航到独立详情 URL', async () => {
  const ui = setup();
  await ui.window.initIssueAnalysisHistory();
  const card = ui.$('ia-card-1');
  assert.ok(card.querySelector('.ia-history-entry'));
  assert.equal(card.querySelector('.task-card-body'), null, '不再创建下拉详情');
  assert.equal(card.querySelector('.ia-report-viewer'), null, '不加载完整报告');
  assert.match(card.textContent, /验证受限/);
  assert.equal(ui.calls.filter(c => c.path.includes('final-review')).length, 0);
  card.querySelector('.ia-history-entry').click();
  await ui.settle();
  assert.deepEqual(ui.navigations, ['/issue-analysis.html?task=ia-history-1']);
  assert.ok(!ui.navigations[0].includes('token='), '详情 URL 不携带会话凭证');
  const stop = card.querySelector('#ia-1-stop');
  assert.equal(stop.style.display, 'none', '终态不显示停止按钮');
});

test('详情页按任务 ID 恢复完整报告、时间线、产物与补丁', async () => {
  const ui = setup({ detail: true });
  await ui.window.initIssueAnalysisDetail();
  await ui.settle();
  assert.equal(ui.$('ia-detail-title').textContent, 'CPF-Flutter/flutter_flutter#2590');
  assert.equal(ui.$('ia-detail-runid').textContent, 'run-history-1');
  assert.equal(ui.$('ia-detail-workbench').href, 'http://127.0.0.1:3000/workbench');
  assert.equal(ui.$('ia-1-body').style.display, '');
  assert.match(ui.$('ia-1-report-zone').textContent, /完整诊断报告/);
  assert.match(ui.$('ia-1-report-zone').textContent, /保留 API 24 待运行验证结论/);
  assert.equal(ui.$('ia-1-report-zone').querySelector('.ia-report-full').style.maxHeight, '');
  assert.match(ui.$('ia-1-timeline-zone').textContent, /问题复现/);
  assert.match(ui.$('ia-1-artifacts-zone').textContent, /fix.patch/);
  assert.match(ui.$('ia-1-patch-zone').textContent, /修复代码变更/);
  assert.match(ui.$('ia-1-feedback-zone').textContent, /提交反馈/);
  assert.equal(ui.$('ia-detail-error').style.display, 'none');
});

test('产物接口异常时明确提示，不影响报告和时间线', async () => {
  const ui = setup({ detail: true, artifactStatus: 500 });
  await ui.window.initIssueAnalysisDetail();
  await ui.settle();
  assert.match(ui.$('ia-1-artifacts-zone').textContent, /诊断证据暂时无法读取/);
  assert.match(ui.$('ia-1-report-zone').textContent, /完整诊断报告/);
  assert.match(ui.$('ia-1-timeline-zone').textContent, /问题复现/);
  assert.equal(ui.$('ia-detail-error').style.display, 'none');
});

test('详情页保留后端归属校验和不存在提示', async () => {
  for (const status of [403, 404]) {
    const ui = setup({ detail: true, status });
    await ui.window.initIssueAnalysisDetail();
    assert.equal(ui.$('ia-detail-loading').style.display, 'none');
    assert.equal(ui.$('ia-detail-error').style.display, 'block');
    assert.match(ui.$('ia-detail-error').textContent, status === 403 ? /只能查看自己/ : /不存在/);
    assert.equal(ui.$('ia-detail-body').children.length, 0);
  }
});

test('时间线读取失败时保留可见提示，报告与产物仍独立加载', async () => {
  const task = { ...TASK, aceharnessStatus: null, aceharnessError: '请求超时（12000ms）' };
  const ui = setup({ detail: true, task });
  await ui.window.initIssueAnalysisDetail();
  await ui.settle();
  assert.match(ui.$('ia-1-timeline-zone').textContent, /读取失败：请求超时/);
  assert.match(ui.$('ia-1-report-zone').textContent, /完整诊断报告/);
  assert.equal(ui.calls.filter(c => c.path.endsWith('/status')).length, 1, '不重复触发慢状态查询');
});

test('共享导航在非首页不初始化无关历史轮询', () => {
  const ui = setup({ detail: true });
  let loadCalls = 0;
  ui.window.addEventListener('load', () => loadCalls++);
  for (const listener of ui.window.__pendingLoadListeners) listener();
  assert.equal(loadCalls, 1);
  assert.equal(ui.calls.length, 0);
});

test('PR 目标面板在慢历史请求完成前立即恢复，且不预取其他状态', async () => {
  const ui = setup();
  const prPanel = ui.window.document.createElement('section');
  prPanel.id = 'p-prreview';
  prPanel.className = 'panel';
  prPanel.style.display = 'none';
  ui.window.document.getElementById('main').appendChild(prPanel);
  ui.window.location.hash = '#p-prreview';
  const pending = [];
  ui.window.initAuth = async () => {};
  ui.window.initPrReviewHistory = () => new Promise(resolve => pending.push(resolve));
  ui.window.initIssueAnalysisHistory = () => new Promise(resolve => pending.push(resolve));
    for (const listener of ui.window.__pendingLoadListeners) void listener();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(prPanel.style.display, '', '登录建立后立即显示目标面板，不等待历史请求');
  assert.equal(pending.length, 2, '历史仍在后台初始化');
  const prSrc = await readFile(new URL('js/prreview.js', publicDir), 'utf8');
  assert.doesNotMatch(prSrc, /_schedulePrOvPrefetch\(\)/, '首屏不再并发预取全部、开放、合入和关闭四种状态');
  pending.forEach(resolve => resolve());
});

test('失败详情保留真实错误与恢复区，不伪造成功报告', async () => {
  const task = { ...TASK, stage: 'failed', error: '原始 Issue 尚未完成运行验证', aceharnessStatus: { stepLogs: [] } };
  const ui = setup({ detail: true, task });
  await ui.window.initIssueAnalysisDetail();
  await ui.settle();
  assert.match(ui.$('ia-1-error').textContent, /尚未完成运行验证/);
  assert.match(ui.$('ia-1-recovery-zone').textContent, /原始失败日志和报告可先行查看/);
  assert.equal(ui.calls.filter(call => call.path.includes('/failure-diagnosis')).length, 0, '浏览历史不自动调用监督模型');
  ui.$('ia-1-recovery-zone').querySelector('button').click();
  await ui.settle();
  assert.equal(ui.calls.filter(call => call.path.includes('/failure-diagnosis')).length, 1, '主动分析时才诊断');
  assert.match(ui.$('ia-1-recovery-zone').textContent, /分诊暂不可用/);
  assert.equal(ui.$('ia-detail-stop').style.display, 'none');
});

test('失败恢复区分别展示业务复现根因和独立平台故障', async () => {
  const task = { ...TASK, stage: 'failed', error: '原始 Issue 尚未完成运行验证', aceharnessStatus: { stepLogs: [] } };
  const diagnosis = {
    category: 'issue_unresolved', examinedStepCount: 13, canResume: false,
    failedStep: { stepName: '修复方案对抗验证' }, preserved: { completedStepCount: 9 },
    businessRootCause: { stepName: '问题复现', summary: '黄金标志未在目标环境中实际复现。' },
    rootCause: { stepName: '方案质疑', summary: '伪分支 B 覆盖了 SDK pin。' },
    causeRelationship: { businessPrecedesPlatform: true, summary: '两条独立因果链，必须分别处理。' },
    originFailedStep: { stepName: '方案裁决', error: 'SDK 隔离目录不兼容' },
    summary: '修复平台故障不等于 Issue 已解决。', guidance: { actions: [] }, retry: {},
  };
  const ui = setup({ detail: true, task: { ...task, failureDiagnosis: diagnosis }, diagnosis });
  await ui.window.initIssueAnalysisDetail();
  await ui.settle();
  const content = ui.$('ia-1-recovery-zone').textContent;
  assert.match(content, /Issue 未解决的首要业务原因/);
  assert.match(content, /问题复现/);
  assert.match(content, /平台执行故障源头/);
  assert.match(content, /方案质疑/);
  assert.match(content, /复现缺口早于本次平台故障/);
  assert.doesNotMatch(content, />根本源头：/);
});
