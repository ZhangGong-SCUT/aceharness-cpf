import { getInstallPath, getWorkspaceDataFile, getWorkspaceRunsDir } from '@/lib/core/app-paths';
import {
  HOST_DEVICES_KEY,
  cleanStaleLocks,
  endDeviceSession,
  heartbeatLock,
  releaseAllForRun,
  isLockLive,
  listLiveLocks,
  platformQueueState,
  readLock,
  releaseLock,
  startDeviceSession,
  touchDeviceSession,
  tryAcquireLock,
} from '../../../scripts/device-lock-core.mjs';

/**
 * 设备锁机制
 *
 * 多工作流同时运行时，同一台真机/模拟器会被同时安装、点击、截图、抓日志。
 * 标了 deviceLock 的步骤（问题复现、修复验证）：
 *   - platform 模式（默认）：引擎不预先占设备，只登记本 run 的设备会话；agent 只差装包/运行时
 *     按平台申请 host-ohos / host-android / host-ios，用完释放；步骤结束引擎释放剩余的锁和排队。
 *   - host 模式（ACE_DEVICE_LOCK_MODE=host）：步骤开始时引擎持有 host-devices，覆盖本机全部设备。
 * 规则见 scripts/device-lock-core.mjs。
 */

const LOCK_POLL_INTERVAL_MS = 5 * 1000;
const LOCK_MAX_WAIT_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const WAIT_LOG_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STEP_WAIT_MINUTES = 180;

export interface DeviceLockInfo {
  runId: string;
  deviceId: string;
  acquiredAt: string;
  stepName: string;
  pid: number;
  owner?: 'engine' | 'script';
  heartbeatAt?: string;
}

function lockDir(): string {
  return getWorkspaceDataFile('device-locks');
}

function liveOptions() {
  return { runsDir: getWorkspaceRunsDir() };
}

export function tryAcquireDeviceLock(deviceId: string, runId: string, stepName: string): boolean {
  if (!deviceId) return true;
  return tryAcquireLock(lockDir(), deviceId, { runId, stepName, owner: 'engine' }, liveOptions()).acquired;
}

export async function acquireDeviceLock(
  deviceId: string,
  runId: string,
  stepName: string,
  maxWaitMs: number = LOCK_MAX_WAIT_MS,
): Promise<boolean> {
  if (!deviceId) return true;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    if (tryAcquireDeviceLock(deviceId, runId, stepName)) return true;
    await new Promise(resolve => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
  }
  return false;
}

export function releaseDeviceLock(deviceId: string, runId: string): void {
  if (!deviceId) return;
  releaseLock(lockDir(), deviceId, runId);
}

export function getDeviceLockStatus(deviceId: string): DeviceLockInfo | null {
  if (!deviceId) return null;
  const lock = readLock(lockDir(), deviceId) as DeviceLockInfo | null;
  return isLockLive(lock, liveOptions()) ? lock : null;
}

export function listLockedDevices(): DeviceLockInfo[] {
  return listLiveLocks(lockDir(), liveOptions()).map(({ lock }) => lock as DeviceLockInfo);
}

export function cleanupStaleLocks(): number {
  return cleanStaleLocks(lockDir(), liveOptions());
}

export type DeviceLockMode = 'platform' | 'host';

export function deviceLockMode(env: Record<string, string | undefined> = process.env): DeviceLockMode {
  return env.ACE_DEVICE_LOCK_MODE?.trim().toLowerCase() === 'host' ? 'host' : 'platform';
}

export interface StepDeviceLock {
  acquired: boolean;
  waitedMs: number;
  holder: DeviceLockInfo | null;
  release: () => void;
  mode?: DeviceLockMode;
  runId?: string;
  stepName?: string;
}

export function platformDeviceLockState(runId = '') {
  return platformQueueState(lockDir(), liveOptions(), runId);
}

