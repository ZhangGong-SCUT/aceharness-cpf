import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { gitcodeReadPages } from '../../../skills/gitcode-pr-review/scripts/gitcode-read.mjs';

const simulator = resolve(fileURLToPath(new URL('./gitcode-simulator.mjs', import.meta.url)));
const diffScript = resolve(fileURLToPath(new URL('../../../skills/gitcode-pr-review/scripts/fetch-pr-diff.mjs', import.meta.url)));
const gateScript = resolve(fileURLToPath(new URL('../../../skills/gitcode-pr-review/scripts/check-pr-gates.mjs', import.meta.url)));
const commentScript = resolve(fileURLToPath(new URL('../../../skills/gitcode-pr-review/scripts/post-pr-comment.mjs', import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'gitcode-simulator-test-'));
let child;
let webhookServer;
let base;
let output = '';
let client;

before(async () => {
  // 用本地成功响应代替必然 ECONNREFUSED 的假 webhook，隔离平台入队逻辑与模拟器 API 测试。
  webhookServer = createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  });
  webhookServer.listen(0, '127.0.0.1');
  await once(webhookServer, 'listening');
  const webhookBase = `http://127.0.0.1:${webhookServer.address().port}`;
  child = spawn(process.execPath, [simulator, '--port', '0', '--root', root,
    '--ace-webhook', `${webhookBase}/webhook`], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('error', (error) => { output += `\n模拟器进程错误: ${error.stack}\n`; });
  child.on('exit', (code, signal) => { output += `\n模拟器退出: code=${code} signal=${signal}\n`; });
  for (let attempt = 0; attempt < 100 && !base; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    base = output.match(/监听 (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || '';
  }
  assert.ok(base, `模拟器未启动: ${output}`);
  process.env.GITCODE_API_ROOT = `${base}/api/v5`;
  process.env.GITCODE_ORG_API_ROOT = `${base}/api/v5`;
  client = await import('../prReview/client.js');
});

after(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  rmSync(root, { recursive: true, force: true });
  if (webhookServer) {
    webhookServer.closeIdleConnections();
    webhookServer.closeAllConnections();
    await new Promise((resolve) => webhookServer.close(resolve));
  }
});

beforeEach(async (context) => {
  output = '';
  const response = await fetch(`${base}/_sim/reset`);
  assert.equal(response.status, 200);
  await sim('settings', { webhookTimeoutMs: 50 });
  const empty = await api('/repos/CPF-Flutter/flutter_flutter/pulls?state=open');
  assert.equal(empty.response.status, 200);
  assert.deepEqual(empty.body, []);
  context.after(() => {
    if (context.error) process.stderr.write(`\n模拟器失败现场:\n${output}\n`);
  });
});

async function sim(path, body) {
  const response = await fetch(`${base}/_sim/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.ok, `${path}: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function api(path, options = {}) {
  const response = await fetch(`${base}/api/v5${path}`, options);
  return { response, body: await response.json() };
}

/** 测试夹具批量造数据使用内置 HTTP 客户端，避免依赖第三方 fetch 调度器。 */
function postComment(body, token = 'sim-login-alice') {
  return new Promise((resolve, reject) => {
    const target = new URL(`${base}/api/v5/repos/CPF-Flutter/flutter_flutter/pulls/100/comments`);
    const req = httpRequest(target, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      agent: false,
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 201) return reject(new Error(`评论失败 ${res.statusCode}: ${raw}`));
        resolve(JSON.parse(raw));
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify({ body }));
  });
}

async function registerPr(number = 100, extra = {}) {
  await sim('pr', {
    owner: 'CPF-Flutter', repo: 'flutter_flutter', number,
    author: 'z2036709353', head_repo: 'z2036709353/flutter_flutter', ...extra,
  });
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function runScript(script, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, ...args, '--token', 'test-token'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITCODE_API_ROOT: `${base}/api/v5`,
        ACE_GITCODE_DCP_REPORT: '0',
        ACE_GITCODE_GATE_LOGS: '0',
        ACE_GITCODE_PR_AUTHOR: 'z2036709353',
      },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${script} 失败: ${error.message}\n${stdout}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

test('PR 提交可搜索自己创建的 Issue，AIWeb 列表和仓库文件接口兼容', async () => {
  const issue = await api('/repos/CPF-Flutter/flutter_flutter/issues', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ title: '测试 Issue', body: '本地模拟' }),
  });
  assert.equal(issue.response.status, 201);
  await sim('git-push', { fork: 'z2036709353/flutter_flutter', branch: 'feature-sim', sha: 'd'.repeat(40) });
  const created = await api('/repos/CPF-Flutter/flutter_flutter/pulls', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ head: 'z2036709353:feature-sim', base: 'master', title: '测试 PR', body: `#${issue.body.number}` }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.head.sha, 'd'.repeat(40), '先 push 后创建 PR 也必须拿到真实 head SHA');
  const search = await api('/repos/CPF-Flutter/flutter_flutter/issues?state=all&creator=z2036709353');
  assert.equal(search.body.length, 1);
  assert.equal(search.body[0].title, '测试 Issue');
  await wait(250);
  assert.equal(created.body.user.login, 'z2036709353');
  const comments = await api(`/repos/CPF-Flutter/flutter_flutter/pulls/${created.body.number}/comments`);
  assert.ok(comments.body.some((item) => item.body.includes('感谢提交')));

  await sim('contents', { owner: 'CPF-Flutter', repo: 'flutter_flutter', path: '.ace/policy.yaml', ref: 'master', content: 'version: test\n' });
  assert.equal(await client.fetchRepoFile('CPF-Flutter', 'flutter_flutter', '.ace/policy.yaml', 'master'), 'version: test\n');
  const org = await client.listGitcodeOrgPrs({ state: 'open', author: 'z2036709353' });
  assert.equal(org.prs.length, 1);
  assert.equal(org.prs[0].repoFull, 'CPF-Flutter/flutter_flutter');
  assert.equal(org.prs[0].author, 'z2036709353');
  const missing = await api('/repos/CPF-Flutter/flutter_flutter/issues/9999');
  assert.equal(missing.response.status, 404);
});

