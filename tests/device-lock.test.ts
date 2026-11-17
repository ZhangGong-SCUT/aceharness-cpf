import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOST_DEVICES_KEY,
  blockingLocks,
  heartbeatLock,
  inferRunId,
  isLockLive,
  readLock,
  releaseLock,
  tryAcquireLock,
} from '../scripts/device-lock-core.mjs';
import { foreignDeviceLock } from '../scripts/ohos-har-install.mjs';
import {
  acquireStepDeviceLock,
  deviceLockPromptNote,
  listLockedDevices,
  stepDeviceLockWaitMs,
} from '@/lib/workflow/device-lock';

const DEAD_PID = 2 ** 22 + 12345;

let root: string;
let lockDir: string;
let runsDir: string;
let savedAceHome: string | undefined;

function writeLock(key: string, lock: Record<string, unknown>) {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, `${key}.lock`), JSON.stringify(lock));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'device-lock-'));
  lockDir = join(root, 'data', 'device-locks');
  runsDir = join(root, 'runs');
  mkdirSync(runsDir, { recursive: true });
  savedAceHome = process.env.ACE_HOME;
  process.env.ACE_HOME = root;
});

afterEach(() => {
  if (savedAceHome === undefined) delete process.env.ACE_HOME;
  else process.env.ACE_HOME = savedAceHome;
  rmSync(root, { recursive: true, force: true });
});

describe('device-lock-core', () => {
  it('host-devices 与其他 run 的单台设备锁互斥，同 run 可重入', () => {
    expect(tryAcquireLock(lockDir, 'SERIAL1', { runId: 'run-a', stepName: 's', owner: 'script' }, { runsDir }).acquired).toBe(true);

    const host = tryAcquireLock(lockDir, HOST_DEVICES_KEY, { runId: 'run-b', stepName: 'h', owner: 'engine' }, { runsDir });
    expect(host.acquired).toBe(false);
    expect(host.holder.runId).toBe('run-a');

    expect(tryAcquireLock(lockDir, 'SERIAL2', { runId: 'run-b', stepName: 's', owner: 'script' }, { runsDir }).acquired).toBe(true);
    expect(tryAcquireLock(lockDir, HOST_DEVICES_KEY, { runId: 'run-a', stepName: 'h', owner: 'engine' }, { runsDir }).acquired).toBe(false);

    releaseLock(lockDir, 'SERIAL2', 'run-b');
    expect(tryAcquireLock(lockDir, HOST_DEVICES_KEY, { runId: 'run-a', stepName: 'h', owner: 'engine' }, { runsDir }).acquired).toBe(true);
    expect(tryAcquireLock(lockDir, 'SERIAL3', { runId: 'run-b', stepName: 's', owner: 'script' }, { runsDir }).acquired).toBe(false);
    expect(tryAcquireLock(lockDir, 'SERIAL3', { runId: 'run-a', stepName: 's', owner: 'script' }, { runsDir }).acquired).toBe(true);
  });

  it('引擎锁按进程和心跳判定，脚本锁不因脚本进程退出而失效', () => {
    const now = Date.now();
    const fresh = new Date(now).toISOString();
    const old = new Date(now - 11 * 60 * 1000).toISOString();
    expect(isLockLive({ runId: 'run-a', owner: 'engine', pid: process.pid, acquiredAt: old, heartbeatAt: fresh })).toBe(true);
    expect(isLockLive({ runId: 'run-a', owner: 'engine', pid: process.pid, acquiredAt: old, heartbeatAt: old })).toBe(false);
    expect(isLockLive({ runId: 'run-a', owner: 'engine', pid: DEAD_PID, acquiredAt: fresh, heartbeatAt: fresh })).toBe(false);
    expect(isLockLive({ runId: 'run-a', owner: 'script', pid: DEAD_PID, acquiredAt: fresh })).toBe(true);
    expect(isLockLive({ runId: 'run-a', owner: 'script', pid: DEAD_PID, acquiredAt: new Date(now - 46 * 60 * 1000).toISOString() })).toBe(false);
  });

  it('脚本锁超过 5 分钟后要求 run 归档目录还在', () => {
    const lock = { runId: 'run-gone', owner: 'script', pid: DEAD_PID, acquiredAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() };
    expect(isLockLive(lock, { runsDir })).toBe(false);
    mkdirSync(join(runsDir, 'run-gone'));
    expect(isLockLive(lock, { runsDir })).toBe(true);
  });

  it('其他 run 的失效锁会被接管', () => {
    writeLock(HOST_DEVICES_KEY, { runId: 'run-old', owner: 'engine', pid: DEAD_PID, acquiredAt: new Date().toISOString() });
    const result = tryAcquireLock(lockDir, HOST_DEVICES_KEY, { runId: 'run-new', stepName: 'h', owner: 'engine' }, { runsDir });
    expect(result.acquired).toBe(true);
    expect(readLock(lockDir, HOST_DEVICES_KEY).runId).toBe('run-new');
  });

  it('同 run 引擎重入时换成当前进程，脚本不能释放引擎锁', () => {
    writeLock(HOST_DEVICES_KEY, { runId: 'run-a', owner: 'engine', pid: DEAD_PID, acquiredAt: new Date().toISOString() });
    expect(tryAcquireLock(lockDir, HOST_DEVICES_KEY, { runId: 'run-a', stepName: 'h', owner: 'engine', pid: process.pid }, { runsDir }).acquired).toBe(true);
    expect(readLock(lockDir, HOST_DEVICES_KEY).pid).toBe(process.pid);

    expect(tryAcquireLock(lockDir, HOST_DEVICES_KEY, { runId: 'run-a', stepName: 'x', owner: 'script' }, { runsDir }).acquired).toBe(true);
    expect(readLock(lockDir, HOST_DEVICES_KEY).owner).toBe('engine');
    expect(releaseLock(lockDir, HOST_DEVICES_KEY, 'run-a', { keepEngineLock: true }).released).toBe(false);
    expect(heartbeatLock(lockDir, HOST_DEVICES_KEY, 'run-a')).toBe(true);
    expect(releaseLock(lockDir, HOST_DEVICES_KEY, 'run-a').released).toBe(true);
  });

  it('从 HAP 路径或工作目录推断 run id', () => {
    expect(inferRunId(['', '/Users/x/.aceharness/run-workspaces/run-123-ia-ab/demo/entry.hap'])).toBe('run-123-ia-ab');
    expect(inferRunId(['C:\\ace\\runs\\run-9\\out.hap'])).toBe('run-9');
    expect(inferRunId(['/tmp/demo.hap', '/tmp'])).toBe('');
  });
});