/** 停止分析时调用：放掉本 run 还占着的平台锁、整机锁、单台设备锁和排队。 */
export function releaseRunDeviceLocks(runId: string) {
  if (!runId) return { releasedKeys: [], released: [], handedTo: {} };
  return releaseAllForRun(lockDir(), runId, liveOptions());
}

/** platform 模式：登记设备会话并心跳，release 时释放本 run 的全部平台锁和排队，交给下一位。 */
export function beginStepDeviceSession(input: { runId: string; stepName: string }): StepDeviceLock {
  const dir = lockDir();
  startDeviceSession(dir, input.runId, { stepName: input.stepName, pid: process.pid });
  const timer = setInterval(() => {
    try { touchDeviceSession(dir, input.runId); } catch { /* 下一次心跳再写 */ }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  let released = false;
  return {
    mode: 'platform',
    acquired: true,
    waitedMs: 0,
    holder: null,
    runId: input.runId,
    stepName: input.stepName,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      endDeviceSession(dir, input.runId, liveOptions());
    },
  };
}

/** bash、cmd、PowerShell 都能原样执行：Windows 路径换成正斜杠，去掉引号。 */
function quoteArg(value: string): string {
  return `"${value.replace(/\\/g, '/').replace(/["`$]/g, '')}"`;
}

function platformLockPromptNote(runId: string, stepName: string): string {
  const script = quoteArg(getInstallPath('skills', 'cpf-ohos-issue-analysis', 'scripts', 'device-lock.mjs'));
  const base = `node ${script}`;
  const ids = `--run ${runId} --step ${quoteArg(stepName)}`;
  return [
    '# 设备锁（按平台按需申请）',
    '鸿蒙、安卓、iOS 各有一把锁（host-ohos / host-android / host-ios），按申请先后排队。引擎没有预先占设备，本步骤结束时会释放本 run 剩下的锁和排队。',
    '1. 先列出本步骤还要做哪些平台的设备实验。读 issue、写 Demo、编 hap/apk 这些不碰设备的工作不需要锁，先做完。',
    `2. 只差装包/运行时，把还没做的平台都写上申请：\`${base} acquire --platforms ohos,android ${ids}\`（只做鸿蒙就只写 ohos）。`,
    '   - 退出码 0：输出里的 platform 就是拿到的锁，只操作这个平台的设备。有空闲的立刻拿到；都被占时在每个平台排队，谁先空出来就拿谁，别人释放时会立即交接给你。',
    '   - 退出码 4：单次最多等 4 分钟，仍在排队。原样再执行同一条命令，排队位置保留。',
    '   - 退出码 3：总等待超时，已撤队。剩下的平台不做设备操作。Issue 所在平台（鸿蒙问题就是 ohos）没拿到锁、黄金标志也没有 hilog 或截图时，问题复现不要交卷：reproduction_status 写 theoretical，正文写明「没拿到目标平台锁」，verdict 不要写成已复现。',
    `   - 退出码 5：本 run 还持有另一把平台锁，先执行第 3 步释放。`,
    `3. 这个平台的实验做完立刻释放：\`${base} release --platform <平台> --run ${runId}\`，再用剩下的平台重新执行第 2 步。全部做完或不再需要设备：\`${base} release --all --run ${runId}\`。`,
    '4. 同一时刻只持有一把平台锁，持锁期间不要去等另一个平台。',
    '没拿到某个平台的锁时，禁止操作该平台设备：鸿蒙 hdc install / aa start / uitest / snapshot_display / hilog 抓取；安卓 adb install / adb shell / 启动或关闭模拟器；iOS xcrun simctl 安装、启动、截图。只读查询（hdc list targets、adb devices、xcrun simctl list）不需要锁。禁止 adb emu kill：释放锁即可，不要关掉其他任务还在用的模拟器。hilog 单次抓取不要用 -z 100000，带超时并限制行数，避免步骤长时间没有新日志。',
    `查看锁和排队：\`${base} status --run ${runId}\`。`,
  ].join('\n');
}

