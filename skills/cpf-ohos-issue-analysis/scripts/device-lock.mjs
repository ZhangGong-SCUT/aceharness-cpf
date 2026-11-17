#!/usr/bin/env node
/**
 * 设备锁 — 多工作流 run 并发时的设备互斥
 *
 * 解决问题：多个 Issue 诊断 run 同时运行时争抢同一台真机/模拟器，
 * 导致 hdc install 互相覆盖（同 bundleName demo）、hilog 串台、
 * uitest 点击/截图串场。
 *
 * 平台锁（诊断工作流的问题复现、修复验证步骤）：鸿蒙、安卓、iOS 各一把，按需申请、用完释放。
 *   node device-lock.mjs acquire --platforms ohos,android --run run-xxx [--step 问题复现] [--wait 240] [--total 180]
 *     把本步骤还没做的设备实验平台都写上：有空闲的立刻拿到一把；都被占就在每个平台按申请先后排队，
 *     别人释放时直接交接给队头并唤醒等待方（fs.watch 事件，不轮询）。
 *     退出码：0 拿到（输出 platform）；4 本次等满 --wait 秒仍在排队，原样再调一次，位置保留；
 *            3 从第一次排队起超过 --total 分钟，已撤队，按降级处理；5 本 run 还持有另一把平台锁，先释放
 *   node device-lock.mjs release --platform ohos --run run-xxx   # 该平台实验做完立刻释放
 *   node device-lock.mjs release --all --run run-xxx             # 停止或不再需要设备：释放本 run 的全部锁和排队
 *   node device-lock.mjs status [--run run-xxx]                  # 三把平台锁的持有者、排队和本 run 的位置
 *
 * 单台设备锁（旧用法，非诊断步骤）：
 *   node device-lock.mjs acquire --device 6HK0125B07000225 --run run-xxx [--step 问题复现] [--wait 1800] [--ttl 45]
 *   node device-lock.mjs release --device 6HK0125B07000225 --run run-xxx
 *   node device-lock.mjs status --device 6HK0125B07000225
 *   node device-lock.mjs clean            # 清理过期/僵尸锁和失效排队
 *
 * 锁文件、排队与有效性规则见 scripts/device-lock-core.mjs（与引擎 device-lock.ts 共用）。
 */
import {
  cleanStaleLocks,
  defaultLockPaths,
  isLockLive,
  listLiveLocks,
  normalizePlatforms,
  platformQueueState,
  readLock,
  releaseLock,
  releasePlatformLock,
  releaseAllForRun,
  tryAcquireLock,
  waitForPlatformLock,
  PLATFORMS,
} from '../../../scripts/device-lock-core.mjs';

const { lockDir, runsDir } = defaultLockPaths();
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

function out(obj) { console.log(JSON.stringify(obj)); }

function exitWith(code) {
  process.exitCode = code;
}

async function acquirePlatforms(args, options) {
  const requested = args.platforms || args.platform;
  const platforms = normalizePlatforms(requested);
  if (!args.run || !platforms.length) {
    out({ acquired: false, error: `--run 必填，--platforms 取值 ${PLATFORMS.join(',')}` });
    return exitWith(2);
  }
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  const result = await waitForPlatformLock(lockDir, { runId: args.run, platforms, stepName: args.step }, {
    ...options,
    waitMs: parseInt(args.wait || '240', 10) * 1000,
    totalWaitMs: parseFloat(args.total || process.env.ACE_DEVICE_LOCK_WAIT_MINUTES || '180') * 60 * 1000,
    signal: controller.signal,
  });
  out(result);
  if (result.acquired) return exitWith(0);
  exitWith({ still_queued: 4, timeout: 3, holding_other: 5, invalid: 2 }[result.reason] ?? 1);
}

async function acquireDevice(args, options) {
  const deviceId = args.device;
  const maxWaitMs = parseInt(args.wait || '1800', 10) * 1000;
  const start = Date.now();
  let last = null;
  for (;;) {
    last = tryAcquireLock(lockDir, deviceId, { runId: args.run, stepName: args.step, owner: 'script' }, options);
    if (last.acquired) { out({ ...last, deviceId, waitedMs: Date.now() - start }); return exitWith(0); }
    if (last.error) { out({ ...last, deviceId }); return exitWith(1); }
    if (Date.now() - start >= maxWaitMs) break;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  out({ acquired: false, deviceId, waitedMs: Date.now() - start, reason: 'timeout', holder: last?.holder || null });
  exitWith(3); // 超时退出码 3，agent 据此降级
}

async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const deviceId = args.device || '';
  const runId = args.run || '';
  const scriptTtlMs = parseInt(args.ttl || '45', 10) * 60 * 1000;
  const options = { runsDir, scriptTtlMs };

  if (cmd === 'status') {
    if (deviceId) {
      const lock = readLock(lockDir, deviceId);
      out(lock ? { locked: true, ...lock, stale: !isLockLive(lock, { ...options, lockDir }) } : { locked: false, deviceId });
      return;
    }
    out({
      platforms: platformQueueState(lockDir, options, runId),
      locks: listLiveLocks(lockDir, options).map(({ lock }) => lock),
    });
    return;
  }

  if (cmd === 'clean') {
    out({ cleaned: cleanStaleLocks(lockDir, options) });
    return;
  }

  if (cmd === 'release') {
    if (!runId) { out({ released: false, error: '--run 必填' }); return exitWith(2); }
    if (args.all) {
      const result = releaseAllForRun(lockDir, runId, options);
      out({
        released: true,
        platforms: result.released,
        releasedKeys: result.releasedKeys,
        handedTo: result.handedTo,
      });
      return;
    }
    if (args.platform) {
      const result = releasePlatformLock(lockDir, runId, args.platform, options);
      out(result);
      return exitWith(result.released ? 0 : 1);
    }
    const result = releaseLock(lockDir, deviceId, runId, { keepEngineLock: true });
    out(result.released ? { ...result, deviceId } : result);
    return;
  }

  if (cmd === 'acquire') {
    if (args.platforms || args.platform) return acquirePlatforms(args, options);
    if (!deviceId || !runId) {
      out({ acquired: false, error: '--platforms（或旧用法 --device）和 --run 必填' });
      return exitWith(2);
    }
    return acquireDevice(args, options);
  }

  out({ error: `未知命令: ${cmd}（acquire|release|status|clean）` });
  exitWith(2);
}

main().catch(e => { out({ error: e.message }); process.exitCode = 1; });