test('真实 fetch-pr-diff 能读取可配置 files 并生成 unified diff', async () => {
  await registerPr(100, { files: [{
    filename: 'src/main.ets', patch: '@@ -1 +1 @@\n-const value = "old";\n+const value = "new";',
  }] });
  const out = join(root, 'diff-output');
  const result = JSON.parse(await runScript(diffScript, ['--owner', 'CPF-Flutter', '--repo', 'flutter_flutter', '--number', '100', '--out', out]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed_files, ['src/main.ets']);
  assert.match(readFileSync(join(out, 'review.diff'), 'utf8'), /diff --git a\/src\/main\.ets/);
  assert.match(readFileSync(join(out, 'review.diff'), 'utf8'), /\+const value = "new";/);
});

test('评论按 100 条分页，access_token 作者和提交列表保持正确', async () => {
  await registerPr();
  for (let index = 0; index < 105; index += 1) await postComment(`comment ${index}`);
  const comments = await gitcodeReadPages('/repos/CPF-Flutter/flutter_flutter/pulls/100/comments', 'sim-login-alice');
  assert.equal(comments.length, 105);
  assert.ok(comments.every((comment) => comment.user.login === 'alice'));
  const queryToken = await api('/repos/CPF-Flutter/flutter_flutter/pulls/100/comments?access_token=sim-login-bob', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'query token' }),
  });
  assert.equal(queryToken.body.user.login, 'bob');
  await sim('git-push', { fork: 'z2036709353/flutter_flutter', branch: 'feature-sim', sha: 'a'.repeat(40) });
  const commits = await api('/repos/CPF-Flutter/flutter_flutter/pulls/100/commits');
  assert.ok(commits.body.some((commit) => commit.sha === 'a'.repeat(40)));
  await sim('settings', { pushAckDelayMs: 1200 });
  await sim('push-ack', { owner: 'CPF-Flutter', repo: 'flutter_flutter', number: 100 });

  // --since 的起点必须严格晚于上面 git-push 刚产生的即时确认（gitAckDelayMs=0）。
  // 从 git-push 到这里只隔几次本地 HTTP 往返（常 <100ms），now-100ms 的回看窗口兜不住旧确认，
  // 脚本会在首轮轮询直接 ack 在旧评论上并立刻发出 start build，pushAckDelayMs=1200 的新确认
  // 反而落到 start build 之后，与末尾断言形成竞态（机器越快越容易失败）。
  // 起点取 now+1ms 保证严格晚于已入列的旧确认：脚本必须等延迟的新确认，末尾断言才稳定。
  const posted = JSON.parse(await runScript(commentScript, [
    '--owner', 'CPF-Flutter', '--repo', 'flutter_flutter', '--number', '100',
    '--out', join(root, 'comment-output-105'), '--body', 'start build',
    '--wait-push-ack', '--wait-timeout', '8', '--since', new Date(Date.now() + 1).toISOString(),
  ]));
  assert.equal(posted.wait_ack, 'acked', '最近 50 条评论必须包含新的 push 确认');

  await assert.rejects(
    runScript(commentScript, [
      '--owner', 'CPF-Flutter', '--repo', 'flutter_flutter', '--number', '100',
      '--out', join(root, 'comment-without-since'), '--body', 'start build',
      '--wait-push-ack', '--wait-timeout', '1',
    ]),
    /必须提供有效的 --since/,
    '缺少可靠起点必须停止，不能吞掉新确认或超时后冒险发 start build',
  );
  assert.equal((await api('/repos/CPF-Flutter/flutter_flutter/pulls/100/comments?per_page=1')).body[0].body,
    'start build', '拒绝缺少 --since 的调用后，不得发出额外评论');
});

