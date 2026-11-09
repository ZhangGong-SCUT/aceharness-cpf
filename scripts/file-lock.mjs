/**
 * 跨平台互斥锁。Linux 有 flock；macOS 和 Windows 默认没有。
 * 锁文件用 O_EXCL 创建，持有期间其他等待者轮询。
 */
import { closeSync, constants, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withFileLock(lockPath, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 900000;
  const pollMs = options.pollMs ?? 200;
  const sleep = options.sleep ?? defaultSleep;
  mkdirSync(dirname(lockPath), { recursive: true });
  const started = Date.now();
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started > timeoutMs) {
        const timeout = new Error(`等待锁超时: ${lockPath}`);
        timeout.code = 'ETIMEDOUT';
        throw timeout;
      }
      sleep(pollMs);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* 锁文件已被拿走 */ }
  }
}
