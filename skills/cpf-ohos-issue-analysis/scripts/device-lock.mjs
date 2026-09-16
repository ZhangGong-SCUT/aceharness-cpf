#!/usr/bin/env node
/**
 * 真机设备锁 — 多工作流 run 并发时的设备互斥
 *
 * 解决问题：多个 Issue 诊断 run 同时运行时争抢同一台真机/模拟器，
 * 导致 hdc install 互相覆盖（同 bundleName demo）、hilog 串台、
 * uitest 点击/截图串场。
 *
 * 用法（输出单行 JSON 便于 agent 解析）：
 *   node device-lock.mjs acquire --device 6HK0125B07000225 --run run-xxx [--step 问题复现] [--wait 1800] [--ttl 45]
 *   node device-lock.mjs release --device 6HK0125B07000225 --run run-xxx
 *   node device-lock.mjs status --device 6HK0125B07000225
 *   node device-lock.mjs clean            # 清理过期/僵尸锁
 *
 * 锁文件：~/.aceharness/data/device-locks/{deviceId}.lock
 *   与 ACEHarness 引擎 device-lock.ts 同目录同格式（互认）。
 *
 * 语义：
 *   - acquire 阻塞等待（默认最长 30 分钟，5s 轮询）；同 runId 重入 = 续租（刷新时间戳）
 *   - 租约默认 45 分钟（覆盖一次复现/验证窗口），到期自动过期，防止 run 崩溃后锁死
 *   - 僵尸锁判定：锁的 runId 在 ~/.aceharness/runs/ 下无归档目录 → 持有 run 已消失，可抢占
 *   - release 只有持有者 runId 能释放
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOCK_DIR = join(homedir(), '.aceharness', 'data', 'device-locks');
const RUNS_DIR = join(homedir(), '.aceharness', 'runs');
const POLL_MS = 5000;

function parseArgs(argv) {
  const cmd = argv[0];
  const args = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    }
  }
  return { cmd, args };
}

function lockPath(deviceId) {
  return join(LOCK_DIR, `${String(deviceId).replace(/[^a-zA-Z0-9_-]/g, '_')}.lock`);
}

function readLock(deviceId) {
  const p = lockPath(deviceId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

/** 持有 run 是否已消失（归档目录不存在 = run 已清理/异常终止）。
 *  加 5 分钟保护窗：新 run 的归档目录可能创建稍晚，锁龄 <5min 时不判僵尸，防误抢。 */
function isRunGone(lock) {
  if (!lock?.runId || !String(lock.runId).startsWith('run-')) return false;
  const age = Date.now() - new Date(lock.acquiredAt).getTime();
  if (age < 5 * 60 * 1000) return false;
  return !existsSync(join(RUNS_DIR, lock.runId));
}

function isStale(lock, ttlMinutes) {
  if (!lock) return true;
  if (isRunGone(lock)) return true;
  const age = Date.now() - new Date(lock.acquiredAt).getTime();
  return age > ttlMinutes * 60 * 1000;
}

function out(obj) { console.log(JSON.stringify(obj)); }

function tryAcquire(deviceId, runId, stepName, ttlMinutes) {
  if (!deviceId) return { acquired: true, deviceId: null, note: 'no deviceId, skip' };
  mkdirSync(LOCK_DIR, { recursive: true });
  const p = lockPath(deviceId);
  const existing = readLock(deviceId);

  if (existing) {
    if (existing.runId === runId) {
      // 同 run 重入 = 续租。直接覆盖写有极小竞态窗口（恰逢他人 stale 抢占），
      // 但续租方原本就是持有者，覆盖成自己的新时间戳语义等价，可接受。
      const renewed = { ...existing, acquiredAt: new Date().toISOString(), stepName: stepName || existing.stepName };
      writeFileSync(p, JSON.stringify(renewed, null, 2), 'utf-8');
      return { acquired: true, deviceId, renewed: true };
    }
    if (!isStale(existing, ttlMinutes)) {
      return { acquired: false, deviceId, holder: existing };
    }
    // 过期/僵尸：清掉后走下方独占创建抢入
    try { unlinkSync(p); } catch { /* 可能已被并发方清掉，继续 */ }
  }

  // 独占创建（O_EXCL）：并发 acquire 的原子性保证——只有一个进程能创建成功，
  // 其余收到 EEXIST 后重读锁（此刻必然是赢家的锁）按"被占"处理。
  const lock = { runId, deviceId, acquiredAt: new Date().toISOString(), stepName: stepName || '', pid: process.pid };
  try {
    writeFileSync(p, JSON.stringify(lock, null, 2), 'utf-8', { flag: 'wx' });
    return { acquired: true, deviceId, lock };
  } catch (e) {
    if (e.code === 'EEXIST') {
      const winner = readLock(deviceId);
      return { acquired: false, deviceId, holder: winner, note: 'lost race' };
    }
    return { acquired: false, deviceId, error: e.message };
  }
}

async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const deviceId = args.device || '';
  const runId = args.run || '';
  const ttlMinutes = parseInt(args.ttl || '45', 10);

  if (cmd === 'status') {
    const lock = readLock(deviceId);
    out(lock ? { locked: true, ...lock, stale: isStale(lock, ttlMinutes) } : { locked: false, deviceId });
    return;
  }

  if (cmd === 'clean') {
    let cleaned = 0;
    if (existsSync(LOCK_DIR)) {
      for (const f of readdirSync(LOCK_DIR)) {
        if (!f.endsWith('.lock')) continue;
        const p = join(LOCK_DIR, f);
        try {
          const lock = JSON.parse(readFileSync(p, 'utf-8'));
          if (isStale(lock, ttlMinutes)) { unlinkSync(p); cleaned++; }
        } catch { try { unlinkSync(p); cleaned++; } catch { /* ignore */ } }
      }
    }
    out({ cleaned });
    return;
  }

  if (cmd === 'release') {
    const lock = readLock(deviceId);
    if (!lock) { out({ released: true, note: 'no lock' }); return; }
    if (lock.runId !== runId) { out({ released: false, reason: 'not holder', holder: lock }); return; }
    try { unlinkSync(lockPath(deviceId)); out({ released: true, deviceId }); }
    catch (e) { out({ released: false, error: e.message }); }
    return;
  }

  if (cmd === 'acquire') {
    if (!deviceId || !runId) {
      out({ acquired: false, error: '--device 和 --run 必填' });
      process.exit(2);
    }
    const maxWaitMs = parseInt(args.wait || '1800', 10) * 1000;
    const start = Date.now();
    let last = null;
    while (Date.now() - start < maxWaitMs) {
      last = tryAcquire(deviceId, runId, args.step, ttlMinutes);
      if (last.acquired) { out({ ...last, waitedMs: Date.now() - start }); return; }
      await new Promise(r => setTimeout(r, POLL_MS));
    }
    out({ acquired: false, deviceId, waitedMs: Date.now() - start, reason: 'timeout', holder: last?.holder || null });
    process.exit(3); // 超时退出码 3，agent 据此降级
    return;
  }

  out({ error: `未知命令: ${cmd}（acquire|release|status|clean）` });
  process.exit(2);
}

main().catch(e => { out({ error: e.message }); process.exit(1); });
