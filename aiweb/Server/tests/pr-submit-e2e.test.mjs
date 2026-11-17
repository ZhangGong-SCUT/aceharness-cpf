import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectRepo } from '../../../scripts/pr-submit-collect.mjs';
import { validateSubmitRequest } from '../../../scripts/pr-submit-plan.mjs';
import {
  portCheck, previewBase, searchIssues, submitDraft, verifyPort,
} from '../prSubmit/service.js';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function commitFile(cwd, file, text, message) {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

function fakeGitcode() {
  const calls = [];
  let nextPull = 100;
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = new URL(url).pathname.replace(/^\/api\/v5/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, query: new URL(url).searchParams, body, auth: init.headers?.Authorization || '' });
    const reply = (status, data) => new Response(JSON.stringify(data), { status });
    if (method === 'POST' && /\/repos\/[^/]+\/[^/]+\/issues$/.test(path)) {
      return reply(201, { number: 42, title: body.title, html_url: 'https://gitcode.com/CPF-Flutter/flutter_flutter/issues/42' });
    }
    if (method === 'GET' && path === '/user') return reply(200, { login: 'Me' });
    if (method === 'GET' && /\/issues\/7$/.test(path)) {
      return reply(200, { number: 7, title: '已有问题', state: 'open', user: { login: 'me' }, html_url: 'https://gitcode.com/CPF-Flutter/flutter_flutter/issues/7' });
    }
    if (method === 'GET' && /\/issues\/8$/.test(path)) {
      return reply(200, { number: 8, title: '别人的问题', state: 'open', user: { login: 'other' }, html_url: 'https://gitcode.com/CPF-Flutter/flutter_flutter/issues/8' });
    }
    if (method === 'GET' && /\/repos\/[^/]+\/[^/]+\/issues$/.test(path)) {
      return reply(200, [
        { number: 5, title: 'locale 回退已关闭', state: 'closed', user: { login: 'me' } },
        { number: 8, title: '别人的 locale 问题', state: 'open', user: { login: 'other' } },
        { number: 7, title: 'locale 回退', state: 'open', user: { login: 'ME' } },
      ]);
    }
    if (method === 'GET' && /\/pulls\/\d+$/.test(path)) {
      return reply(200, {
        number: path.match(/(\d+)$/)[1],
        body: '## Why are these changes being made?\n\n#42',
        related_issues: [
          { number: '42', title: 'locale' },
          { number: '5', title: '旧问题' },
        ],
      });
    }
    if (method === 'POST' && /\/pulls\/\d+\/comments$/.test(path)) {
      return reply(201, { body: body?.body || '' });
    }
    if (method === 'POST' && path.endsWith('/pulls')) {
      const number = nextPull++;
      return reply(201, { number, html_url: `https://gitcode.com/CPF-Flutter/flutter_flutter/pull/${number}` });
    }
    return reply(404, { message: 'not found' });
  };
  return { calls, fetch };
}

