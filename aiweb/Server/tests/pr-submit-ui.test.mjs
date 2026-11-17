import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const publicDir = new URL('../../web/public/', import.meta.url);
const utilsSrc = await readFile(new URL('js/utils.js', publicDir), 'utf8');
const pageSrc = await readFile(new URL('js/prsubmit.js', publicDir), 'utf8');

const DRAFT = {
  id: 'prd-11111111',
  createdAt: '2026-11-13T08:00:00.000Z',
  status: 'draft',
  repoPath: '/work/flutter_flutter',
  headBranch: 'fix/keyboard',
  trackingRef: 'upstream/oh-3.41.9-dev',
  trackingBranch: 'oh-3.41.9-dev',
  baseSource: 'upstream',
  remotes: [
    { name: 'upstream', owner: 'CPF-Flutter', repo: 'flutter_flutter' },
    { name: 'origin', owner: 'alice', repo: 'flutter_flutter' },
  ],
  suggestedTarget: 'CPF-Flutter/flutter_flutter',
  dirty: false,
  dirtyFiles: [],
  commits: [{ sha: 'abcdef1234567890', subject: 'fix: keyboard inset' }],
  files: [{ path: 'lib/a.dart', added: 3, removed: 1 }, { path: 'lib/b.dart', added: 2, removed: 0 }],
  title: 'fix: keyboard inset',
  body: 'fix: keyboard inset',
  results: null,
};

const BRANCHES = ['master', 'oh-3.41.9-dev', 'oh-3.41.9-release', 'oh-3.35.7-dev'];

const DIFF_A = [
  'diff --git a/lib/a.dart b/lib/a.dart',
  'index 111..222 100644',
  '--- a/lib/a.dart',
  '+++ b/lib/a.dart',
  '@@ -10,3 +10,4 @@ class A {',
  ' keep();',
  '-old();',
  '+fresh();',
  '+more(<b>);',
  ' tail();',
].join('\n');

