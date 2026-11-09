#!/usr/bin/env node
/**
 * ace up — 一次启动 ACEHarness 和 AIWeb。
 * ACEHarness 已在监听时不重复启动。AIWeb 仍由 ace aiweb 拉起。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeRoot } from './runtime-root.mjs';

const installRoot = path.resolve(process.env.ACE_INSTALL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const aceBin = path.join(installRoot, 'bin', 'ace.js');

function readAcePort() {
  const file = path.join(runtimeRoot(), 'data', 'system-settings.yaml');
  if (!fs.existsSync(file)) return Number(process.env.ACE_PORT || process.env.PORT || 3000);
  const match = fs.readFileSync(file, 'utf8').match(/^port:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : 3000;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const acePort = readAcePort();
const aiwebArgs = process.argv.slice(2);
let aceChild = null;

if (!(await portOpen(acePort))) {
  console.log(`[ACE] 正在启动 ACEHarness（127.0.0.1:${acePort}）`);
  aceChild = spawn(process.execPath, [aceBin, 'start'], { stdio: 'inherit', env: process.env });
  let aceCode = null;
  aceChild.once('exit', (code) => { aceCode = code ?? 1; });
  const started = Date.now();
  while (!(await portOpen(acePort))) {
    if (aceCode !== null && aceCode !== 0) process.exit(aceCode);
    if (Date.now() - started > 120000) {
      console.error(`[ACE] ACEHarness 在 120s 内没有监听 ${acePort}`);
      if (aceCode === null) aceChild.kill('SIGTERM');
      process.exit(1);
    }
    if (aceCode === 0) break;
    await sleep(300);
  }
  if (!(await portOpen(acePort))) {
    await sleep(500);
  }
  if (!(await portOpen(acePort))) {
    console.error(`[ACE] ACEHarness 进程已结束，但端口 ${acePort} 没有监听`);
    process.exit(1);
  }
  if (aceCode !== null) aceChild = null;
} else {
  console.log(`[ACE] ACEHarness 已在 127.0.0.1:${acePort} 监听`);
}

console.log('[ACE] 正在启动 AIWeb');
const aiweb = spawn(process.execPath, [aceBin, 'aiweb', ...aiwebArgs], { stdio: 'inherit', env: process.env });

function stop() {
  if (aiweb.exitCode === null && aiweb.signalCode === null) aiweb.kill('SIGTERM');
  if (aceChild && aceChild.exitCode === null && aceChild.signalCode === null) aceChild.kill('SIGTERM');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
aiweb.once('exit', (code) => process.exit(code ?? 0));