test('多个目标分支：其他分支先预演并核对才推送，目标分支有新提交要重新核对，冲突分支不提交', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ace-pr-e2e-'));
  const saved = {
    fetch: globalThis.fetch,
    ACE_HOME: process.env.ACE_HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  t.after(() => {
    globalThis.fetch = saved.fetch;
    for (const key of ['ACE_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  process.env.ACE_HOME = join(root, 'ace-home');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = join(root, 'empty.gitconfig');
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

  const host = join(root, 'gitcode');
  const upstream = join(host, 'CPF-Flutter', 'flutter_flutter.git');
  const fork = join(host, 'me', 'flutter_flutter.git');
  mkdirSync(join(host, 'CPF-Flutter'), { recursive: true });
  mkdirSync(join(host, 'me'), { recursive: true });
  git(root, 'init', '-q', '--bare', upstream);
  git(root, 'init', '-q', '--bare', fork);

  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 'seed@example.com');
  git(seed, 'config', 'user.name', 'seed');
  writeFileSync(join(seed, 'a.txt'), 'base\n');
  commitFile(seed, 'b.txt', 'base\n', 'base');
  git(seed, 'push', '-q', upstream, 'main');
  git(seed, 'checkout', '-q', '-b', 'br_3.41_dev');
  commitFile(seed, 'b.txt', 'release\n', 'release line');
  git(seed, 'push', '-q', upstream, 'br_3.41_dev');
  git(seed, 'checkout', '-q', 'main');
  git(seed, 'checkout', '-q', '-b', 'oh-conflict');
  commitFile(seed, 'a.txt', 'other\n', 'conflicting change');
  git(seed, 'push', '-q', upstream, 'oh-conflict');

  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'topic');
  git(work, 'config', 'user.email', 'me@example.com');
  git(work, 'config', 'user.name', 'me');
  git(work, 'remote', 'add', 'origin', 'https://gitcode.com/me/flutter_flutter.git');
  git(work, 'remote', 'add', 'upstream', 'https://gitcode.com/CPF-Flutter/flutter_flutter.git');
  git(work, 'fetch', '-q', upstream, 'main:refs/remotes/upstream/main');
  git(work, 'reset', '-q', '--hard', 'refs/remotes/upstream/main');
  git(work, 'branch', '--set-upstream-to', 'upstream/main');
  commitFile(work, 'a.txt', 'fixed\n', '修复空语言时的 locale 回退');

  const draft = await collectRepo(work, 'prd-ab12cd34');
  assert.equal(draft.suggestedTarget, 'CPF-Flutter/flutter_flutter');
  assert.equal(draft.trackingBranch, 'main');
  assert.equal(draft.commits.length, 1);
  assert.equal(draft.dirty, false);

  writeFileSync(process.env.GIT_CONFIG_GLOBAL, `[url "${pathToFileURL(host).href}/"]\n\tinsteadOf = https://gitcode.com/\n`);
  const api = fakeGitcode();
  globalThis.fetch = api.fetch;

  const plan = validateSubmitRequest(draft, {
    target: 'CPF-Flutter/flutter_flutter',
    bases: ['main', 'br_3.41_dev', 'oh-conflict'],
    title: '修复空语言时的 locale 回退',
    body: '空语言时回退到系统语言。',
    issue: { mode: 'create', title: 'locale 为空时没有回退', body: '复现步骤见说明' },
  });
  assert.equal(plan.ok, true, plan.errors.join('\n'));

  const result = await submitDraft(draft, plan, 'test-token', 'me');

  assert.equal(result.status, 'partial');
  assert.equal(result.results.issue.number, '42');
  let byBase = Object.fromEntries(result.results.pulls.map((row) => [row.base, row]));
  assert.equal(byBase.main.number, '100');
  assert.match(byBase['br_3.41_dev'].error, /还没有预演移植/);
  assert.match(byBase['oh-conflict'].error, /还没有预演移植/);

  const target = 'CPF-Flutter/flutter_flutter';
  const releasePreview = await previewBase(draft, 'test-token', target, 'br_3.41_dev');
  assert.equal(releasePreview.ok, true);
  assert.equal(releasePreview.empty, false);
  const conflictPreview = await previewBase(draft, 'test-token', target, 'oh-conflict');
  assert.equal(conflictPreview.ok, false);
  assert.deepEqual(conflictPreview.conflicts, ['a.txt']);
  result.previews = { 'br_3.41_dev': releasePreview, 'oh-conflict': conflictPreview };
  assert.equal(git(work, 'status', '--porcelain'), '');
  assert.equal(git(work, 'worktree', 'list').split('\n').length, 1);

  const retryRequest = {
    target,
    bases: ['main', 'br_3.41_dev', 'oh-conflict'],
    title: '修复空语言时的 locale 回退',
    body: '空语言时回退到系统语言。',
    issue: { mode: 'create', title: 'locale 为空时没有回退' },
  };
  let retry = validateSubmitRequest(result, retryRequest);
  assert.deepEqual(retry.pending, ['br_3.41_dev', 'oh-conflict']);
  await assert.rejects(() => submitDraft(result, retry, 'test-token', 'me'), /还没有完成移植核对/);

  const check = await portCheck(result, 'br_3.41_dev');
  assert.equal(check.kind, 'pick');
  assert.deepEqual(check.summary, { same: 1, adapted: 0, missing: 0, extra: 0 });
  assert.equal(check.verification, null);
  await assert.rejects(() => verifyPort(result, 'br_3.41_dev', 'pick:stale', '', 'me'), /已经变化/);
  await verifyPort(result, 'br_3.41_dev', check.key, '', 'me');
  assert.equal((await portCheck(result, 'br_3.41_dev')).verification.by, 'me');

  git(seed, 'checkout', '-q', 'br_3.41_dev');
  commitFile(seed, 'b.txt', 'release 2\n', 'release moves on');
  git(seed, 'push', '-q', upstream, 'br_3.41_dev');
  const moved = await submitDraft(result, retry, 'test-token', 'me');
  byBase = Object.fromEntries(moved.results.pulls.map((row) => [row.base, row]));
  assert.match(byBase['br_3.41_dev'].error, /有新的提交，请重新预演并核对/);
  assert.match(byBase['oh-conflict'].error, /预演有冲突/);

  const fresh = await previewBase(draft, 'test-token', target, 'br_3.41_dev');
  assert.notEqual(fresh.sha, releasePreview.sha);
  moved.previews = { ...moved.previews, 'br_3.41_dev': fresh };
  const recheck = await portCheck(moved, 'br_3.41_dev');
  assert.notEqual(recheck.key, check.key);
  assert.equal(recheck.verification, null);
  await verifyPort(moved, 'br_3.41_dev', recheck.key, '', 'me');
  retry = validateSubmitRequest(moved, retryRequest);
  const again = await submitDraft(moved, retry, 'test-token', 'me');
  byBase = Object.fromEntries(again.results.pulls.map((row) => [row.base, row]));
  assert.equal(byBase['br_3.41_dev'].number, '101');
  assert.match(byBase['oh-conflict'].error, /预演有冲突/);
  assert.equal(again.status, 'partial');

  const mainBranch = 'submit/ab12cd34/main';
  const releaseBranch = 'submit/ab12cd34/br_3.41_dev';
  assert.equal(git(root, '--git-dir', fork, 'rev-parse', mainBranch), draft.headSha);
  assert.equal(git(root, '--git-dir', fork, 'rev-parse', releaseBranch), fresh.sha);
  assert.equal(git(root, '--git-dir', fork, 'show', `${releaseBranch}:a.txt`), 'fixed');
  assert.equal(git(root, '--git-dir', fork, 'show', `${releaseBranch}:b.txt`), 'release 2');
  assert.match(git(root, '--git-dir', fork, 'log', '-1', '--format=%B', releaseBranch), /cherry picked from commit/);
  assert.throws(() => git(root, '--git-dir', fork, 'rev-parse', '--verify', 'refs/heads/submit/ab12cd34/oh-conflict'));
  assert.throws(() => git(root, '--git-dir', upstream, 'rev-parse', '--verify', `refs/heads/${mainBranch}`));

  const pullCalls = api.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/pulls'));
  assert.equal(pullCalls.length, 2);
  for (const call of pullCalls) {
    assert.equal(call.path, '/repos/CPF-Flutter/flutter_flutter/pulls');
    assert.match(call.body.head, /^me:submit\/ab12cd34\//);
    assert.match(call.body.body, /## Why are these changes being made\?/);
    assert.match(call.body.body, /#42\b/);
    assert.match(call.body.body, new RegExp(call.body.base));
    assert.equal(call.auth, 'Bearer test-token');
  }
  const comments = api.calls.filter((item) => item.method === 'POST' && /\/pulls\/\d+\/comments$/.test(item.path));
  assert.equal(comments.length, 2);
  for (const item of comments) assert.equal(item.body.body, 'start build');
  for (const row of again.results.pulls.filter((item) => item.url)) {
    assert.match(row.linkWarning, /#5/);
    assert.equal(row.build, 'started');
  }
  assert.equal(api.calls.filter((call) => /\/repos\/[^/]+\/[^/]+\/issues$/.test(call.path) && call.method === 'POST').length, 1);
  assert.equal(again.results.issue.number, '42');
  assert.equal(again.results.pulls.filter((row) => row.url).length, 2);
  assert.equal(git(work, 'status', '--porcelain'), '');
  assert.equal(git(work, 'worktree', 'list').split('\n').length, 1);

  const pullsBefore = api.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/pulls')).length;
  const others = validateSubmitRequest(draft, {
    target: 'CPF-Flutter/flutter_flutter', bases: ['main'], title: 'x', issue: { mode: 'existing', url: '#8' },
  });
  await assert.rejects(() => submitDraft(draft, others, 'test-token', 'me'), /#8 不是 Me 创建的 Issue/);
  assert.equal(api.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/pulls')).length, pullsBefore);
});

test('查找 Issue 只返回令牌账号自己创建的', async (t) => {
  const saved = globalThis.fetch;
  t.after(() => { globalThis.fetch = saved; });
  const api = fakeGitcode();
  globalThis.fetch = api.fetch;

  const list = await searchIssues('own-token', 'CPF-Flutter/flutter_flutter', 'locale');
  assert.equal(list.login, 'Me');
  assert.deepEqual(list.issues.map((item) => [item.number, item.state]), [['7', 'open'], ['5', 'closed']]);
  const listCall = api.calls.find((call) => call.path === '/repos/CPF-Flutter/flutter_flutter/issues');
  assert.equal(listCall.query.get('creator'), 'Me');
  assert.equal(listCall.query.get('state'), 'all');

  assert.deepEqual((await searchIssues('own-token', 'CPF-Flutter/flutter_flutter', '#7')).issues.map((item) => item.number), ['7']);
  const other = await searchIssues('own-token', 'CPF-Flutter/flutter_flutter', 'https://gitcode.com/CPF-Flutter/flutter_flutter/issues/8');
  assert.deepEqual(other.issues, []);
  assert.equal(other.hidden, 1);
  assert.equal(api.calls.filter((call) => call.path === '/user').length, 1, '账号查询会缓存');
});

test('关联已有 Issue 时只读取它，不新建；没有 fork 时拒绝推送', async (t) => {
  const saved = globalThis.fetch;
  t.after(() => { globalThis.fetch = saved; });
  const api = fakeGitcode();
  globalThis.fetch = api.fetch;
  const draft = {
    id: 'prd-00000001', status: 'draft', dirty: false, repoPath: '/nonexistent',
    commits: [{ sha: 'a', subject: 'x' }],
    remotes: [{ name: 'upstream', owner: 'CPF-Flutter', repo: 'flutter_flutter' }],
  };
  const plan = validateSubmitRequest(draft, {
    target: 'CPF-Flutter/flutter_flutter', bases: ['main'], title: 'x', issue: { mode: 'existing', url: '#7' },
  });
  assert.equal(plan.ok, true);
  await assert.rejects(() => submitDraft(draft, plan, 'test-token', 'me'), /fork/);
  assert.equal(api.calls.length, 0);
});