function setup({ draft = DRAFT, url, preflight, drafts = [], monitor = {}, storage = {}, port = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="panel" id="p-prsubmit"><div id="ps-error" style="display:none"></div><div id="ps-body"></div></div>
  </body>`, { url: url || `http://127.0.0.1:8080/?draft=${draft?.id || 'prd-11111111'}#p-prsubmit`, runScripts: 'outside-only' });
  const { window } = dom;
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  const calls = [];
  let pending = null;
  let current = draft;
  window.confirm = () => true;
  window.authApi = async (method, path, body) => {
    calls.push({ method, path, body });
    const { pathname, searchParams } = new URL(path, 'http://x');
    if (pathname === '/api/pr-submit/drafts') return { status: 200, data: { success: true, drafts } };
    if (pathname.endsWith('/descriptions')) {
      if (port.descriptions?.error) return { status: 500, data: { success: false, message: port.descriptions.error } };
      if (port.descriptions?.pending) {
        pending ||= new Promise((resolve) => { port.releaseDescriptions = resolve; });
        await pending;
      }
      const generated = port.descriptions?.value || {
        title: 'fix: keyboard inset',
        issue: { title: 'fix: keyboard inset', body: '## 复现步骤 (Steps to Reproduce)\n\n键盘遮挡输入框。\n\n## 环境信息 (Environment)\n\n- Branch: oh-3.41.9-dev' },
        pr: { title: 'fix: keyboard inset', body: '## Why are these changes being made?\n\nAvoid keyboard overlap.\n\n### Test Run Result Summary\n\nNo test execution was recorded when this description was generated.' },
      };
      return { status: 200, data: { success: true, ...generated } };
    }
    if (pathname.endsWith('/preflight')) {
      return { status: 200, data: preflight || { success: true, tokenConfigured: true, login: 'alice', fork: { name: 'origin', owner: 'alice', repo: 'flutter_flutter' } } };
    }
    if (pathname.endsWith('/submit')) {
      current = {
        ...current,
        status: 'submitted',
        results: {
          issue: body.issue.mode === 'existing' ? { number: 2787, url: 'https://gitcode.com/x/issues/2787', title: '键盘遮挡' } : null,
          pulls: body.bases.map((base, i) => ({ base, repo: body.target, url: `https://gitcode.com/x/pulls/${10 + i}`, number: 10 + i })),
        },
      };
      return { status: 200, data: { success: true, draft: current } };
    }
    if (pathname.endsWith('/diff')) {
      const file = searchParams.get('path');
      if (file === 'lib/a.dart') return { status: 200, data: { success: true, path: file, diff: DIFF_A, truncated: false } };
      return { status: 500, data: { success: false, message: '本地仓库里找不到这份草稿的提交' } };
    }
    if (pathname.endsWith('/preview')) {
      const preview = port.previews?.[body.base];
      if (!preview) return { status: 500, data: { success: false, message: '预演失败：找不到分支' } };
      return { status: 200, data: { success: true, preview: { base: body.base, target: body.repo, ...preview } } };
    }
    if (pathname.endsWith('/port-check')) {
      const check = port.checks?.[searchParams.get('base') || ''];
      if (!check) return { status: 400, data: { success: false, message: '没有核对数据' } };
      return { status: 200, data: { success: true, check: structuredClone(check) } };
    }
    if (pathname.endsWith('/verify')) {
      const check = port.checks?.[body.base || ''];
      const differs = check.summary.adapted + check.summary.missing + check.summary.extra;
      if (differs && !body.note.trim()) return { status: 400, data: { success: false, message: '请写一句说明' } };
      const verification = { at: '2026-11-14T08:00:00.000Z', by: 'alice', note: body.note.trim() };
      check.verification = verification;
      return { status: 200, data: { success: true, verification } };
    }
    if (pathname === '/api/pr-review/monitor/start') {
      const spec = monitor[body.number] || 200;
      if (spec && typeof spec === 'object') return { status: spec.status || 200, data: spec };
      return {
        status: spec,
        data: {
          success: spec === 200,
          runId: spec === 200 ? `run-${body.number}` : '',
          message: spec === 200 ? '' : `监控失败 ${spec}`,
        },
      };
    }
    if (pathname.startsWith('/api/pr-submit/drafts/')) {
      return current ? { status: 200, data: { success: true, draft: structuredClone(current) } } : { status: 404, data: { message: '草稿不存在' } };
    }
    if (pathname === '/api/pr-submit/repos') return { status: 200, data: { repos: ['CPF-Flutter/flutter_flutter', 'CPF-Flutter/flutter_engine', 'CPF-Flutter/fluttertpc_camera'] } };
    if (pathname === '/api/pr-submit/branches') return { status: 200, data: { branches: searchParams.get('repo') === 'CPF-Flutter/flutter_flutter' ? BRANCHES : ['main'] } };
    if (pathname === '/api/pr-submit/issues') {
      if (searchParams.get('q') === '#8') return { status: 200, data: { login: 'alice', issues: [], hidden: 1 } };
      return {
        status: 200,
        data: {
          login: 'alice',
          hidden: 0,
          issues: [
            { number: '2787', title: '键盘遮挡', state: 'open', url: 'https://gitcode.com/x/issues/2787' },
            { number: '2600', title: '旧问题', state: 'closed', url: 'https://gitcode.com/x/issues/2600' },
          ],
        },
      };
    }
    return { status: 404, data: { message: 'unexpected ' + path } };
  };
  window.eval(utilsSrc);
  window.eval(pageSrc);
  const $ = (id) => window.document.getElementById(id);
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
  const open = async () => {
    window.dispatchEvent(new window.CustomEvent('panelswitch', { detail: { panelId: 'p-prsubmit' } }));
    await settle();
  };
  const type = (el, value) => { el.value = value; el.dispatchEvent(new window.Event('input')); };
  const text = (el) => el.innerHTML.replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { window, $, calls, settle, open, type, text, port };
}

test('草稿页：默认选中上游仓库和跟踪分支，fork 检查通过后可提交', async () => {
  const ui = setup();
  await ui.open();
  const { $ } = ui;
  assert.equal($('ps-repo').value, 'CPF-Flutter/flutter_flutter');
  assert.match(ui.text($('ps-fork')), /推送到 fork alice\/flutter_flutter/);
  assert.match(ui.text($('ps-base-count')), /已选 1 个 · 将创建 1 个 PR/);
  assert.match(ui.text($('ps-base-chips')), /oh-3\.41\.9-dev/);
  assert.match(ui.text(ui.window.document.querySelector('.ps-meta')), /1 个 commit · 2 个文件 · \+5 −1/);
  assert.equal($('ps-submit').disabled, false);
  assert.equal($('ps-blockers').hidden, true);
  assert.equal($('ps-submit').textContent, '确认提交（创建 1 个 PR）');
  assert.match(ui.text($('ps-remote-chips').querySelector('.active')), /upstream · CPF-Flutter\/flutter_flutter/);

  $('ps-remote-chips').querySelector('[data-repo="alice/flutter_flutter"]').click();
  await ui.settle();
  assert.match(ui.text($('ps-fork')), /目标仓库就是你自己的仓库/);
});

test('仓库和分支搜索：过滤、多选、芯片移除', async () => {
  const ui = setup();
  await ui.open();
  const { $ } = ui;
  ui.type($('ps-repo-search'), 'camera');
  assert.equal($('ps-repo-count').textContent, '匹配 1 / 4', '本地 fork 远程也在列表里');
  const values = [...$('ps-repo').options].map((o) => o.value);
  assert.deepEqual(JSON.parse(JSON.stringify(values)), ['', 'CPF-Flutter/flutter_flutter', 'CPF-Flutter/fluttertpc_camera'], '当前选择要保留在列表里');

  ui.type($('ps-branch-search'), 'release');
  let rows = $('ps-branches').querySelectorAll('input[type="checkbox"]');
  assert.deepEqual(JSON.parse(JSON.stringify([...rows].map((r) => r.value))), ['oh-3.41.9-release']);
  rows[0].checked = true;
  rows[0].dispatchEvent(new ui.window.Event('change'));
  assert.match(ui.text($('ps-base-count')), /已选 2 个 · 将创建 2 个 PR/);
  assert.equal($('ps-submit').textContent, '确认提交（创建 2 个 PR）');

  ui.type($('ps-branch-search'), '');
  rows = [...$('ps-branches').querySelectorAll('input[type="checkbox"]')];
  assert.equal(rows[0].value, 'oh-3.41.9-dev', '跟踪分支排在第一位');
  assert.deepEqual(JSON.parse(JSON.stringify(rows.filter((r) => r.checked).map((r) => r.value))), ['oh-3.41.9-dev', 'oh-3.41.9-release']);

  $('ps-base-chips').querySelector('[data-base="oh-3.41.9-dev"]').click();
  assert.match(ui.text($('ps-base-count')), /已选 1 个/);
  assert.equal($('ps-branches').querySelector('input[value="oh-3.41.9-dev"]').checked, false);

  $('ps-base-chips').querySelector('[data-base="oh-3.41.9-release"]').click();
  assert.equal($('ps-submit').disabled, true);
  assert.match(ui.text($('ps-blockers')), /至少选择一个目标分支/);
});

test('切换目标仓库：跟踪分支不存在时清空选择并提示', async () => {
  const ui = setup();
  await ui.open();
  const { $ } = ui;
  $('ps-repo').value = 'CPF-Flutter/flutter_engine';
  $('ps-repo').dispatchEvent(new ui.window.Event('change'));
  await ui.settle();
  assert.equal($('ps-base-count').textContent, '');
  assert.match(ui.text($('ps-base-hint')), /oh-3\.41\.9-dev 不在这个仓库里/);
  assert.equal($('ps-submit').disabled, true);
  assert.equal($('ps-remote-chips').querySelector('.active'), null);
});

test('目标仓库和本地仓库不是同一个项目时，说明原因并禁止提交，不再提示去 fork', async () => {
  const ui = setup();
  await ui.open();
  const { $ } = ui;
  const before = ui.calls.filter((c) => c.path.includes('/preflight')).length;
  $('ps-repo').value = 'CPF-Flutter/flutter_engine';
  $('ps-repo').dispatchEvent(new ui.window.Event('change'));
  await ui.settle();
  const note = ui.text($('ps-fork'));
  assert.match(note, /这份草稿来自本地仓库 flutter_flutter/);
  assert.match(note, /upstream → CPF-Flutter\/flutter_flutter、 ?origin → alice\/flutter_flutter/);
  assert.match(note, /和 flutter_engine 不是同一个项目/);
  assert.doesNotMatch(note, /git remote add/);
  assert.match(ui.text($('ps-blockers')), /目标仓库和本地仓库不是同一个项目/);
  assert.equal($('ps-submit').disabled, true);
  assert.equal(ui.calls.filter((c) => c.path.includes('/preflight')).length, before, '项目不一致时不去检查 fork');

  $('ps-repo').value = 'CPF-Flutter/flutter_flutter';
  $('ps-repo').dispatchEvent(new ui.window.Event('change'));
  await ui.settle();
  assert.match(ui.text($('ps-fork')), /推送到 fork alice\/flutter_flutter/);
});

test('Issue：分段切换、查找后选中、新建时带出 PR 标题', async () => {
  const ui = setup();
  await ui.open();
  const { $, window } = ui;
  const seg = (mode) => window.document.querySelector(`.ps-seg [data-mode="${mode}"]`);
  assert.equal(seg('none').getAttribute('aria-checked'), 'true');
  assert.equal($('ps-issue-existing').hidden, true);

  seg('existing').click();
  assert.equal($('ps-issue-existing').hidden, false);
  assert.equal($('ps-submit').disabled, true);
  assert.match(ui.text($('ps-blockers')), /从列表里选择一个自己的 Issue/);
  await ui.settle();
  const autoLoaded = ui.calls.filter((c) => c.path.startsWith('/api/pr-submit/issues'));
  assert.equal(autoLoaded.length, 1, '切到关联已有 Issue 时自动列出自己的 Issue');
  assert.match(ui.text($('ps-issue-scope')), /只显示 alice 在 CPF-Flutter\/flutter_flutter 创建的 Issue/);
  const rows = [...$('ps-issue-hits').querySelectorAll('.ps-issue-hit')].map(ui.text);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), ['#2787 键盘遮挡', '#2600 旧问题 已关闭']);

  ui.type($('ps-issue-query'), '#8');
  $('ps-issue-query').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
  await ui.settle();
  assert.match(ui.text($('ps-issue-hits')), /#8 不是你创建的 Issue，不能关联/);
  assert.equal($('ps-submit').disabled, true, '只输入编号不算选择');

  ui.type($('ps-issue-query'), '键盘');
  $('ps-issue-find').click();
  await ui.settle();
  const hit = $('ps-issue-hits').querySelector('.ps-issue-hit');
  assert.match(ui.text(hit), /#2787 键盘遮挡/);
  hit.click();
  assert.match(ui.text($('ps-issue-pick')), /已选择 #2787 键盘遮挡/);
  assert.equal($('ps-submit').disabled, false);
  assert.match(ui.text($('ps-plan')), /Issue：关联 #2787/);

  seg('create').click();
  assert.equal($('ps-issue-create').hidden, false);
  assert.equal($('ps-issue-title').value, 'fix: keyboard inset');
  ui.type($('ps-issue-title'), '');
  assert.match(ui.text($('ps-blockers')), /填写新 Issue 的标题/);
});

test('按真实 diff 自动填充中文 Issue 和英文 PR，生成期间不覆盖用户输入', async () => {
  const ui = setup({ port: { descriptions: { pending: true } } });
  await ui.open();
  const { $ } = ui;
  assert.equal(ui.calls.filter(call => call.path.endsWith('/descriptions')).length, 1);
  ui.type($('ps-body-text'), '用户正在修改的 PR 说明');
  ui.port.releaseDescriptions();
  await ui.settle();
  assert.equal($('ps-body-text').value, '用户正在修改的 PR 说明');
  assert.equal($('ps-issue-title').value, 'fix: keyboard inset');
  assert.match($('ps-issue-desc').value, /复现步骤/);
});

test('手动重新生成可确认覆盖，失败后仍能编辑并继续提交', async () => {
  const ui = setup({ port: { descriptions: { error: 'AI 暂不可用' } } });
  await ui.open();
  const { $ } = ui;
  assert.equal($('ps-title').value, 'fix: keyboard inset');
  assert.match(ui.text($('ps-description-status')), /可以继续手动填写/);
  assert.equal($('ps-pr-regenerate').disabled, false);
  $('ps-pr-regenerate').click();
  await ui.settle();
  assert.match(ui.text($('ps-description-status')), /AI 暂不可用/);
});

test('提交需要点两次，请求体包含所选分支和 Issue', async () => {
  const ui = setup();
  await ui.open();
  const { $, window } = ui;
  window.document.querySelector('.ps-seg [data-mode="existing"]').click();
  await ui.settle();
  $('ps-issue-hits').querySelector('.ps-issue-hit').click();
  assert.equal($('ps-submit').disabled, false);

  $('ps-submit').click();
  assert.match($('ps-submit').textContent, /再点一次/);
  assert.equal($('ps-cancel').hidden, false);
  assert.equal(ui.calls.filter((c) => c.path.endsWith('/submit')).length, 0);
  $('ps-cancel').click();
  assert.equal($('ps-cancel').hidden, true);

  $('ps-submit').click();
  $('ps-submit').click();
  await ui.settle();
  const submit = ui.calls.find((c) => c.path.endsWith('/submit'));
  const payload = JSON.parse(JSON.stringify(submit.body));
  assert.deepEqual(payload.bases, ['oh-3.41.9-dev']);
  assert.equal(payload.target, 'CPF-Flutter/flutter_flutter');
  assert.deepEqual(payload.issue, { mode: 'existing', url: '#2787' });
  assert.equal(payload.title, 'fix: keyboard inset');
  assert.match(ui.text($('ps-result')), /已创建 oh-3\.41\.9-dev PR #10/);
  assert.ok($('ps-result').querySelector('.ps-monitor'));
  assert.equal($('ps-submit').disabled, true);
  assert.match(ui.text($('ps-blockers')), /都已经创建过 PR/);
});

test('未提交文件只提醒；没有 commit、缺 fork、缺令牌时禁用提交并说明原因', async () => {
  let ui = setup({ draft: { ...DRAFT, dirty: true, dirtyFiles: ['fix.patch'], baseSource: 'auto', trackingRef: 'origin/oh-3.41.9-dev' } });
  await ui.open();
  assert.match(ui.text(ui.window.document.querySelector('.ps-status')), /可以提交/);
  assert.match(ui.text(ui.window.document.querySelector('.ps-note.warn')), /1 个文件没有提交，它们不会进入 PR/);
  assert.match(ui.text(ui.window.document.querySelector('.ps-meta')), /对比 origin\/oh-3\.41\.9-dev（自动选择）/);
  assert.equal(ui.$('ps-submit').disabled, false);

  ui = setup({ draft: { ...DRAFT, commits: [], files: [], trackingRef: '' } });
  await ui.open();
  assert.match(ui.text(ui.window.document.querySelector('.ps-status')), /没有新的 commit/);
  assert.match(ui.text(ui.$('ps-body')), /没有找到对比基准/);
  assert.match(ui.text(ui.$('ps-blockers')), /没有新的 commit/);
  assert.equal(ui.$('ps-submit').disabled, true);

  ui = setup({ preflight: { success: true, tokenConfigured: true, login: 'bob', fork: null } });
  await ui.open();
  assert.match(ui.text(ui.$('ps-fork')), /没有 bob 名下的 flutter_flutter fork 远程/);
  assert.match(ui.text(ui.$('ps-blockers')), /添加你自己的 fork 远程/);
  assert.equal(ui.$('ps-submit').disabled, true);

  ui = setup({ preflight: { success: true, tokenConfigured: false, login: '', fork: null } });
  await ui.open();
  assert.match(ui.text(ui.$('ps-fork')), /还没有绑定 GitCode 令牌/);
  assert.match(ui.text(ui.$('ps-blockers')), /绑定 GitCode 令牌/);
});

test('部分失败：只补做失败分支', async () => {
  const draft = {
    ...DRAFT,
    status: 'partial',
    results: {
      issue: null,
      pulls: [
        { base: 'oh-3.41.9-dev', url: 'https://gitcode.com/x/pulls/10', number: 10 },
        { base: 'oh-3.41.9-release', error: 'cherry-pick 冲突' },
      ],
    },
  };
  const ui = setup({ draft });
  await ui.open();
  const { $ } = ui;
  assert.match(ui.text($('ps-result')), /失败 oh-3\.41\.9-release cherry-pick 冲突/);
  assert.match(ui.text($('ps-result')), /只补做失败的 1 个分支/);
  const release = $('ps-branches').querySelector('input[value="oh-3.41.9-release"]');
  release.checked = true;
  release.dispatchEvent(new ui.window.Event('change'));
  assert.equal($('ps-submit').textContent, '确认提交（创建 1 个 PR）');
  assert.match(ui.text($('ps-plan')), /创建 1 个 PR： ?oh-3\.41\.9-release/);
});

test('本次改动：点文件展开 diff，再点收起，读过的不重复请求', async () => {
  const ui = setup();
  await ui.open();
  const { $, window } = ui;
  const [fileA, fileB] = window.document.querySelectorAll('#ps-files .ps-file');
  const diffCalls = () => ui.calls.filter((c) => c.path.includes('/diff?')).length;
  assert.equal(fileA.getAttribute('aria-expanded'), 'false');
  assert.equal($('ps-diff-collapse').hidden, true);

  fileA.click();
  await ui.settle();
  const slotA = fileA.nextElementSibling;
  assert.equal(fileA.getAttribute('aria-expanded'), 'true');
  assert.equal(slotA.hidden, false);
  assert.equal($('ps-diff-collapse').hidden, false);
  assert.match(ui.calls.find((c) => c.path.includes('/diff?')).path, /\/api\/pr-submit\/drafts\/prd-11111111\/diff\?path=lib%2Fa\.dart$/);
  const lines = [...slotA.querySelectorAll('.ps-dl')].map((row) => [row.className.replace('ps-dl', '').trim(), ...[...row.children].map((c) => c.textContent)]);
  assert.deepEqual(JSON.parse(JSON.stringify(lines)), [
    ['hunk', '', '', '@@ -10,3 +10,4 @@ class A {'],
    ['', '10', '10', ' keep();'],
    ['del', '11', '', '-old();'],
    ['add', '', '11', '+fresh();'],
    ['add', '', '12', '+more(<b>);'],
    ['', '12', '13', ' tail();'],
  ], '去掉文件头，行号按 @@ 计算，内容转义');
  assert.equal(slotA.querySelector('.ps-diff b'), null);

  fileA.click();
  assert.equal(fileA.getAttribute('aria-expanded'), 'false');
  assert.equal(slotA.hidden, true);
  assert.equal(slotA.innerHTML, '');
  assert.equal($('ps-diff-collapse').hidden, true, '全部收起后按钮隐藏');

  fileA.click();
  await ui.settle();
  assert.equal(slotA.querySelectorAll('.ps-dl').length, 6);
  assert.equal(diffCalls(), 1, '第二次展开用缓存');

  fileB.click();
  await ui.settle();
  assert.match(ui.text(fileB.nextElementSibling), /本地仓库里找不到这份草稿的提交/);
  assert.equal(window.document.querySelectorAll('#ps-files .ps-file[aria-expanded="true"]').length, 2);

  $('ps-diff-collapse').click();
  assert.equal(window.document.querySelectorAll('#ps-files .ps-file[aria-expanded="true"]').length, 0);
  assert.equal(window.document.querySelectorAll('#ps-files .ps-diff-slot:not([hidden])').length, 0);
  assert.equal($('ps-diff-collapse').hidden, true);
});

test('勾选「提交后开启 PR 监控」：提交成功后自动为新 PR 开启监控，并记住选择', async () => {
  const ui = setup();
  await ui.open();
  const { $, window } = ui;
  assert.equal($('ps-auto-monitor').checked, false);
  assert.match(ui.text($('ps-plan')), /不自动开启 PR 监控/);

  $('ps-auto-monitor').checked = true;
  $('ps-auto-monitor').dispatchEvent(new window.Event('change'));
  assert.match(ui.text($('ps-plan')), /提交成功后为新建的 1 个 PR 开启 PR 监控/);
  assert.equal(window.localStorage.getItem('cpf-pr-submit-auto-monitor'), '1');

  $('ps-submit').click();
  $('ps-submit').click();
  await ui.settle();
  await ui.settle();
  const starts = ui.calls.filter((c) => c.path === '/api/pr-review/monitor/start');
  assert.equal(starts.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(starts[0].body)), { number: '10', repo: 'CPF-Flutter/flutter_flutter' });
  assert.match(ui.text($('ps-result')), /PR #10 监控已开启/);
  assert.equal($('ps-result').querySelector('.ps-monitor'), null);
  assert.ok($('ps-goto-monitor'));

  const again = setup();
  await again.open();
  assert.equal(again.$('ps-auto-monitor').checked, false, '新页面默认不勾选');
  const remembered = setup({ storage: { 'cpf-pr-submit-auto-monitor': '1' } });
  await remembered.open();
  assert.equal(remembered.$('ps-auto-monitor').checked, true, '上次勾选会被记住');
});

test('打开 PR 监控时带上新建 PR 的编号、仓库和 runId', async () => {
  const revealed = [];
  const ui = setup();
  ui.window.revealSubmittedPr = (target) => revealed.push(target);
  await ui.open();
  const { $ } = ui;
  $('ps-auto-monitor').checked = true;
  $('ps-auto-monitor').dispatchEvent(new ui.window.Event('change'));
  $('ps-submit').click();
  $('ps-submit').click();
  await ui.settle();
  await ui.settle();
  $('ps-goto-monitor').click();
  assert.deepEqual(JSON.parse(JSON.stringify(revealed)), [{ number: '10', repo: 'CPF-Flutter/flutter_flutter', runId: 'run-10' }]);
});

test('监控启动只是排队时，结果写明已加入队列，跳转仍带上 PR', async () => {
  const revealed = [];
  const ui = setup({ monitor: { 10: { success: true, queued: true, runId: '', status: 200 } } });
  ui.window.revealSubmittedPr = (target) => revealed.push(target);
  await ui.open();
  const { $ } = ui;
  $('ps-auto-monitor').checked = true;
  $('ps-auto-monitor').dispatchEvent(new ui.window.Event('change'));
  $('ps-submit').click();
  $('ps-submit').click();
  await ui.settle();
  await ui.settle();
  assert.match(ui.text($('ps-result')), /PR #10 已加入启动队列/);
  assert.doesNotMatch(ui.text($('ps-result')), /监控已开启/);
  $('ps-goto-monitor').click();
  assert.deepEqual(JSON.parse(JSON.stringify(revealed[0])), { number: '10', repo: 'CPF-Flutter/flutter_flutter', runId: '' });
});

test('监控页还没有定位函数时，打开按钮仍切换到 PR 监控面板', async () => {
  const panels = [];
  const ui = setup();
  ui.window.switchToPanel = (id) => panels.push(id);
  await ui.open();
  ui.$('ps-submit').click();
  ui.$('ps-submit').click();
  await ui.settle();
  ui.$('ps-result').querySelector('.ps-monitor').click();
  await ui.settle();
  ui.$('ps-goto-monitor').click();
  assert.deepEqual(panels, ['p-prreview']);
});

test('不勾选时提交后不开启监控；手动加入遇到 409 显示已在监控中；失败可重试', async () => {
  let ui = setup({ monitor: { 10: 409 } });
  await ui.open();
  ui.$('ps-submit').click();
  ui.$('ps-submit').click();
  await ui.settle();
  assert.equal(ui.calls.filter((c) => c.path === '/api/pr-review/monitor/start').length, 0);
  ui.$('ps-result').querySelector('.ps-monitor').click();
  await ui.settle();
  assert.match(ui.text(ui.$('ps-result')), /PR #10 已在监控中/);

  ui = setup({ monitor: { 10: 503 }, storage: { 'cpf-pr-submit-auto-monitor': '1' } });
  await ui.open();
  ui.$('ps-submit').click();
  ui.$('ps-submit').click();
  await ui.settle();
  await ui.settle();
  assert.match(ui.text(ui.$('ps-result')), /监控失败 503 重试加入监控/);
  ui.$('ps-result').querySelector('.ps-monitor').click();
  await ui.settle();
  assert.equal(ui.calls.filter((c) => c.path === '/api/pr-review/monitor/start').length, 2);
});

test('目标仓库不在 CPF-Flutter 组织时，自动监控勾选框不可用并说明原因', async () => {
  const ui = setup({ storage: { 'cpf-pr-submit-auto-monitor': '1' } });
  await ui.open();
  const { $ } = ui;
  assert.equal($('ps-monitor-hint').hidden, true);
  assert.match(ui.text($('ps-plan')), /开启 PR 监控/);
  $('ps-remote-chips').querySelector('[data-repo="alice/flutter_flutter"]').click();
  await ui.settle();
  assert.equal($('ps-auto-monitor').disabled, true);
  assert.equal($('ps-monitor-hint').hidden, false);
  assert.match(ui.text($('ps-monitor-hint')), /只支持 CPF-Flutter 组织/);
  assert.match(ui.text($('ps-plan')), /不自动开启 PR 监控/);
});

test('没有草稿编号时列出最近草稿，点击后打开', async () => {
  const ui = setup({
    url: 'http://127.0.0.1:8080/#p-prsubmit',
    drafts: [{ id: 'prd-11111111', createdAt: DRAFT.createdAt, repoPath: '/work/flutter_flutter', headBranch: 'fix/keyboard', title: 'fix: keyboard inset', commits: 1, dirty: false, pulls: 0 }],
  });
  await ui.open();
  const item = ui.window.document.querySelector('.ps-recent-item');
  assert.match(ui.text(item), /fix: keyboard inset/);
  assert.match(ui.text(item), /flutter_flutter · fix\/keyboard · 1 个 commit/);
  item.click();
  await ui.settle();
  assert.equal(new URL(ui.window.location.href).searchParams.get('draft'), 'prd-11111111');
  assert.equal(ui.$('ps-repo').value, 'CPF-Flutter/flutter_flutter');
});

test('草稿不存在时显示提示，可以返回草稿列表', async () => {
  const ui = setup({ draft: null, url: 'http://127.0.0.1:8080/?draft=prd-99999999#p-prsubmit' });
  await ui.open();
  assert.match(ui.text(ui.$('ps-body')), /草稿不存在/);
  ui.window.document.querySelector('[data-ps-back]').click();
  await ui.settle();
  assert.equal(ui.window.location.search, '');
  assert.match(ui.text(ui.$('ps-body')), /选择一份草稿/);
});

const RECENT = [
  { id: 'prd-11111111', createdAt: DRAFT.createdAt, repoPath: '/work/flutter_flutter', headBranch: 'fix/keyboard', title: 'fix: keyboard inset', commits: 1, dirty: false, pulls: 0 },
  { id: 'prd-22222222', createdAt: '2026-11-12T08:00:00.000Z', repoPath: '/work/flutter_engine', headBranch: 'fix/old', title: 'fix: old', commits: 2, dirty: false, pulls: 1 },
];

test('从列表打开草稿后，「草稿列表」按钮和浏览器后退都能回到列表，并标出刚才查看的草稿', async () => {
  const ui = setup({ url: 'http://127.0.0.1:8080/#p-prsubmit', drafts: RECENT });
  await ui.open();
  const { window } = ui;
  window.document.querySelector('.ps-recent-item[data-id="prd-11111111"]').click();
  await ui.settle();
  assert.equal(new URL(window.location.href).searchParams.get('draft'), 'prd-11111111');
  assert.equal(window.history.state?.psFromList, true);
  assert.equal(window.history.length, 2, '打开草稿是新的一条历史记录');

  window.document.querySelector('[data-ps-back]').click();
  await new Promise((r) => setTimeout(r, 20));
  await ui.settle();
  assert.equal(window.location.search, '');
  assert.equal(window.location.hash, '#p-prsubmit');
  const last = window.document.querySelector('.ps-recent-item.last');
  assert.equal(last?.dataset.id, 'prd-11111111');
  assert.match(ui.text(last), /刚才查看/);

  window.history.forward();
  await new Promise((r) => setTimeout(r, 20));
  await ui.settle();
  assert.equal(ui.$('ps-repo').value, 'CPF-Flutter/flutter_flutter', '前进键重新打开草稿');

  window.history.back();
  await new Promise((r) => setTimeout(r, 20));
  await ui.settle();
  assert.match(ui.text(ui.$('ps-body')), /选择一份草稿/, '浏览器后退回到列表');
});

test('直接打开草稿链接时，「草稿列表」新开一条历史记录回到列表', async () => {
  const ui = setup({ drafts: RECENT });
  await ui.open();
  const { window } = ui;
  window.document.querySelector('[data-ps-back]').click();
  await ui.settle();
  assert.equal(window.location.search, '');
  assert.equal(window.history.length, 2);
  assert.equal(window.document.querySelector('.ps-recent-item.last')?.dataset.id, 'prd-11111111');
});

test('提交进行中时「草稿列表」按钮不可用', async () => {
  const ui = setup();
  let release;
  const original = ui.window.authApi;
  ui.window.authApi = (method, path, body) => (path.endsWith('/submit')
    ? new Promise((resolve) => { release = () => resolve(original(method, path, body)); })
    : original(method, path, body));
  await ui.open();
  const back = ui.window.document.querySelector('[data-ps-back]');
  ui.$('ps-submit').click();
  ui.$('ps-submit').click();
  await ui.settle();
  assert.equal(back.disabled, true);
  back.click();
  assert.equal(new URL(ui.window.location.href).searchParams.get('draft'), 'prd-11111111');
  release();
  await ui.settle();
  await ui.settle();
  assert.equal(back.disabled, false);
  assert.match(ui.text(ui.$('ps-result')), /PR #10/);
});

const SAME_B = 'diff --git a/lib/b.dart b/lib/b.dart\n--- a/lib/b.dart\n+++ b/lib/b.dart\n@@ -1 +1 @@\n-x\n+y';

function pickCheck(overrides = {}) {
  return {
    kind: 'pick',
    from: 'oh-3.41.9-dev',
    to: 'oh-3.41.9-release',
    key: 'pick:prd-11111111:oh-3.41.9-release:f00',
    files: [
      { path: 'lib/a.dart', status: 'adapted', source: DIFF_A, target: DIFF_A.replace('fresh()', 'freshRelease()') },
      { path: 'lib/b.dart', status: 'same', source: SAME_B, target: SAME_B },
    ],
    summary: { same: 1, adapted: 1, missing: 0, extra: 0 },
    verification: null,
    ...overrides,
  };
}

function check(ui, base) {
  const input = ui.$('ps-branches').querySelector(`input[value="${base}"]`);
  input.checked = true;
  input.dispatchEvent(new ui.window.Event('change'));
}

test('勾选其他分支：自动预演移植，逐文件对照，写说明确认后才能提交', async () => {
  const ui = setup({
    port: {
      previews: { 'oh-3.41.9-release': { ok: true, empty: false, sha: 'f00', baseSha: 'b00', conflicts: [] } },
      checks: { 'oh-3.41.9-release': pickCheck() },
    },
  });
  await ui.open();
  const { $, window } = ui;
  assert.equal($('ps-port').hidden, true, '只提跟踪分支时不需要移植核对');

  check(ui, 'oh-3.41.9-release');
  await ui.settle();
  const preview = ui.calls.find((c) => c.path.endsWith('/preview'));
  assert.deepEqual(JSON.parse(JSON.stringify(preview.body)), { repo: 'CPF-Flutter/flutter_flutter', base: 'oh-3.41.9-release' });
  assert.equal($('ps-port').hidden, false);
  assert.equal($('ps-port-count').textContent, '已核对 0 / 1');
  const entry = $('ps-port-list').querySelector('.ps-port-entry');
  assert.match(ui.text(entry.querySelector('.ps-port-head')), /oh-3\.41\.9-dev → oh-3\.41\.9-release 自动 cherry-pick 待核对/);
  assert.match(ui.text(entry), /有适配 1 一致 1/);
  assert.equal($('ps-submit').disabled, true);
  assert.match(ui.text($('ps-blockers')), /在「移植核对」里确认 oh-3\.41\.9-dev → oh-3\.41\.9-release/);
  assert.match(ui.text($('ps-plan')), /oh-3\.41\.9-release 推送「移植核对」里确认过的那份代码/);

  const [fileA] = entry.querySelectorAll('.ps-pf');
  assert.match(ui.text(fileA), /lib\/a\.dart 有适配/);
  fileA.click();
  const sides = fileA.nextElementSibling.querySelectorAll('.ps-pf-side');
  assert.equal(sides.length, 2);
  assert.match(ui.text(sides[0]), /源分支 oh-3\.41\.9-dev 的改动.*\+fresh\(\);/);
  assert.match(ui.text(sides[1]), /目标分支 oh-3\.41\.9-release 上的改动.*\+freshRelease\(\);/);
  fileA.click();
  assert.equal(fileA.nextElementSibling.hidden, true);
  fileA.click();

  const verify = entry.querySelector('[data-act="verify"]');
  const note = entry.querySelector('.ps-port-note');
  assert.equal(verify.disabled, true, '有不一致的文件时必须写说明');
  assert.match(note.placeholder, /有 1 个文件和源分支不一致/);
  ui.type(note, 'release 分支上方法叫 freshRelease，已编译验证');
  assert.equal(verify.disabled, false);
  verify.click();
  await ui.settle();
  const sent = ui.calls.find((c) => c.path.endsWith('/verify'));
  assert.deepEqual(JSON.parse(JSON.stringify(sent.body)), { base: 'oh-3.41.9-release', key: 'pick:prd-11111111:oh-3.41.9-release:f00', note: 'release 分支上方法叫 freshRelease，已编译验证' });
  const done = $('ps-port-list').querySelector('.ps-port-entry');
  assert.match(ui.text(done.querySelector('.ps-port-head')), /已核对/);
  assert.match(ui.text(done), /已核对 · alice · .* · release 分支上方法叫 freshRelease，已编译验证/);
  assert.equal(done.querySelector('.ps-pf').getAttribute('aria-expanded'), 'true', '重新渲染保留展开的文件');
  assert.equal($('ps-port-count').textContent, '已核对 1 / 1');
  assert.equal($('ps-blockers').hidden, true);
  assert.equal($('ps-submit').disabled, false);
  assert.equal(window.document.querySelectorAll('.ps-port-note').length, 0);
});

test('移植预演有冲突、已包含、出错时分别说明，可以直接取消这个分支', async () => {
  const ui = setup({
    port: {
      previews: {
        'oh-3.41.9-release': { ok: false, empty: false, sha: '', baseSha: 'b00', conflicts: ['lib/a.dart'], conflictCommit: 'abcdef1234567890', reason: '有冲突' },
        'oh-3.35.7-dev': { ok: true, empty: true, sha: 'b01', baseSha: 'b01', conflicts: [] },
      },
    },
  });
  await ui.open();
  const { $ } = ui;
  for (const base of ['oh-3.41.9-release', 'oh-3.35.7-dev', 'master']) check(ui, base);
  await ui.settle();
  const entries = () => [...$('ps-port-list').querySelectorAll('.ps-port-entry')];
  const byBase = (base) => entries().find((el) => el.dataset.base === base);
  assert.equal(entries().length, 3);
  assert.match(ui.text(byBase('oh-3.41.9-release')), /有冲突.*abcdef12.*lib\/a\.dart.*ace pr port oh-3\.41\.9-release/);
  assert.match(ui.text(byBase('oh-3.35.7-dev')), /已包含.*已经包含这些改动/);
  assert.match(ui.text(byBase('master')), /出错 预演失败：找不到分支/);
  const blockers = ui.text($('ps-blockers'));
  assert.match(blockers, /oh-3\.41\.9-release 预演有冲突：取消勾选，或用 ace pr port oh-3\.41\.9-release 在独立目录移植/);
  assert.match(blockers, /oh-3\.35\.7-dev 已经包含这些改动，取消勾选/);
  assert.match(blockers, /master：预演失败：找不到分支/);
  assert.equal(ui.calls.filter((c) => c.path.endsWith('/port-check')).length, 0, '没有可核对结果时不请求对比');

  byBase('master').querySelector('[data-act="retry"]').click();
  await ui.settle();
  assert.equal(ui.calls.filter((c) => c.path.endsWith('/preview') && c.body.base === 'master').length, 2);

  byBase('oh-3.41.9-release').querySelector('[data-act="drop"]').click();
  byBase('oh-3.35.7-dev').querySelector('[data-act="drop"]').click();
  assert.doesNotMatch(ui.text($('ps-base-chips')), /oh-3\.41\.9-release|oh-3\.35\.7-dev/);
  assert.equal($('ps-branches').querySelector('input[value="oh-3.41.9-release"]').checked, false);
  $('ps-branches').querySelector('input[value="master"]').click();
  await ui.settle();
  assert.equal($('ps-port').hidden, true);
  assert.equal($('ps-submit').disabled, false);
});

test('ace pr port 生成的移植草稿：提交自己的分支前也要核对，全部一致时不用写说明', async () => {
  const draft = { ...DRAFT, port: { fromBranch: 'fix/keyboard-main', sourceBase: 'aaa', sourceHead: 'bbb', targetBranch: 'oh-3.41.9-dev' } };
  const ui = setup({
    draft,
    port: {
      checks: {
        '': {
          kind: 'port', from: 'fix/keyboard-main', to: 'oh-3.41.9-dev', key: 'sha:abc',
          files: [{ path: 'lib/b.dart', status: 'same', source: SAME_B, target: SAME_B }],
          summary: { same: 1, adapted: 0, missing: 0, extra: 0 }, verification: null,
        },
      },
    },
  });
  await ui.open();
  const { $ } = ui;
  assert.match(ui.text(ui.window.document.querySelector('.ps-meta')), /移植自 fix\/keyboard-main/);
  assert.equal($('ps-port').hidden, false);
  const entry = $('ps-port-list').querySelector('.ps-port-entry');
  assert.match(ui.text(entry.querySelector('.ps-port-head')), /fix\/keyboard-main → oh-3\.41\.9-dev ace pr port 移植 待核对/);
  assert.equal(entry.querySelector('[data-act="retry"]'), null, '移植分支没有预演');
  assert.equal(ui.calls.filter((c) => c.path.endsWith('/preview')).length, 0);
  assert.equal($('ps-submit').disabled, true);
  const verify = entry.querySelector('[data-act="verify"]');
  assert.equal(verify.disabled, false);
  verify.click();
  await ui.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find((c) => c.path.endsWith('/verify')).body)), { base: '', key: 'sha:abc', note: '' });
  assert.equal($('ps-submit').disabled, false);
});

test('草稿列表：同一个问题的多分支草稿折叠成一组，显示每个分支的状态', async () => {
  const drafts = [
    { id: 'prd-a0000001', createdAt: '2026-11-14T10:00:00.000Z', repoPath: '/w/flutter-ports/oh-3.35', headBranch: 'fix-port-oh-3.35', trackingBranch: 'oh-3.35', groupId: 'prg-aaaaaaaa', port: { fromBranch: 'fix', verified: false }, title: 'fix: locale', commits: 2, dirty: false, pulls: 0, pullList: [] },
    { id: 'prd-a0000002', createdAt: '2026-11-14T09:00:00.000Z', repoPath: '/w/flutter', headBranch: 'fix', trackingBranch: 'main', groupId: 'prg-aaaaaaaa', port: null, title: 'fix: locale', commits: 1, dirty: false, pulls: 2, pullList: [{ base: 'main', number: '100' }, { base: 'br_3.41', number: '101' }] },
    { id: 'prd-a0000003', createdAt: '2026-11-14T08:00:00.000Z', repoPath: '/w/flutter', headBranch: 'fix', trackingBranch: 'main', groupId: '', port: null, title: 'fix: locale 旧', commits: 1, dirty: false, pulls: 0, pullList: [] },
    { id: 'prd-b0000001', createdAt: '2026-11-14T07:00:00.000Z', repoPath: '/w/engine', headBranch: 'x', trackingBranch: 'main', groupId: 'prg-bbbbbbbb', port: null, title: 'other', commits: 1, dirty: false, pulls: 0, pullList: [] },
  ];
  const ui = setup({ url: 'http://127.0.0.1:8080/#p-prsubmit', drafts });
  await ui.open();
  const { window } = ui;
  const top = [...ui.$('ps-recent').children];
  assert.equal(top.length, 2);
  assert.ok(top[0].classList.contains('ps-group'));
  assert.ok(top[1].classList.contains('ps-recent-item'), '只有一份草稿的组照常显示');
  const head = top[0].querySelector('.ps-group-head');
  assert.match(ui.text(head), /fix: locale 3 份草稿/);
  assert.match(ui.text(head.querySelector('.ps-recent-meta')), /^flutter · 最近 /);
  const chips = [...head.querySelectorAll('.ps-gchip')].map((el) => ui.text(el));
  assert.deepEqual(chips, ['oh-3.35 · 待核对', 'main · PR #100', 'br_3.41 · PR #101']);
  const body = top[0].querySelector('.ps-group-body');
  assert.equal(body.hidden, true);
  head.click();
  assert.equal(body.hidden, false);
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  const items = [...body.querySelectorAll('.ps-recent-item')];
  assert.equal(items.length, 3);
  assert.match(ui.text(items[0]), /移植自 fix.*→ oh-3\.35 · 2 个 commit/);
  assert.ok(items[2].classList.contains('stale'), '同一分支更早的草稿变淡');
  assert.match(ui.text(items[2]), /较早的草稿/);
  items[0].click();
  await ui.settle();
  assert.equal(new URL(window.location.href).searchParams.get('draft'), 'prd-a0000001');

  window.document.querySelector('[data-ps-back]').click();
  await new Promise((r) => setTimeout(r, 20));
  await ui.settle();
  const reopened = window.document.querySelector('.ps-group');
  assert.ok(reopened.classList.contains('open'), '回到列表时刚才查看的草稿所在组保持展开');
  assert.equal(reopened.querySelector('.ps-recent-item.last')?.dataset.id, 'prd-a0000001');
});
