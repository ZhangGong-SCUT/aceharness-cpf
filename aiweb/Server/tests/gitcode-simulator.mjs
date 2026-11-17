#!/usr/bin/env node
/**
 * 本地 GitCode 模拟器 — 用于无真实仓库环境下测试 PR 提交与 PR 监控全链路。
 *
 * 设计目标：
 *  1. 实现 PR 提交（prSubmit）与 PR 监控（prReview/skills 脚本）实际调用的最小 API 面；
 *  2. CI 门禁可编排：收到 start build 后按剧本推进（欢迎评论 → 门禁标签 → 失败/通过评论 → webhook）；
 *  3. 全程不碰真实 GitCode：git 层由调用方用 insteadOf 改写到本地 bare 仓库（见 README）。
 *
 * 启动：
 *   node aiweb/Server/tests/gitcode-simulator.mjs --port 3999 --root /tmp/ace-gitcode-sim
 *
 * 控制接口（供测试驱动剧本）：
 *   POST /_sim/pr           { owner, repo, number, files?, labels?, ... } 注册 PR
 *   POST /_sim/scenario      { owner, repo, number, script: [...], webhookSecret? }
 *   POST /_sim/comment       { owner, repo, number, who, body } 评论并广播 webhook
 *   POST /_sim/label         { owner, repo, number, labels: [...] } 打标签并广播 webhook
 *   POST /_sim/state         { owner, repo, number, state?, merged?, testers? } 设置生命周期/审批
 *   POST /_sim/contents      { owner, repo, path, content, ref? } 注册仓库策略文件
 *   POST /_sim/settings      { webhookTimeoutMs?, pushAckDelayMs?, gitAckDelayMs? }
 *   POST /_sim/push-ack      { owner, repo, number } 按 pushAckDelayMs 延迟发送 push 确认
 *   POST /_sim/git-push      bare 仓 post-receive 回调；先 push 后建 PR 也保留真实 head SHA
 *   GET  /_sim/pr/<owner>/<repo>/<number> 查看模拟 PR 全态（调试用）
 *   GET  /_sim/reset                       清空状态并取消全部计时器
 *
 * 剧本项字段：
 *   { waitMs, who: 'openharmony_ci' | 'cpf-manager' | '<login>',
 *     comment: '文本', labels: ['编译成功'], webhook: true }
 *   who 决定评论作者；labels 为增量标签数组；webhook=true 时向 ACE 广播 note 事件。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] ?? '1');
}
const PORT = Number(args.get('port') || process.env.GITCODE_SIM_PORT || 3999);
const ROOT = resolve(args.get('root') || process.env.GITCODE_SIM_ROOT || '/tmp/ace-gitcode-sim');
const ACE_WEBHOOK = args.get('ace-webhook') || process.env.GITCODE_SIM_ACE_WEBHOOK || 'http://127.0.0.1:3000/api/gitcode/webhook';
const WEBHOOK_SECRET = process.env.ACE_GITCODE_WEBHOOK_SECRET || 'test-webhook-secret';
const STATE_FILE = join(ROOT, 'sim-state.json');
const TICK_MS = Number(args.get('tick-ms') || 500);

mkdirSync(ROOT, { recursive: true });

function freshState() {
  return {
    prs: {}, issues: {}, nextPr: 100, nextIssue: 100, nextCommentId: 1,
    scenarios: {}, orgRepos: {}, branches: {}, contents: {}, gitRefs: {},
    settings: { webhookTimeoutMs: 8000, pushAckDelayMs: 0, gitAckDelayMs: 0 },
  };
}

/** 模拟账号：任何令牌都映射到固定身份（除非用 sim-login-<name> 令牌） */
function loginOfToken(authHeader = '', query = null) {
  // 部分技能脚本按 GitCode v5 约定使用 access_token 查询参数。
  const token = String(authHeader || query?.get('access_token') || '').replace(/^Bearer\s+/i, '');
  if (!token) return '';
  const m = token.match(/^sim-login-(.+)$/);
  return m ? m[1] : 'z2036709353';
}

function normalizeFiles(files) {
  const input = Array.isArray(files) ? files : [{ filename: 'README.md', patch: '@@ -1 +1 @@\n-old\n+new' }];
  return input.map((file) => {
    const item = typeof file === 'string' ? { filename: file } : (file || {});
    const filename = String(item.filename || item.new_path || item.path || 'README.md');
    return {
      ...item, filename,
      old_path: String(item.old_path || filename),
      status: String(item.status || 'modified'),
      patch: String(item.patch || '@@ -1 +1 @@\n-old\n+new'),
    };
  });
}