describe('ohos-har-install 设备锁检查', () => {
  it('其他 run 持锁时返回持有者，本 run 持锁时放行', async () => {
    writeLock(HOST_DEVICES_KEY, { runId: 'run-a', owner: 'engine', pid: process.pid, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), stepName: '问题复现/问题复现' });

    const other = await foreignDeviceLock({ hap: join(root, 'run-workspaces', 'run-b', 'demo.hap'), device: 'SERIAL1' }, root);
    expect(other.runId).toBe('run-b');
    expect(other.holder?.runId).toBe('run-a');

    const own = await foreignDeviceLock({ hap: join(root, 'run-workspaces', 'run-a', 'demo.hap'), device: 'SERIAL1' }, root);
    expect(own.holder).toBeNull();

    const unknown = await foreignDeviceLock({ hap: '/tmp/demo.hap' }, '/tmp');
    expect(unknown.runId).toBe('');
    expect(unknown.holder?.runId).toBe('run-a');

    expect((await foreignDeviceLock({ hap: '/tmp/demo.hap', run: 'run-a' }, '/tmp')).holder).toBeNull();
  });
});

describe('acquireStepDeviceLock', () => {
  it('拿到锁后写心跳字段，release 后释放', async () => {
    const lock = await acquireStepDeviceLock({ runId: 'run-a', stepName: '问题复现/问题复现', maxWaitMs: 0 });
    expect(lock.acquired).toBe(true);
    expect(listLockedDevices()).toEqual([expect.objectContaining({ runId: 'run-a', owner: 'engine', pid: process.pid })]);
    lock.release();
    lock.release();
    expect(listLockedDevices()).toEqual([]);
  });

  it('其他 run 持锁时等待超时并带回持有者，等待中可被中止', async () => {
    writeLock('SERIAL1', { runId: 'run-b', owner: 'script', pid: DEAD_PID, acquiredAt: new Date().toISOString(), stepName: '修复验证' });
    const waits: number[] = [];
    const lock = await acquireStepDeviceLock({
      runId: 'run-a', stepName: '问题复现/问题复现', maxWaitMs: 30, pollMs: 5, onWait: (_holder, ms) => waits.push(ms),
    });
    expect(lock.acquired).toBe(false);
    expect(lock.holder?.runId).toBe('run-b');
    expect(waits.length).toBeGreaterThan(0);
    expect(readLock(lockDir, HOST_DEVICES_KEY)).toBeNull();
    expect(deviceLockPromptNote(lock)).toContain('run-b（修复验证）');

    let stop = false;
    const pending = acquireStepDeviceLock({ runId: 'run-a', stepName: 'x', maxWaitMs: 60_000, pollMs: 5, shouldAbort: () => stop });
    setTimeout(() => { stop = true; }, 20);
    await expect(pending).rejects.toThrow('工作流已停止');
  });

  it('等待上限读 ACE_DEVICE_LOCK_WAIT_MINUTES，默认 180 分钟', () => {
    expect(stepDeviceLockWaitMs({})).toBe(180 * 60 * 1000);
    expect(stepDeviceLockWaitMs({ ACE_DEVICE_LOCK_WAIT_MINUTES: '5' })).toBe(5 * 60 * 1000);
    expect(stepDeviceLockWaitMs({ ACE_DEVICE_LOCK_WAIT_MINUTES: 'x' })).toBe(180 * 60 * 1000);
  });

  it('blockingLocks 忽略本 run 的锁', () => {
    writeLock(HOST_DEVICES_KEY, { runId: 'run-a', owner: 'engine', pid: process.pid, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
    expect(blockingLocks(lockDir, 'SERIAL1', 'run-a', { runsDir })).toEqual([]);
    expect(blockingLocks(lockDir, 'SERIAL1', 'run-b', { runsDir })).toHaveLength(1);
  });
});
