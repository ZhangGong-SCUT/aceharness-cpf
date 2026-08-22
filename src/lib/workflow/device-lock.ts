import { getWorkspaceDataFile } from '@/lib/core/app-paths';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';

/**
 * 设备锁机制
 *
 * 解决问题：多工作流同时运行时，可能同时操作同一台真机/模拟器设备，
 * 导致安装覆盖、hilog 串台、截图错乱等冲突。
 *
 * 机制：基于文件锁（lockfile），每个设备序列号对应一个锁文件。
 * 工作流在需要操作设备前（问题复现、代码修复、修复验证阶段）获取锁，
 * 操作完成后释放锁。如果锁已被其他工作流持有，当前工作流等待或降级。
 */

const LOCK_DIR = getWorkspaceDataFile('device-locks');
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 锁超时：10 分钟（防止工作流崩溃后锁不释放）
const LOCK_POLL_INTERVAL_MS = 5 * 1000; // 轮询间隔：5 秒
const LOCK_MAX_WAIT_MS = 30 * 60 * 1000; // 最大等待时间：30 分钟

export interface DeviceLockInfo {
  runId: string;
  deviceId: string;
  acquiredAt: string; // ISO 时间戳
  stepName: string;
  pid: number;
}

/**
 * 获取设备锁文件路径
 */
function getLockFilePath(deviceId: string): string {
  // 设备 ID 可能包含特殊字符，做简单清理
  const safeId = deviceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(LOCK_DIR, `${safeId}.lock`);
}

/**
 * 读取锁文件内容
 */
function readLockFile(deviceId: string): DeviceLockInfo | null {
  const lockPath = getLockFilePath(deviceId);
  if (!existsSync(lockPath)) return null;
  try {
    const content = readFileSync(lockPath, 'utf-8');
    return JSON.parse(content) as DeviceLockInfo;
  } catch {
    return null;
  }
}

/**
 * 检查锁是否已过期（超过 LOCK_TIMEOUT_MS）
 */
function isLockExpired(lockInfo: DeviceLockInfo): boolean {
  const acquiredTime = new Date(lockInfo.acquiredAt).getTime();
  const now = Date.now();
  return (now - acquiredTime) > LOCK_TIMEOUT_MS;
}

/**
 * 检查持有锁的进程是否还活着
 */
function isLockHolderAlive(lockInfo: DeviceLockInfo): boolean {
  try {
    // 发送信号 0 检查进程是否存在
    process.kill(lockInfo.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 尝试获取设备锁（非阻塞）
 *
 * @param deviceId 设备序列号
 * @param runId 当前工作流 runId
 * @param stepName 当前步骤名
 * @returns true=获取成功，false=锁已被其他工作流持有
 */
export function tryAcquireDeviceLock(
  deviceId: string,
  runId: string,
  stepName: string
): boolean {
  if (!deviceId) return true; // 无设备 ID 时不加锁

  // 确保锁目录存在
  if (!existsSync(LOCK_DIR)) {
    mkdirSync(LOCK_DIR, { recursive: true });
  }

  const lockPath = getLockFilePath(deviceId);
  const existingLock = readLockFile(deviceId);

  if (existingLock) {
    // 检查是否是自己的锁（重入）
    if (existingLock.runId === runId) {
      return true;
    }

    // 检查锁是否过期或持有者进程已死
    if (isLockExpired(existingLock) || !isLockHolderAlive(existingLock)) {
      // 清理过期/僵尸锁
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    } else {
      // 锁被其他工作流持有，且未过期
      return false;
    }
  }

  // 写入新锁
  const lockInfo: DeviceLockInfo = {
    runId,
    deviceId,
    acquiredAt: new Date().toISOString(),
    stepName,
    pid: process.pid,
  };
  try {
    writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取设备锁（阻塞，带超时）
 *
 * @param deviceId 设备序列号
 * @param runId 当前工作流 runId
 * @param stepName 当前步骤名
 * @param maxWaitMs 最大等待时间（默认 30 分钟）
 * @returns true=获取成功，false=超时未获取
 */
export async function acquireDeviceLock(
  deviceId: string,
  runId: string,
  stepName: string,
  maxWaitMs: number = LOCK_MAX_WAIT_MS
): Promise<boolean> {
  if (!deviceId) return true;

  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    if (tryAcquireDeviceLock(deviceId, runId, stepName)) {
      return true;
    }
    // 等待后重试
    await new Promise(resolve => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * 释放设备锁
 *
 * @param deviceId 设备序列号
 * @param runId 当前工作流 runId（只有持有者才能释放）
 */
export function releaseDeviceLock(deviceId: string, runId: string): void {
  if (!deviceId) return;

  const lockPath = getLockFilePath(deviceId);
  const existingLock = readLockFile(deviceId);

  if (!existingLock) return;

  // 只有持有者才能释放锁
  if (existingLock.runId !== runId) {
    return;
  }

  try {
    unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

/**
 * 查询设备锁状态
 *
 * @param deviceId 设备序列号
 * @returns 锁信息（如果被持有），或 null（如果空闲）
 */
export function getDeviceLockStatus(deviceId: string): DeviceLockInfo | null {
  if (!deviceId) return null;

  const lockInfo = readLockFile(deviceId);
  if (!lockInfo) return null;

  // 检查锁是否有效
  if (isLockExpired(lockInfo) || !isLockHolderAlive(lockInfo)) {
    return null;
  }

  return lockInfo;
}

/**
 * 列出所有被锁定的设备
 */
export function listLockedDevices(): DeviceLockInfo[] {
  if (!existsSync(LOCK_DIR)) return [];

  const { readdirSync } = require('fs');
  const files = readdirSync(LOCK_DIR) as string[];
  const locks: DeviceLockInfo[] = [];

  for (const file of files) {
    if (!file.endsWith('.lock')) continue;
    try {
      const content = readFileSync(join(LOCK_DIR, file), 'utf-8');
      const lockInfo = JSON.parse(content) as DeviceLockInfo;
      if (!isLockExpired(lockInfo) && isLockHolderAlive(lockInfo)) {
        locks.push(lockInfo);
      }
    } catch {
      // ignore malformed
    }
  }

  return locks;
}

/**
 * 清理所有过期/僵尸锁
 */
export function cleanupStaleLocks(): number {
  if (!existsSync(LOCK_DIR)) return 0;

  const { readdirSync } = require('fs');
  const files = readdirSync(LOCK_DIR) as string[];
  let cleaned = 0;

  for (const file of files) {
    if (!file.endsWith('.lock')) continue;
    try {
      const lockPath = join(LOCK_DIR, file);
      const content = readFileSync(lockPath, 'utf-8');
      const lockInfo = JSON.parse(content) as DeviceLockInfo;
      if (isLockExpired(lockInfo) || !isLockHolderAlive(lockInfo)) {
        unlinkSync(lockPath);
        cleaned++;
      }
    } catch {
      // ignore
    }
  }

  return cleaned;
}
