#!/usr/bin/env node
/**
 * ace aiweb — 启动随包携带的 CPF-AIWeb 工作台。
 * ACEHarness 仍用 `ace`（默认 3000）。工作台页面默认 8080，接口默认 3010。
 * 数据与密钥放在运行时目录，不写进安装包。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const installRoot = path.resolve(process.env.ACE_INSTALL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const aiwebRoot = path.join(installRoot, 'aiweb');

function runtimeRoot() {
  const aceHome = process.env.ACE_HOME?.trim();
  if (aceHome) return path.resolve(aceHome);
  if (process.platform === 'win32' && process.env.APPDATA?.trim()) {
    return path.resolve(process.env.APPDATA.trim(), 'ACEHarness');
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return path.resolve(xdg, 'aceharness');
  return path.join(os.homedir(), '.aceharness');
}

const dataRoot = runtimeRoot();
const envFile = path.join(dataRoot, 'aiweb.env');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readAcePort() {
  const file = path.join(dataRoot, 'data', 'system-settings.yaml');
  if (!fs.existsSync(file)) return 3000;
  const match = fs.readFileSync(file, 'utf8').match(/^port:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : 3000;
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort(start) {
  for (let port = start; port < start + 30; port += 1) {
    if (await portFree(port)) return port;
  }
  throw new Error(`从 ${start} 起没有可用端口`);
}

function waitForPort(port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`端口 ${port} 在 ${timeoutMs}ms 内没有开始监听`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function openBrowser(url) {
  let command = 'xdg-open';
  let args = [url];
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
  }
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    console.log(`[ACE] 请在浏览器中打开 ${url}`);
  });
  child.unref();
}

function assertDeps() {
  const missing = [];
  for (const name of ['express', 'dotenv', 'better-sqlite3', 'http-proxy-middleware', '@github/copilot-sdk']) {
    try {
      require.resolve(name, { paths: [installRoot] });
    } catch {
      missing.push(name);
    }
  }
  if (!missing.length) return;
  console.error(`[ACE] AIWeb 依赖未装进当前安装：${missing.join(', ')}`);
  console.error('[ACE] 请在 ACEHarness 安装目录执行 npm install 后重试。');
  process.exit(1);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log([
    '用法:',
    '  ace aiweb            启动 CPF-AIWeb 工作台（页面默认 8080，接口默认 3010）',
    '  ace aiweb --no-open  只启动，不打开浏览器',
    '',
    'ACEHarness 本身仍用 ace / ace start。',
    `配置：${envFile}`,
  ].join('\n'));
  process.exit(0);
}

if (!fs.existsSync(path.join(aiwebRoot, 'Server', 'server.js')) || !fs.existsSync(path.join(aiwebRoot, 'web', 'server.js'))) {
  console.error(`[ACE] 当前安装不含 AIWeb：${aiwebRoot}`);
  console.error('[ACE] 需要带 aiweb/ 目录的安装包。源码机可先运行 node scripts/stage-aiweb.mjs。');
  process.exit(1);
}

assertDeps();

fs.mkdirSync(dataRoot, { recursive: true });
if (!fs.existsSync(envFile)) {
  fs.writeFileSync(envFile, [
    '# ace aiweb 本机配置。填写后重新运行 ace aiweb。',
    '# 留空时，工作台会连本机 ace 的端口（默认 3000）。',
    'ACEHARNESS_EMAIL=',
    'ACEHARNESS_PASSWORD=',
    'GITCODE_TOKEN=',
    '',
  ].join('\n'));
  console.log(`[ACE] 已创建配置 ${envFile}`);
}
loadEnvFile(envFile);

const acePort = readAcePort();
const aceUrl = `http://127.0.0.1:${acePort}`;
if (!process.env.ACEHARNESS_API_BASE_URL) process.env.ACEHARNESS_API_BASE_URL = aceUrl;
if (!process.env.ACEHARNESS_BASE_URL) process.env.ACEHARNESS_BASE_URL = aceUrl;
const issueRoot = process.env.ISSUEANALYSIS_ROOT || path.join(dataRoot, 'aiweb', 'issueanalysis');
const statsRoot = process.env.WEB_STATS_ROOT || path.join(dataRoot, 'aiweb', 'web');
const tagDbDir = process.env.AIWEB_TAG_DB_DIR || path.join(dataRoot, 'aiweb', 'GitCodeTag');
const prcheckDbDir = process.env.AIWEB_PRCHECK_DB_DIR || path.join(dataRoot, 'aiweb', 'PrCheck');
const auditFile = process.env.AIWEB_AUDIT_FILE || path.join(dataRoot, 'aiweb', 'platform-audit.log');
for (const dir of [issueRoot, statsRoot, tagDbDir, prcheckDbDir, path.dirname(auditFile)]) {
  fs.mkdirSync(dir, { recursive: true });
}
process.env.ISSUEANALYSIS_ROOT = issueRoot;
process.env.WEB_STATS_ROOT = statsRoot;
process.env.AIWEB_TAG_DB_DIR = tagDbDir;
process.env.AIWEB_PRCHECK_DB_DIR = prcheckDbDir;
process.env.AIWEB_AUDIT_FILE = auditFile;

const children = [];
let shuttingDown = false;

function stop(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const apiPort = Number(process.env.AIWEB_API_PORT) || await pickPort(3010);
const webPort = Number(process.env.AIWEB_PORT) || await pickPort(8080);
const webUrl = `http://127.0.0.1:${webPort}`;

function spawnNode(script, extraEnv) {
  const child = spawn(process.execPath, [script], {
    cwd: aiwebRoot,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[ACE] ${path.basename(path.dirname(script))} 已退出 (${signal || code})`);
    stop(code || 1);
  });
  children.push(child);
  return child;
}

console.log(`[ACE] AIWeb 接口：http://127.0.0.1:${apiPort}`);
console.log(`[ACE] AIWeb 工作台：${webUrl}`);
console.log(`[ACE] 对接 ACEHarness：${process.env.ACEHARNESS_API_BASE_URL}`);
console.log('[ACE] 提交任务前请先在另一个终端运行 ace。Ctrl+C 停止工作台。');

spawnNode(path.join(aiwebRoot, 'Server', 'server.js'), {
  PORT: String(apiPort),
  HOST: process.env.AIWEB_HOST || '127.0.0.1',
  BASE_URL: `http://127.0.0.1:${apiPort}`,
  ISSUEANALYSIS_ROOT: issueRoot,
  WEB_STATS_ROOT: statsRoot,
});

try {
  await waitForPort(apiPort, 20000);
} catch (err) {
  console.error(`[ACE] AIWeb 接口没有起来：${err.message}`);
  stop(1);
}

spawnNode(path.join(aiwebRoot, 'web', 'server.js'), {
  PORT: String(webPort),
  HOST: process.env.AIWEB_HOST || '127.0.0.1',
  API_SERVER: `http://127.0.0.1:${apiPort}`,
});

try {
  await waitForPort(webPort, 20000);
} catch (err) {
  console.error(`[ACE] AIWeb 页面没有起来：${err.message}`);
  stop(1);
}

if (!process.argv.includes('--no-open')) openBrowser(webUrl);
