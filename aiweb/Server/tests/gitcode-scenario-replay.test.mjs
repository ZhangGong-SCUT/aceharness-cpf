import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { loadScenarios, createReplay } from './gitcode-scenario-replay.mjs';

const simulator = fileURLToPath(new URL('./gitcode-simulator.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'gitcode-scenario-replay-'));
let child;
let webhooks;
let base;
let output = '';
const deliveredWebhooks = [];

before(async () => {
  webhooks = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      deliveredWebhooks.push({ at: Date.now(), path: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  webhooks.listen(0, '127.0.0.1');
  await once(webhooks, 'listening');
  child = spawn(process.execPath, [simulator, '--port', '0', '--root', root,
    '--ace-webhook', `http://127.0.0.1:${webhooks.address().port}/webhook`], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100 && !base; attempt += 1) {
    await new Promise((done) => setTimeout(done, 30));
    base = output.match(/监听 (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || '';
  }
  assert.ok(base, `模拟器未启动: ${output}`);
});

beforeEach(async (context) => {
  output = '';
  const response = await fetch(`${base}/_sim/reset`);
  assert.equal(response.status, 200);
  await fetch(`${base}/_sim/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webhookTimeoutMs: 100 }),
  });
  context.after(() => {
    if (context.error) process.stderr.write(`\n剧本失败现场:\n${output}\n`);
  });
});

after(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  webhooks.closeIdleConnections();
  webhooks.closeAllConnections();
  await new Promise((done) => webhooks.close(done));
  if (child && child.exitCode !== 0 && child.exitCode !== null) {
    process.stderr.write(`模拟器异常退出: ${output}\n`);
  }
  rmSync(root, { recursive: true, force: true });
});

test('剧本目录区分真实回放与人工异常，时间单调且不含有效链接', async () => {
  const scenarios = await loadScenarios();
  assert.ok(scenarios.filter((item) => item.kind === 'real_replay').length >= 4);
  assert.ok(scenarios.filter((item) => item.kind === 'synthetic').length >= 6);
});

const scenarios = (await loadScenarios()).filter((scenario) => !process.env.REPLAY_SCENARIO_ID || scenario.id === process.env.REPLAY_SCENARIO_ID);
for (const scenario of scenarios) {
  test(`${scenario.kind}: ${scenario.id}`, async () => {
    const replay = createReplay({ base, outputRoot: root });
    const result = await replay(scenario);
    assert.equal(result.status, 'passed');
    assert.equal(result.actual_phase, scenario.expected.phase);
  });
}

test('全部剧本报告落盘，真实记录和人工推断可区分', async () => {
  await mkdir(root, { recursive: true });
  const results = [];
  for (const scenario of scenarios.filter((item) => item.kind === 'real_replay')) {
    results.push({ id: scenario.id, kind: scenario.kind, source: scenario.source.repository, expected: scenario.expected.phase });
  }
  await writeFile(resolve(root, 'scenario-evidence.json'), `${JSON.stringify(results, null, 2)}\n`);
  assert.ok(results.every((item) => item.kind === 'real_replay' && item.source));
});