function loadState() {
  let saved;
  try { saved = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return freshState(); }
  const loaded = { ...freshState(), ...saved, settings: { ...freshState().settings, ...saved.settings } };
  for (const scenario of Object.values(loaded.scenarios)) scenario.running = false; // 重启后没有存活的计时器
  for (const pr of Object.values(loaded.prs)) {
    pr.number = String(pr.number);
    pr.files = Object.hasOwn(pr, 'files') ? normalizeFiles(pr.files) : normalizeFiles();
    pr.commits = Array.isArray(pr.commits) ? pr.commits : (pr.head_sha ? [pr.head_sha] : []);
    pr.created_at ||= now();
    pr.updated_at ||= pr.created_at;
  }
  for (const [key, entry] of Object.entries(loaded.issues)) {
    const match = key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (match) { entry.owner ||= match[1]; entry.repo ||= match[2]; }
    if (entry.issue) {
      entry.related ??= Boolean(loaded.prs[key]);
      entry.issue.body ??= '';
      entry.issue.labels ??= [];
    }
  }
  return loaded;
}
let state = loadState();
function persist() {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function prKey(owner, repo, number) { return `${String(owner).toLowerCase()}/${String(repo).toLowerCase()}#${number}`; }
function now() { return new Date().toISOString(); }
function touch(pr) { pr.updated_at = now(); }
function isOpen(pr) { return pr.state === 'open' && !pr.merged; }
function pageOf(items, query) {
  const page = Math.max(1, Number(query.get('page')) || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page')) || 30));
  return items.slice((page - 1) * perPage, page * perPage);
}

function prView(pr) {
  return {
    number: Number(pr.number), iid: Number(pr.number), title: pr.title, state: pr.state,
    user: { login: pr.author, username: pr.author },
    labels: pr.labels.map((name) => ({ name })),
    head: { ref: pr.head_ref, sha: pr.head_sha, repo: { full_name: pr.head_repo } },
    base: { ref: pr.base_ref, repo: { full_name: `${pr.owner}/${pr.repo}`, full_path: `${pr.owner}/${pr.repo}`, path: pr.repo } },
    issue_url: `https://gitcode.com/api/v5/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/issues`,
    testers: pr.testers || [], merged: pr.merged, mergeable: true,
    body: pr.body || '', html_url: `https://gitcode.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
    related_issues: pr.related_issues || [], issues: pr.issues || [],
    created_at: pr.created_at, updated_at: pr.updated_at || pr.created_at,
  };
}

function prDiff(pr) {
  return pr.files.map((file) => {
    const added = file.status === 'added' || file.status === 'new';
    const removed = file.status === 'removed' || file.status === 'deleted';
    const patch = String(file.patch).split('\n').filter((line) => !/^diff --git |^--- |^\+\+\+ /.test(line)).join('\n');
    return `diff --git a/${file.old_path} b/${file.filename}\n--- ${added ? '/dev/null' : `a/${file.old_path}`}\n+++ ${removed ? '/dev/null' : `b/${file.filename}`}\n${patch}`;
  }).join('\n') + '\n';
}

function getPr(owner, repo, number) {
  return state.prs[prKey(owner, repo, number)] || null;
}

function ensureIssue(owner, repo, number) {
  const key = `${String(owner).toLowerCase()}/${String(repo).toLowerCase()}#${number}`;
  if (!state.issues[key]) {
    state.issues[key] = { number, comments: [], labels: [] };
  }
  return state.issues[key];
}

function addComment(pr, who, body, extra = {}) {
  const comment = {
    id: state.nextCommentId++,
    body,
    created_at: now(),
    user: { login: who, username: who },
    comment_type: 'pr_comment',
    ...extra,
  };
  pr.comments.push(comment);
  return comment;
}

function pushResetComment(pr) {
  return addComment(pr, 'openharmony_ci', '监测到PR更新，代码有更新，重置PR验证状态。');
}

/** 向 ACE 广播 note 事件（挂起的监控 run 靠这个被唤醒） */
async function broadcastWebhook(pr, owner, repo, number, action = 'comment', secret = WEBHOOK_SECRET) {
  const payload = {
    hook_name: 'note_hooks',
    action,
    pull_request: {
      number: Number(number),
      title: pr.title,
      html_url: `https://gitcode.com/${owner}/${repo}/pull/${number}`,
      state: pr.state,
      user: { login: pr.author },
      head: { ref: pr.head_ref, sha: pr.head_sha, repo: { full_name: pr.head_repo } },
      base: { ref: pr.base_ref },
    },
    repository: { full_name: `${owner}/${repo}` },
  };
  const timeoutMs = Math.max(1, Number(state.settings.webhookTimeoutMs) || 8000);
  try {
    const url = `${ACE_WEBHOOK}?secret=${encodeURIComponent(secret)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    webhookControllers.add(controller);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      simLog(`webhook → ACE ${resp.status}`);
      return { status: resp.status };
    } finally {
      clearTimeout(timeout);
      webhookControllers.delete(controller);
    }
  } catch (error) {
    simLog(`webhook → ACE 失败: ${error.message}`);
    return { error: error.message };
  }
}

function simLog(msg) {
  console.log(`[gitcode-sim] ${now()} ${msg}`);
}

/** ── CI 门禁剧本执行器 ─────────────────────────────────────── */
const scenarioTimers = new Map();
const deferredTimers = new Set();
const webhookControllers = new Set();
function later(fn, delay) {
  const timer = setTimeout(() => { deferredTimers.delete(timer); fn(); }, delay);
  deferredTimers.add(timer);
  return timer;
}
function cancelScenario(key) {
  for (const timer of scenarioTimers.get(key) || []) clearTimeout(timer);
  scenarioTimers.delete(key);
  const scenario = state.scenarios[key];
  if (scenario) { scenario.runId = Number(scenario.runId || 0) + 1; scenario.running = false; }
}
async function executeScenarioStep(key, scenario, step) {
  const current = state.prs[key];
  if (!current || state.scenarios[key] !== scenario || !scenario.running) return false;
  if (step.labels?.length) {
    for (const label of step.labels) if (!current.labels.includes(label)) current.labels.push(label);
    simLog(`PR ${key} +labels ${step.labels.join(',')}`);
  }
  if (step.comment) {
    addComment(current, step.who || 'openharmony_ci', step.comment);
    simLog(`PR ${key} comment by ${step.who || 'openharmony_ci'}: ${String(step.comment).slice(0, 60)}`);
  }
  touch(current);
  // 事件先提交，再异步通知：本地回放可准确观察“CI 已更新、webhook 在途”的中间态。
  scenario.completedSteps += 1;
  if (scenario.manual && scenario.completedSteps === scenario.script.length) {
    scenario.running = false;
    scenarioTimers.delete(key);
  }
  persist();
  if (step.webhook) await broadcastWebhook(current, current.owner, current.repo, current.number, 'comment', scenario.webhookSecret || WEBHOOK_SECRET);
  return true;
}
function scheduleScenario(key) {
  const scenario = state.scenarios[key];
  if (!scenario || scenario.running) return false;
  cancelScenario(key);
  scenario.running = true;
  scenario.completedSteps = 0;
  scenario.runId = Number(scenario.runId || 0) + 1;
  const runId = scenario.runId;
  const active = () => state.scenarios[key] === scenario && scenario.runId === runId;
  const pr = state.prs[key];
  if (!pr) return false;
  let delay = 0;
  const pending = [];
  for (const step of scenario.script) {
    delay += Number(step.waitMs || 0);
    if (scenario.manual) continue;
    pending.push(setTimeout(async () => {
      await executeScenarioStep(key, scenario, step);
    }, delay));
  }
  scenarioTimers.set(key, pending);
  if (scenario.manual) {
    persist();
    return true;
  }
  pending.push(setTimeout(() => {
    if (!active()) return;
    scenario.running = false;
    scenarioTimers.delete(key);
    persist();
  }, delay + 100));
  persist();
  return true;
}

function startBuildReceived(pr, actor) {
  simLog(`PR ${pr.owner}/${pr.repo}#${pr.number} 收到 start build（作者 ${pr.author}，触发者 ${actor}）`);
  const key = prKey(pr.owner, pr.repo, pr.number);
  return scheduleScenario(key);
}

const GATE_RESULT_LABELS = new Set([
  'dco检查成功', 'dco校验成功', 'dco检查失败', 'dco校验失败',
  '静态检查成功', '静态检查失败', '编译成功', '编译失败',
  '冒烟测试成功', '冒烟测试失败', '测试成功', '测试失败',
]);
function acknowledgePush(pr, { welcome = false } = {}) {
  const key = prKey(pr.owner, pr.repo, pr.number);
  cancelScenario(key); // 旧版本的延迟结果不能污染新 head
  pr.labels = pr.labels.filter((label) => !GATE_RESULT_LABELS.has(label));
  pushResetComment(pr);
  if (welcome) {
    addComment(pr, 'openharmony_ci', '感谢提交 Pull Requests。');
    addComment(pr, 'openharmony_ci', '如需重新触发门禁，请评论 start build。');
  }
  touch(pr);
  persist();
  return broadcastWebhook(pr, pr.owner, pr.repo, pr.number, 'update');
}
function queuePushAck(pr, delayMs, options = {}) {
  const key = prKey(pr.owner, pr.repo, pr.number);
  later(() => {
    if (state.prs[key] === pr && isOpen(pr)) acknowledgePush(pr, options);
  }, Math.max(0, Number(delayMs) || 0));
}

/** ── HTTP 服务 ─────────────────────────────────────────────── */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method;
  const auth = req.headers.authorization || '';
  const login = loginOfToken(auth, url.searchParams);
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const body = await new Promise((resolveBody) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolveBody(raw ? JSON.parse(raw) : {}); } catch { resolveBody({}); }
    });
  });

  // ── 控制接口 ──
  if (method === 'GET' && path === '/_sim/reset') {
    for (const key of Object.keys(state.scenarios)) cancelScenario(key);
    for (const timer of deferredTimers) clearTimeout(timer);
    deferredTimers.clear();
    webhookControllers.forEach((controller) => controller.abort());
    webhookControllers.clear();
    state = freshState();
    persist();
    return send(200, { ok: true });
  }
  if (method === 'POST' && path === '/_sim/settings') {
    for (const key of ['webhookTimeoutMs', 'pushAckDelayMs', 'gitAckDelayMs']) {
      if (body[key] !== undefined && (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0)) return send(400, { message: `${key} 必须是非负毫秒数` });
    }
    state.settings = { ...state.settings, ...body };
    persist();
    return send(200, { ok: true, settings: state.settings });
  }
  if (method === 'POST' && path === '/_sim/pr') {
    // 创建/注册一个模拟 PR（供 webhook 手动开启监控前先造数据）
    const { owner, repo, number, author, title, head_ref, head_sha, head_repo, base_ref, state: prState } = body;
    if (!owner || !repo || !number) return send(400, { message: 'owner/repo/number 不能为空' });
    const key = prKey(owner, repo, number);
    const previous = state.prs[key];
    const createdAt = previous?.created_at || now();
    state.prs[key] = {
      owner, repo, number: String(number), author: author || 'z2036709353',
      title: title || 'sim PR', state: prState || 'open',
      head_ref: head_ref || 'feature-sim', head_sha: head_sha || '0000000000000000000000000000000000000000',
      head_repo: head_repo || `${author || 'z2036709353'}/${repo}`, base_ref: base_ref || 'master',
      labels: body.labels || [], comments: previous?.comments || [], testers: body.testers || [], merged: false,
      body: body.body || '', files: normalizeFiles(body.files), commits: body.commits || (head_sha ? [head_sha] : []),
      related_issues: body.related_issues || [], issues: body.issues || [],
      created_at: createdAt, updated_at: now(),
    };
    persist();
    return send(previous ? 200 : 201, { ok: true, pr: state.prs[key] });
  }
  if (method === 'POST' && path === '/_sim/scenario') {
    const { owner, repo, number, script, webhookSecret, manual } = body;
    const key = prKey(owner, repo, number);
    if (!state.prs[key]) return send(404, { message: 'PR 不存在，先 POST /_sim/pr' });
    if (!Array.isArray(script)) return send(400, { message: 'script 必须是数组' });
    cancelScenario(key);
    state.scenarios[key] = { script, running: false, runId: 0, completedSteps: 0, webhookSecret, manual: Boolean(manual) };
    persist();
    return send(200, { ok: true, steps: script.length });
  }
  if (method === 'POST' && path === '/_sim/scenario-step') {
    const scenario = state.scenarios[prKey(body.owner, body.repo, body.number)];
    if (!scenario?.manual) return send(409, { message: '仅 manual 剧本支持单步执行' });
    if (!scenario.running) return send(409, { message: '剧本未运行，先发送 start build' });
    const index = scenario.completedSteps;
    if (index >= scenario.script.length) return send(409, { message: '剧本已执行完' });
    const ok = await executeScenarioStep(prKey(body.owner, body.repo, body.number), scenario, scenario.script[index]);
    return send(ok ? 200 : 409, { ok, completedSteps: scenario.completedSteps });
  }
  if (method === 'POST' && path === '/_sim/comment') {
    const { owner, repo, number, who, body: text } = body;
    const pr = getPr(owner, repo, number);
    if (!pr) return send(404, { message: 'PR 不存在' });
    addComment(pr, who || 'openharmony_ci', text || '');
    touch(pr);
    persist();
    await broadcastWebhook(pr, owner, repo, number, 'comment');
    return send(200, { ok: true });
  }
  if (method === 'POST' && path === '/_sim/label') {
    const { owner, repo, number, labels } = body;
    const pr = getPr(owner, repo, number);
    if (!pr) return send(404, { message: 'PR 不存在' });
    for (const label of labels || []) if (!pr.labels.includes(label)) pr.labels.push(label);
    touch(pr);
    persist();
    await broadcastWebhook(pr, owner, repo, number, 'update');
    return send(200, { ok: true, labels: pr.labels });
  }
  if (method === 'POST' && path === '/_sim/state') {
    const pr = getPr(body.owner, body.repo, body.number);
    if (!pr) return send(404, { message: 'PR 不存在' });
    if (body.state !== undefined) pr.state = String(body.state);
    if (body.merged !== undefined) pr.merged = Boolean(body.merged);
    if (body.testers !== undefined) pr.testers = body.testers;
    if (body.related_issues !== undefined) pr.related_issues = body.related_issues;
    if (Array.isArray(body.comments)) pr.comments = body.comments;
    if (Array.isArray(body.files)) pr.files = normalizeFiles(body.files);
    touch(pr);
    persist();
    await broadcastWebhook(pr, pr.owner, pr.repo, pr.number, 'update');
    return send(200, { ok: true, state: pr.state, merged: pr.merged, testers: pr.testers });
  }
  if (method === 'POST' && path === '/_sim/contents') {
    const { owner, repo } = body;
    if (!owner || !repo || !body.path || typeof body.content !== 'string') return send(400, { message: 'owner/repo/path/content 不能为空' });
    const key = `${owner}/${repo}`;
    state.contents[key] ||= {};
    state.contents[key][body.path] = { content: body.content, ref: body.ref || '' };
    persist();
    return send(200, { ok: true });
  }
  if (method === 'POST' && path === '/_sim/push-ack') {
    const { owner, repo, number } = body;
    const pr = getPr(owner, repo, number);
    if (!pr) return send(404, { message: 'PR 不存在' });
    const delayMs = Math.max(0, Number(state.settings.pushAckDelayMs) || 0);
    if (delayMs) queuePushAck(pr, delayMs);
    else await acknowledgePush(pr);
    return send(200, { ok: true, delay_ms: delayMs });
  }
  // bare 仓 post-receive hook 回调：fork 分支有真实 push 时更新所有 head 匹配的 PR
  if (method === 'POST' && path === '/_sim/git-push') {
    const { fork, branch, sha } = body;
    const hits = Object.values(state.prs).filter((p) => (
      p.head_repo === String(fork || '') && p.head_ref === String(branch || '') && isOpen(p)
    ));
    for (const pr of hits) {
      pr.head_sha = String(sha || pr.head_sha);
      pr.last_pushed_at = now();
      pr.commits = [...(pr.commits || []).filter((item) => item !== pr.head_sha), pr.head_sha];
      touch(pr);
      simLog(`git-push 命中 PR ${pr.owner}/${pr.repo}#${pr.number}（${branch} → ${String(sha).slice(0, 8)}）`);
      persist();
      queuePushAck(pr, state.settings.gitAckDelayMs);
    }
    // PR 往往创建于 fork push 之后：即使暂时没有命中 PR，也保存 ref 供创建时采用。
    state.gitRefs[`${fork || ''}#${branch || ''}`] = { sha: String(sha || ''), pushed_at: now() };
    persist();
    return send(200, { ok: true, matched: hits.length, ack_delay_ms: Number(state.settings.gitAckDelayMs) || 0 });
  }
  if (method === 'GET' && path.startsWith('/_sim/pr/')) {
    const [, , , owner, repo, number] = path.split('/');
    const key = prKey(owner, repo, number);
    const pr = getPr(owner, repo, number);
    if (!pr) return send(404, { message: 'PR 不存在' });
    return send(200, {
      ...pr,
      scenarioProgress: state.scenarios[key]
        ? (({ running, runId, completedSteps }) => ({ running, runId, completedSteps: completedSteps || 0 }))(state.scenarios[key])
        : null,
    });
  }

  // ── GitCode 兼容 API（/api/v5）──
  if (!path.startsWith('/api/v5')) return send(404, { message: 'not found' });
  const apiPath = path.slice('/api/v5'.length);
  const parts = apiPath.split('/').filter(Boolean);
  const query = url.searchParams;

  // /user
  if (method === 'GET' && apiPath === '/user') {
    if (!login) return send(401, { message: '未提供令牌' });
    return send(200, { login, id: 1, username: login });
  }

  // /repos/{owner}/{repo}/branches（列表及单分支详情）
  if (method === 'GET' && parts[0] === 'repos' && parts[3] === 'branches') {
    const [, owner, repo] = parts;
    const branches = [
      { name: 'master' }, { name: 'main' }, { name: 'br_3.41_dev' },
      ...(state.branches?.[`${owner}/${repo}`] || []),
    ].map((b) => ({ ...b, commit: { sha: b.commit?.sha || '0000000000000000000000000000000000000000' } }));
    if (parts.length === 5) {
      const branch = branches.find((item) => item.name === decodeURIComponent(parts[4]));
      return branch ? send(200, branch) : send(404, { message: '分支不存在' });
    }
    return send(200, pageOf(branches, query));
  }

  // /repos/{owner}/{repo}/contents/{path}：仓库策略文件只读接口
  if (method === 'GET' && parts[0] === 'repos' && parts[3] === 'contents' && parts.length >= 5) {
    const [, owner, repo, , ...segments] = parts;
    const filePath = segments.map(decodeURIComponent).join('/');
    const entry = state.contents[`${owner}/${repo}`]?.[filePath];
    if (!entry || (entry.ref && entry.ref !== query.get('ref'))) return send(404, { message: '文件不存在' });
    return send(200, {
      type: 'file', path: filePath, name: segments.at(-1), encoding: 'base64',
      content: Buffer.from(entry.content, 'utf8').toString('base64'),
    });
  }

  // 仓库只读探测（AIWeb capabilities）
  if (method === 'GET' && parts[0] === 'repos' && parts.length === 3) {
    const [, owner, repo] = parts;
    if (!login) return send(401, { message: '未提供令牌' });
    return send(200, { full_name: `${owner}/${repo}`, name: repo, private: false, permissions: { pull: true } });
  }

  // /repos/{owner}/{repo}/pulls（POST 创建 PR）
  if (parts[0] === 'repos' && parts[3] === 'pulls' && parts.length === 4) {
    const [, owner, repo] = parts;
    if (!['GET', 'POST'].includes(method)) return send(405, { message: '不支持的 PR 列表方法' });
    if (method === 'POST') {
      if (!login) return send(401, { message: '未提供令牌' });
      const number = state.nextPr++;
      const key = prKey(owner, repo, number);
      // head 格式 "owner:ref"（与真实 GitCode 一致）
      const headParts = String(body.head || '').split(':');
      const headRepo = headParts.length >= 2 ? headParts[0] : login;
      const headRef = headParts.length >= 2 ? headParts.slice(1).join(':') : body.head;
      const createdAt = now();
      const headSha = state.gitRefs?.[`${headRepo}/${repo}#${headRef}`]?.sha
        || state.branches?.[`${headRepo}/${repo}`]?.find((item) => item.name === headRef)?.commit?.sha
        || '0000000000000000000000000000000000000000';
      state.prs[key] = {
        owner, repo, number: String(number), author: login,
        title: body.title || '', state: 'open',
        head_ref: headRef || 'submit/sim', head_sha: headSha,
        head_repo: `${headRepo}/${repo}`, base_ref: body.base || 'master',
        labels: [], comments: [], testers: [], merged: false, created_at: createdAt, updated_at: createdAt,
        body: body.body || '', files: normalizeFiles(body.files), commits: [headSha],
        related_issues: body.related_issues || [], issues: body.issues || [],
      };
      persist();
      simLog(`PR 创建 ${key}（作者 ${login}，base=${body.base}）`);
      const pr = state.prs[key];
      // GitCode 行为：CI 欢迎评论（异步）
      later(() => {
        if (state.prs[key] !== pr || !isOpen(pr)) return;
        addComment(pr, 'openharmony_ci', '感谢提交 Pull Requests。');
        addComment(pr, 'openharmony_ci', '如需重新触发门禁，请评论 start build。');
        touch(pr);
        persist();
        broadcastWebhook(pr, owner, repo, number, 'comment');
      }, 200);
      return send(201, { ...prView(pr), web_url: prView(pr).html_url });
    }
    const list = Object.values(state.prs).filter((p) => p.owner === owner && p.repo === repo);
    const state_ = query.get('state');
    const author = String(query.get('author') || '').toLowerCase();
    const filtered = list.filter((p) => (!state_ || state_ === 'all' || p.state === state_ || (state_ === 'merged' && p.merged))
      && (!author || p.author.toLowerCase() === author))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return send(200, pageOf(filtered.map(prView), query));
  }

  // /repos/{owner}/{repo}/pulls/{number}/diff 和 /files：修复与同类缺陷扫描的实际数据源
  if (method === 'GET' && parts[0] === 'repos' && parts[3] === 'pulls' && parts.length === 6 && ['diff', 'files'].includes(parts[5])) {
    const [, owner, repo, , number] = parts;
    const pr = getPr(owner, repo, number);
    if (!pr) return send(404, { message: 'PR 不存在' });
    if (parts[5] === 'diff') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(prDiff(pr));
    }
    return send(200, pageOf(pr.files, query));
  }

  // /repos/{owner}/{repo}/pulls/{number}/issues
  if (method === 'GET' && parts[0] === 'repos' && parts[3] === 'pulls' && parts[5] === 'issues' && parts.length === 6) {
    const [, owner, repo, , number] = parts;
    const pr = getPr(owner, repo, number);
    if (!pr) return send(404, { message: 'PR 不存在' });
    return send(200, pr.related_issues || []);
  }

  // /repos/{owner}/{repo}/pulls/{number} 详情
  if (method === 'GET' && parts[0] === 'repos' && parts[3] === 'pulls' && parts.length === 5) {
    const [, owner, repo, , number] = parts;
    const pr = getPr(owner, repo, number);
    if (!pr) return send(404, { message: 'PR 不存在' });
    return send(200, prView(pr));
  }

  // /repos/{owner}/{repo}/pulls/{number}/comments（GET 列表 / POST 评论）
  if (parts[0] === 'repos' && parts[3] === 'pulls' && parts[5] === 'comments' && parts.length === 6) {
    const [, owner, repo, , number] = parts;
    const pr = getPr(owner, repo, number);
    if (!pr) return send(404, { message: 'PR 不存在' });
    if (method === 'POST') {
      if (!login) return send(401, { message: '未提供令牌' });
      if (pr.state === 'closed' || pr.merged) return send(422, { message: 'PR 已关闭或合入' });
      const text = String(body.body || '');
      const comment = addComment(pr, login, text);
      touch(pr);
      let scheduled = false;
      if (/^\s*start\s+build\s*$/i.test(text)) scheduled = startBuildReceived(pr, login);
      if (/^\s*submit\s*$/i.test(text)) simLog('收到 submit（模拟器不执行合入）');
      persist();
      simLog(`PR ${prKey(owner, repo, number)} 评论 by ${login}: ${text.slice(0, 60)}`);
      return send(201, { ...comment, scenario_scheduled: scheduled });
    }
    // GitCode 默认新评论在前；wait-push-ack 只取最近 50 条，不能返回升序首页。
    return send(200, pageOf([...pr.comments].reverse(), query));
  }

  // /repos/{owner}/{repo}/pulls/{number}/reviews
  if (parts[0] === 'repos' && parts[3] === 'pulls' && parts[5] === 'reviews' && parts.length === 6) {
    const [, owner, repo, , number] = parts;
    const pr = getPr(owner, repo, number);
    if (!pr) return send(404, { message: 'PR 不存在' });
    return send(200, pageOf(pr.reviews || [], query));
  }

  // /repos/{owner}/{repo}/pulls/{number}/commits
  if (parts[0] === 'repos' && parts[3] === 'pulls' && parts[5] === 'commits' && parts.length === 6) {
    const [, owner, repo, , number] = parts;
    const pr = getPr(owner, repo, number);
    if (!pr) return send(404, { message: 'PR 不存在' });
    const commits = (pr.commits || []).map((sha) => ({
      sha,
      commit: { author: { date: pr.last_pushed_at || pr.created_at }, committer: { date: pr.last_pushed_at || pr.created_at }, message: 'sim commit' },
    }));
    return send(200, pageOf(commits, query));
  }

  // /repos/{owner}/{repo}/issues（POST 创建 / GET 搜索）
  if (parts[0] === 'repos' && parts[3] === 'issues' && parts.length === 4) {
    const [, owner, repo] = parts;
    if (method === 'POST') {
      if (!login) return send(401, { message: '未提供令牌' });
      const number = state.nextIssue++;
      const issue = {
        number: String(number), title: body.title || '', state: 'open', body: body.body || '',
        user: { login }, labels: body.labels || [], created_at: now(),
        html_url: `https://gitcode.com/${owner}/${repo}/issues/${number}`,
      };
      const entry = ensureIssue(owner, repo, number);
      entry.owner = owner;
      entry.repo = repo;
      entry.issue = issue;
      entry.related = false;
      persist();
      simLog(`Issue 创建 ${owner}/${repo}#${number}（${issue.title}）`);
      return send(201, issue);
    }
    const creator = query.get('creator');
    const requestedState = query.get('state');
    const all = Object.values(state.issues)
      .filter((i) => i.issue && i.owner === owner && i.repo === repo)
      .map((i) => i.issue)
      .filter((issue) => !requestedState || requestedState === 'all' || issue.state === requestedState);
    const filtered = creator ? all.filter((i) => String(i.user?.login).toLowerCase() === creator.toLowerCase()) : all;
    return send(200, pageOf(filtered, query));
  }

  // /repos/{owner}/{repo}/issues/{number}（GET 详情）
  if (parts[0] === 'repos' && parts[3] === 'issues' && parts.length === 5 && method === 'GET') {
    const [, owner, repo, , number] = parts;
    const entry = state.issues[prKey(owner, repo, number)];
    if (!entry?.issue) return send(404, { message: 'Issue 不存在' });
    return send(200, entry.issue);
  }

  // /repos/{owner}/{repo}/issues/{number}/comments
  if (parts[0] === 'repos' && parts[3] === 'issues' && parts[5] === 'comments' && parts.length === 6) {
    const [, owner, repo, , number] = parts;
    const entry = ensureIssue(owner, repo, number);
    if (method === 'POST') {
      if (!login) return send(401, { message: '未提供令牌' });
      if (!entry.issue) return send(404, { message: 'Issue 不存在' });
      const comment = { id: state.nextCommentId++, body: body.body || '', created_at: now(), user: { login } };
      entry.comments.push(comment);
      persist();
      return send(201, comment);
    }
    return send(200, pageOf(entry.comments, query));
  }

  // /orgs/{owner}/repos（AIWeb 组织仓库目录，org API 子域）
  if (parts[0] === 'orgs' && parts[2] === 'repos' && parts.length === 3) {
    const owner = parts[1];
    const repos = state.orgRepos?.[owner] || ['flutter_flutter', 'flutter_engine', 'flutter_packages'];
    return send(200, pageOf(repos.map((name) => ({
      full_name: `${owner}/${name}`, path_with_namespace: `${owner}/${name}`, name,
    })), query));
  }

  // /org/{owner}/pull_requests（AIWeb 跨仓 PR 列表）
  if (parts[0] === 'org' && parts[2] === 'pull_requests' && parts.length === 3) {
    const owner = parts[1];
    const stateFilter = query.get('state') || 'all';
    const author = String(query.get('author') || '').toLowerCase();
    const search = String(query.get('search') || '').toLowerCase();
    const pulls = Object.values(state.prs).filter((pr) => pr.owner.toLowerCase() === owner.toLowerCase()
      && (stateFilter === 'all' || pr.state === stateFilter || (stateFilter === 'merged' && pr.merged))
      && (!author || pr.author.toLowerCase() === author)
      && (!search || `${pr.title}\n${pr.body || ''}`.toLowerCase().includes(search)))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return send(200, pageOf(pulls.map(prView), query));
  }

  return send(404, { message: `模拟器未实现: ${method} ${apiPath}` });
});

server.listen(PORT, '127.0.0.1', () => {
  simLog(`监听 http://127.0.0.1:${server.address().port}  状态文件 ${STATE_FILE}`);
  simLog(`ACE webhook 目标 ${ACE_WEBHOOK}`);
  if (!existsSync(STATE_FILE)) persist();
});

function closeSimulator() {
  for (const pending of scenarioTimers.values()) pending.forEach(clearTimeout);
  scenarioTimers.clear();
  deferredTimers.forEach(clearTimeout);
  deferredTimers.clear();
  webhookControllers.forEach((controller) => controller.abort());
  webhookControllers.clear();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', closeSimulator);
process.on('SIGTERM', closeSimulator);