test('同毫秒的后续 push 确认按评论 ID 判新', async () => {
  await registerPr();
  const since = new Date().toISOString();
  await sim('push-ack', { owner: 'CPF-Flutter', repo: 'flutter_flutter', number: 100 });
  const comments = await api('/repos/CPF-Flutter/flutter_flutter/pulls/100/comments?per_page=1');
  const ackAt = comments.body[0].created_at;
  const output = join(root, 'comment-same-millisecond');
  const pending = runScript(commentScript, [
    '--owner', 'CPF-Flutter', '--repo', 'flutter_flutter', '--number', '100',
    '--out', output, '--body', 'start build', '--wait-push-ack', '--wait-timeout', '8', '--since', since,
  ]);
  await wait(150);
  await sim('state', { owner: 'CPF-Flutter', repo: 'flutter_flutter', number: 100, comments: [
    ...comments.body,
    { id: 989898, user: { login: 'openharmony_ci' }, body: '监测到PR 代码有更新', created_at: ackAt },
  ] });
  const posted = JSON.parse(await pending);
  assert.equal(posted.wait_ack, 'acked', '相同时间戳的新评论不能被已见评论掩盖');
});

test('push 取消旧剧本并清除旧结果，新 head 可以重新触发', async () => {
  await registerPr();
  await sim('scenario', {
    owner: 'CPF-Flutter', repo: 'flutter_flutter', number: 100,
    script: [{ waitMs: 250, labels: ['编译失败'], comment: '门禁未通过：noPass', webhook: true }],
  });
  const comment = await api('/repos/CPF-Flutter/flutter_flutter/pulls/100/comments?access_token=test-token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'start build' }),
  });
  assert.equal(comment.body.scenario_scheduled, true);
  const duplicate = await api('/repos/CPF-Flutter/flutter_flutter/pulls/100/comments?access_token=test-token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'start build' }),
  });
  assert.equal(duplicate.body.scenario_scheduled, false);
  await sim('git-push', { fork: 'z2036709353/flutter_flutter', branch: 'feature-sim', sha: 'b'.repeat(40) });
  await wait(350);
  let detail = await api('/repos/CPF-Flutter/flutter_flutter/pulls/100');
  assert.equal(detail.body.head.sha, 'b'.repeat(40));
  assert.ok(!detail.body.labels.some((label) => label.name === '编译失败'));
  await api('/repos/CPF-Flutter/flutter_flutter/pulls/100/comments?access_token=test-token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'start build' }),
  });
  await wait(350);
  detail = await api('/repos/CPF-Flutter/flutter_flutter/pulls/100');
  assert.ok(detail.body.labels.some((label) => label.name === '编译失败'));
});

test('延迟 push 确认、reset 取消计时器、测试人审批和关闭态可编排', async () => {
  await registerPr();
  await sim('settings', { gitAckDelayMs: 120 });
  await sim('git-push', { fork: 'z2036709353/flutter_flutter', branch: 'feature-sim', sha: 'c'.repeat(40) });
  let detail = await api('/repos/CPF-Flutter/flutter_flutter/pulls/100');
  assert.equal(detail.body.head.sha, 'c'.repeat(40));
  const comments = await api('/repos/CPF-Flutter/flutter_flutter/pulls/100/comments');
  assert.equal(comments.body.length, 0);
  await wait(160);
  const acked = await api('/repos/CPF-Flutter/flutter_flutter/pulls/100/comments');
  assert.ok(acked.body.some((item) => item.body.includes('重置PR验证状态')));
  await sim('state', { owner: 'CPF-Flutter', repo: 'flutter_flutter', number: 100, testers: [{ login: 'tester', accept: true }] });
  detail = await api('/repos/CPF-Flutter/flutter_flutter/pulls/100');
  assert.equal(client.isTesterApproved(detail.body.testers), true);
  await sim('state', { owner: 'CPF-Flutter', repo: 'flutter_flutter', number: 100, state: 'closed' });
  const rejected = await api('/repos/CPF-Flutter/flutter_flutter/pulls/100/comments?access_token=test-token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'start build' }),
  });
  assert.equal(rejected.response.status, 422);
  await sim('settings', { pushAckDelayMs: 120 });
  await sim('push-ack', { owner: 'CPF-Flutter', repo: 'flutter_flutter', number: 100 });
  await fetch(`${base}/_sim/reset`);
  await wait(150);
  assert.equal((await api('/repos/CPF-Flutter/flutter_flutter/pulls/100')).response.status, 404);
});

test('真实 check-pr-gates 对全绿剧本给出 green', async () => {
  await registerPr();
  await sim('scenario', {
    owner: 'CPF-Flutter', repo: 'flutter_flutter', number: 100,
    script: [
      { comment: '门禁构建开始：静态检查、编译。' },
      { waitMs: 30, labels: ['DCO检查成功', '静态检查成功', '编译成功', '测试成功', 'AI已检视'] },
    ],
  });
  await api('/repos/CPF-Flutter/flutter_flutter/pulls/100/comments?access_token=test-token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'start build' }),
  });
  await wait(100);
  const result = JSON.parse(await runScript(gateScript, ['--owner', 'CPF-Flutter', '--repo', 'flutter_flutter', '--number', '100', '--out', join(root, 'gate-output')]));
  assert.equal(result.phase, 'green');
  assert.equal(result.build_passed, true);
});