/** 追加到设备步骤 prompt 末尾，告诉 agent 本步骤能不能动设备、怎么申请。 */
export function deviceLockPromptNote(lock: Pick<StepDeviceLock, 'acquired' | 'waitedMs' | 'holder' | 'mode' | 'runId' | 'stepName'>): string {
  if (lock.mode === 'platform') return platformLockPromptNote(lock.runId || '<runId>', lock.stepName || '');
  if (lock.acquired) {
    return [
      '# 设备锁',
      '引擎已为本 run 锁住本机全部真机和模拟器，本步骤结束时自动释放；其他 issue 分析的设备步骤会排队等待。',
      '本步骤内可以直接使用设备，不需要再调用 device-lock.mjs 申请或释放。',
    ].join('\n');
  }
  const holder = lock.holder
    ? `${lock.holder.runId}（${lock.holder.stepName || '未知步骤'}）`
    : '其他 issue 分析';
  return [
    '# 设备锁',
    `本机设备正被 ${holder} 占用，引擎等待 ${Math.round(lock.waitedMs / 60000)} 分钟后仍未拿到设备锁。`,
    '本步骤禁止任何设备操作：hdc install / aa start / uitest / snapshot_display / hilog 抓取、adb install / adb shell、xcrun simctl、启动或关闭模拟器都不要执行。',
    '只做不需要设备的工作（代码分析、编译产物检查等），结论按 needs_runtime_validation 降级，missing_evidence 写明「设备被其他分析占用，未做设备验证」。',
  ].join('\n');
}

export function stepDeviceLockWaitMs(env: Record<string, string | undefined> = process.env): number {
  const minutes = Number(env.ACE_DEVICE_LOCK_WAIT_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_STEP_WAIT_MINUTES) * 60 * 1000;
}

/**
 * 步骤级锁：等其他 run 释放本机全部设备后持有 host-devices，直到 release()。
 * shouldAbort 返回 true 时停止等待并抛错（工作流被停止）。
 */
export async function acquireStepDeviceLock(input: {
  runId: string;
  stepName: string;
  maxWaitMs?: number;
  shouldAbort?: () => boolean;
  onWait?: (holder: DeviceLockInfo | null, waitedMs: number) => void;
  pollMs?: number;
}): Promise<StepDeviceLock> {
  const dir = lockDir();
  const options = liveOptions();
  const maxWaitMs = input.maxWaitMs ?? stepDeviceLockWaitMs();
  const pollMs = input.pollMs ?? LOCK_POLL_INTERVAL_MS;
  const started = Date.now();
  let lastWaitLog = -Infinity;
  let holder: DeviceLockInfo | null = null;
  for (;;) {
    if (input.shouldAbort?.()) throw new Error('工作流已停止');
    const result = tryAcquireLock(dir, HOST_DEVICES_KEY, {
      runId: input.runId, stepName: input.stepName, owner: 'engine', pid: process.pid,
    }, options);
    if (result.acquired) {
      const timer = setInterval(() => {
        try { heartbeatLock(dir, HOST_DEVICES_KEY, input.runId); } catch { /* 下一次心跳再写 */ }
      }, HEARTBEAT_INTERVAL_MS);
      timer.unref?.();
      let released = false;
      return {
        acquired: true,
        waitedMs: Date.now() - started,
        holder: null,
        release: () => {
          if (released) return;
          released = true;
          clearInterval(timer);
          releaseLock(dir, HOST_DEVICES_KEY, input.runId);
        },
      };
    }
    holder = (result.holder as DeviceLockInfo | null) || null;
    const waitedMs = Date.now() - started;
    if (waitedMs >= maxWaitMs) return { acquired: false, waitedMs, holder, release: () => {} };
    if (waitedMs - lastWaitLog >= WAIT_LOG_INTERVAL_MS) {
      lastWaitLog = waitedMs;
      input.onWait?.(holder, waitedMs);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}