/** 统一重放真实快照和人工异常剧本，输出可审计的 JSON 结果；不访问真实平台。 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtureDirectory = fileURLToPath(new URL('./fixtures/gate-scenarios/', import.meta.url));
export const gateScript = fileURLToPath(new URL('../../../skills/gitcode-pr-review/scripts/check-pr-gates.mjs', import.meta.url));
export const commentScript = fileURLToPath(new URL('../../../skills/gitcode-pr-review/scripts/post-pr-comment.mjs', import.meta.url));
const reviewScript = fileURLToPath(new URL('../../../skills/gitcode-pr-review/scripts/fetch-ai-review.mjs', import.meta.url));
const scenarioApiRoot = '/_sim';

export function compressedEvents(scenario) {
  const scale = Number(scenario.timeScale || 1);
  assert.ok(Number.isFinite(scale) && scale > 0 && scale <= 1, `${scenario.id}: timeScale 非法`);
  let previousAtMs = 0;
  return scenario.script.map((step, index) => {
    assert.ok(Number.isFinite(step.atMs) && step.atMs >= previousAtMs, `${scenario.id}: 原始事件必须按时间排序`);
    const waitMs = Math.max(0, Math.ceil((step.atMs - previousAtMs) * scale));
    previousAtMs = step.atMs;
    return { ...step, waitMs, index };
  });
}

export async function loadScenarios(directory = fixtureDirectory) {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const scenarios = [];
  for (const name of files) {
    const parsed = JSON.parse(await readFile(resolve(directory, name), 'utf8'));
    scenarios.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  assert.ok(scenarios.length >= 4, '至少需要真实回放与人工异常两类剧本');
  const ids = new Set();
  for (const scenario of scenarios) {
    assert.equal(scenario.schema_version, 1);
    assert.ok(['real_replay', 'synthetic'].includes(scenario.kind));
    assert.ok(/^[a-z0-9-]+$/.test(scenario.id));
    assert.ok(!ids.has(scenario.id), `重复剧本 ID: ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(scenario.expected?.phase);
    assert.ok(Array.isArray(scenario.script) && scenario.script.length > 0);
    for (const step of [...scenario.script, ...(scenario.seed?.comments || [])]) {
      assert.ok(!/https?:\/\/(?!example\.invalid(?:[/:]|$))/i.test(String(step.comment || '')), `${scenario.id}: 夹具不得保留真实 URL`);
      assert.ok(!/[\w.+-]+@(?!example\.invalid(?:$|[^A-Za-z]))[\w.-]+\.[A-Za-z]{2,}/.test(String(step.comment || '')), `${scenario.id}: 夹具不得保留真实邮箱`);
      assert.ok(!/(?:access_token|token|password|secret)=/i.test(String(step.comment || '')), `${scenario.id}: 夹具不得包含凭据`);
    }
    compressedEvents(scenario);
  }
  return scenarios;
}

export function createReplay({ base, outputRoot }) {
  const post = async (path, body) => {
    const response = await fetch(`${base}${scenarioApiRoot}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${text}`);
    return JSON.parse(text);
  };
  const run = (script, args) => new Promise((fulfil, reject) => {
    execFile(process.execPath, [script, ...args, '--token', 'test-token'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITCODE_API_ROOT: `${base}/api/v5`,
        ACE_GITCODE_DCP_REPORT: '0', ACE_GITCODE_GATE_LOGS: '0', ACE_GITCODE_PR_AUTHOR: 'replay-author',
      },
    }, (error, stdout, stderr) => error ? reject(new Error(`${script}: ${error.message}\n${stdout}\n${stderr}`)) : fulfil(JSON.parse(stdout)));
  });
  const check = (scenario, suffix) => run(gateScript, [
    '--owner', scenario.pr.owner, '--repo', scenario.pr.repo, '--number', String(scenario.pr.number),
    '--out', resolve(outputRoot, `${scenario.id}-${suffix}`),
  ]);
  const commentsPath = (scenario) => `/repos/${encodeURIComponent(scenario.pr.owner)}/${encodeURIComponent(scenario.pr.repo)}/pulls/${scenario.pr.number}/comments?per_page=100`;
  const rawComments = async (scenario) => {
    const response = await fetch(`${base}/api/v5${commentsPath(scenario)}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const rawState = async (scenario) => {
    const { owner, repo, number } = scenario.pr;
    const response = await fetch(`${base}/_sim/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const waitForStep = async (scenario, step) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const progress = (await rawState(scenario)).scenarioProgress;
      if (progress?.runId && progress.completedSteps >= step + 1) return;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(`${scenario.id}: 等待第 ${step + 1} 个剧本事件超时`);
  };
  return async function replay(scenario) {
    const pr = { author: 'replay-author', head_repo: 'replay-author/replay-fork', head_ref: 'replay-branch', ...scenario.pr };
    await post('pr', { ...pr, labels: scenario.seed?.labels || [] });
    if (scenario.seed?.comments?.length) {
      await post('state', { owner: pr.owner, repo: pr.repo, number: pr.number, comments: scenario.seed.comments.map((item, index) => ({
        id: `seed-${scenario.id}-${index}`, body: item.comment, created_at: item.source_created_at,
        user: { login: item.who, username: item.who }, comment_type: 'pr_comment',
      })) });
    }
    const events = compressedEvents(scenario);
    const manual = Boolean(scenario.checkpoints?.length || scenario.interrupt);
    await post('scenario', { owner: pr.owner, repo: pr.repo, number: pr.number, script: events, manual });
    const start = await run(commentScript, [
      '--owner', pr.owner, '--repo', pr.repo, '--number', String(pr.number), '--author', pr.author,
      '--body', 'start build', '--out', resolve(outputRoot, `${scenario.id}-comment`),
    ]);
    assert.equal(start.wait_ack, 'skipped');
    // 重试预算只统计 PR 作者自己的 start build。显式指定 --token 时脚本不能从 PR 自动
    // 推断作者，所以将回放事件身份改为同一脱敏作者，保持真实快照中的身份关系。
    await post('state', { owner: pr.owner, repo: pr.repo, number: pr.number, comments: (await rawComments(scenario)).map((item) => ({
      ...item, user: /^\s*start\s+build\s*$/i.test(String(item.body || ''))
        ? { login: pr.author, username: pr.author }
        : item.user,
    })) });
    const checkpoints = [];
    let interrupted = null;
    const interrupt = async () => {
      if (!scenario.interrupt || interrupted) return;
      interrupted = await post('git-push', {
        fork: pr.head_repo, branch: pr.head_ref, sha: scenario.interrupt.push.sha,
      });
    };
    for (let index = 0; index < events.length; index += 1) {
      if (scenario.interrupt && !interrupted && index >= scenario.interrupt.beforeStep) await interrupt();
      if (interrupted) {
        const progress = (await rawState(scenario)).scenarioProgress;
        assert.equal(progress.running, false, 'push 必须取消旧剧本');
        assert.equal(progress.completedSteps, index, '旧剧本剩余步骤不得继续执行');
        break;
      }
      if (manual) {
        const step = await post('scenario-step', { owner: pr.owner, repo: pr.repo, number: pr.number });
        assert.equal(step.completedSteps, index + 1);
      }
      await waitForStep(scenario, index);
      const expected = scenario.checkpoints?.find((item) => item.afterStep === index)?.expected;
      if (expected) {
        const actual = await check(scenario, `checkpoint-${index}`);
        assert.equal(actual.phase, expected.phase, `${scenario.id}: checkpoint ${index}`);
        checkpoints.push({ afterStep: index, expected: expected.phase, actual: actual.phase });
      }
    }
    if (scenario.interrupt && !interrupted) await interrupt();
    await new Promise((done) => setTimeout(done, 100));
    let result = await check(scenario, 'final');
    let review = null;
    if (scenario.expected.phase === 'ai_review_pending') {
      const out = resolve(outputRoot, `${scenario.id}-review`);
      review = await run(reviewScript, [
        '--owner', pr.owner, '--repo', pr.repo, '--number', String(pr.number), '--author', pr.author, '--out', out,
      ]);
      assert.ok(review.actionable_count > 0, `${scenario.id}: 真实检视筛选必须识别待处理意见`);
      // 与 configs/gitcode-pr-review.yaml 的分流检视步骤一致：
      // actionable_count > 0 时由工作流 verdict=fail、next_state=检视修复。
      result = { ...result, phase: 'ai_review_pending', next_state: '检视修复', verdict: 'fail', ai_actionable_count: review.actionable_count };
    }
    assert.equal(result.phase, scenario.expected.phase, `${scenario.id}: ${result.summary}`);
    const current = await rawState(scenario);
    if (scenario.interrupt) {
      assert.equal(current.head_sha, scenario.interrupt.push.sha);
      assert.ok(!current.comments.some((item) => /noPass/.test(item.body)), '旧剧本的失败评论不得在新 push 后落库');
    }
    if (scenario.expected.duplicateStartBuildRejected) {
      // 构造运行中的重复触发：剧本结束后允许人工重跑，因此不能拿结束态验证去重。
      await post('scenario', { owner: pr.owner, repo: pr.repo, number: pr.number, script: [{ waitMs: 5000, comment: 'hold' }] });
      const first = await fetch(`${base}/api/v5/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments?access_token=test-token`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'start build' }),
      });
      assert.equal((await first.json()).scenario_scheduled, true);
      const duplicate = await fetch(`${base}/api/v5/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments?access_token=test-token`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'start build' }),
      });
      assert.equal(duplicate.status, 201);
      assert.equal((await duplicate.json()).scenario_scheduled, false, '运行中的同一版本不得重复调度剧本');
      await post('pr', { ...pr, labels: current.labels });
      await new Promise((done) => setTimeout(done, 5100));
    }
    return {
      id: scenario.id, kind: scenario.kind, source: scenario.source?.repository || null,
      events: events.length, expected_phase: scenario.expected.phase, actual_phase: result.phase,
      checkpoints, status: 'passed',
    };
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.env.SIM_BASE_URL;
  if (!base) throw new Error('请通过 gitcode-scenario-replay.test.mjs 运行，或设置 SIM_BASE_URL');
  const outputRoot = resolve(process.env.SIM_REPLAY_OUT || '/tmp/gitcode-scenario-replay');
  await mkdir(outputRoot, { recursive: true });
  const replay = createReplay({ base, outputRoot });
  const results = [];
  for (const scenario of await loadScenarios()) results.push(await replay(scenario));
  const report = resolve(outputRoot, 'replay-results.json');
  await writeFile(report, `${JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ report, results }, null, 2)}\n`);
}
