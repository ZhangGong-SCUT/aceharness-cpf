/**
 * 真机/模拟器锁的共用规则。引擎 src/lib/workflow/device-lock.ts、技能脚本 device-lock.mjs、
 * ohos-har-install.mjs 都按这里判断锁是否还有效。只依赖 Node 内置模块：运行时目录里的
 * 旧脚本副本不会自动更新，部署时把本文件单独拷到 ~/.aceharness/scripts/。
 *
 * 锁文件：<运行时根>/data/device-locks/<key>.lock
 *   - host-devices：旧模式（ACE_DEVICE_LOCK_MODE=host）下引擎在设备步骤上持有，覆盖本机全部设备
 *   - host-ohos / host-android / host-ios：平台锁，agent 按需申请，用完释放
 *   - <序列号>：技能脚本按单台设备持有
 * 有效性：
 *   - owner=engine：持锁进程还活着，且心跳未超过 10 分钟
 *   - 平台锁：交接后 3 分钟内要被认领；认领后在本 run 设备会话存活期间有效，否则按 45 分钟租约
 *   - 其余：租约内（默认 45 分钟），且持有 run 的归档目录还在（新锁 5 分钟内不判）
 * 互斥：host-devices 与任何其他 run 的设备锁互斥；平台锁、单台设备锁只与同名锁和其他 run 的 host-devices 互斥。
 *
 * 平台锁排队（queue/<平台>~<runId>.json）按申请先后交接：持有者释放时由释放方直接把锁写给队头，
 * 等待方通过 fs.watch 被唤醒，不轮询。一个 run 同时最多持有一把平台锁，持锁时不参与其他平台的交接，
 * 因此不会出现「A 持 ohos 等 android、B 持 android 等 ohos」的互锁。
 * 设备会话（sessions/<runId>.json）由引擎在设备步骤期间心跳，步骤结束时释放该 run 的全部平台锁和排队。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

export const HOST_DEVICES_KEY = 'host-devices';
export const ENGINE_HEARTBEAT_STALE_MS = 10 * 60 * 1000;
export const SCRIPT_LOCK_TTL_MS = 45 * 60 * 1000;
export const PLATFORMS = ['ohos', 'android', 'ios'];
export const TICKET_GRACE_MS = 3 * 60 * 1000;
export const CLAIM_GRACE_MS = 3 * 60 * 1000;
const TICKET_TOUCH_MS = 60 * 1000;
const RUN_GONE_GRACE_MS = 5 * 60 * 1000;
const PLATFORM_ALIASES = { ohos: 'ohos', harmony: 'ohos', harmonyos: 'ohos', openharmony: 'ohos', hdc: 'ohos', android: 'android', adb: 'android', ios: 'ios', simctl: 'ios' };

/** 与 scripts/runtime-root.mjs 同一顺序；这里内联是为了让本文件可以单独拷贝。 */
export function runtimeRootFor(env = process.env, platform = process.platform, home = homedir()) {
  const pathApi = platform === 'win32' ? win32 : posix;
  const aceHome = env.ACE_HOME?.trim();
  if (aceHome) return pathApi.resolve(aceHome);
  if (platform === 'win32' && env.APPDATA?.trim()) return pathApi.resolve(env.APPDATA.trim(), 'ACEHarness');
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) return pathApi.resolve(xdgDataHome, 'aceharness');
  return pathApi.join(home, '.aceharness');
}

export function defaultLockPaths(root = runtimeRootFor()) {
  return { lockDir: join(root, 'data', 'device-locks'), runsDir: join(root, 'runs') };
}

export function lockKey(deviceId) {
  return String(deviceId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function lockFile(lockDir, key) {
  return join(lockDir, `${lockKey(key)}.lock`);
}

export function readLock(lockDir, key) {
  const file = lockFile(lockDir, key);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function timeOf(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function runDirOk(lock, options, age) {
  const runsDir = options.runsDir;
  if (runsDir && String(lock.runId || '').startsWith('run-') && age >= RUN_GONE_GRACE_MS) {
    return existsSync(join(runsDir, lock.runId));
  }
  return true;
}

/** options.lockDir 存在时平台锁会参考本 run 的设备会话。 */
export function isLockLive(lock, options = {}) {
  if (!lock || typeof lock !== 'object') return false;
  const now = options.now ?? Date.now();
  if (lock.owner === 'engine') {
    const alive = options.pidAlive ?? pidAlive;
    return alive(lock.pid) && now - timeOf(lock.heartbeatAt || lock.acquiredAt) <= ENGINE_HEARTBEAT_STALE_MS;
  }
  if (lock.platform) {
    const session = options.lockDir ? readSession(options.lockDir, lock.runId) : null;
    if (session && !sessionAlive(session, options)) return false;
    if (!lock.claimedAt) return now - timeOf(lock.acquiredAt) <= CLAIM_GRACE_MS;
    if (session) return true;
    const age = now - timeOf(lock.claimedAt);
    return age <= (options.scriptTtlMs ?? SCRIPT_LOCK_TTL_MS) && runDirOk(lock, options, age);
  }
  const age = now - timeOf(lock.acquiredAt);
  if (age > (options.scriptTtlMs ?? SCRIPT_LOCK_TTL_MS)) return false;
  return runDirOk(lock, options, age);
}

export function listLiveLocks(lockDir, options = {}) {
  if (!existsSync(lockDir)) return [];
  const live = [];
  const liveOptions = { lockDir, ...options };
  for (const name of readdirSync(lockDir)) {
    if (!name.endsWith('.lock')) continue;
    const key = name.slice(0, -'.lock'.length);
    const lock = readLock(lockDir, key);
    if (isLockLive(lock, liveOptions)) live.push({ key, lock });
  }
  return live;
}

/** 其他 run 持有、会挡住 key 的有效锁。 */
export function blockingLocks(lockDir, key, runId, options = {}) {
  const wanted = lockKey(key);
  return listLiveLocks(lockDir, options).filter(({ key: held, lock }) => lock.runId !== runId
    && (wanted === HOST_DEVICES_KEY || held === wanted || held === HOST_DEVICES_KEY));
}

/**
 * @typedef {{ acquired: boolean, key: string | null, holder?: any, holderKey?: string, note?: string, error?: string, lock?: any, renewed?: boolean }} AcquireResult
 * @returns {AcquireResult}
 */
export function tryAcquireLock(lockDir, key, holder, options = {}) {
  if (!key) return { acquired: true, key: null, note: 'no key, skip' };
  if (!holder?.runId) return { acquired: false, key, error: 'runId 必填' };
  mkdirSync(lockDir, { recursive: true });
  const file = lockFile(lockDir, key);
  const now = new Date(options.now ?? Date.now()).toISOString();
  const existing = readLock(lockDir, key);
  if (existing?.runId === holder.runId) {
    if (holder.owner !== 'engine' && existing.owner === 'engine') {
      return { acquired: true, key, renewed: true, lock: existing };
    }
    const renewed = holder.owner === 'engine'
      ? { ...existing, owner: 'engine', pid: holder.pid ?? process.pid, heartbeatAt: now, stepName: holder.stepName || existing.stepName }
      : { ...existing, acquiredAt: now, stepName: holder.stepName || existing.stepName };
    writeFileSync(file, JSON.stringify(renewed, null, 2), 'utf-8');
    return { acquired: true, key, renewed: true, lock: renewed };
  }
  return createLock(lockDir, key, {
    runId: holder.runId,
    deviceId: String(key),
    acquiredAt: now,
    stepName: holder.stepName || '',
    pid: holder.pid ?? process.pid,
    owner: holder.owner || 'script',
    ...(holder.owner === 'engine' ? { heartbeatAt: now } : {}),
  }, options);
}

/**
 * 没有其他 run 挡住时独占创建锁文件；已失效的旧锁先删掉。
 * @returns {AcquireResult}
 */
function createLock(lockDir, key, lock, options) {
  const blockers = blockingLocks(lockDir, key, lock.runId, options);
  if (blockers.length) return { acquired: false, key, holder: blockers[0].lock, holderKey: blockers[0].key };
  const file = lockFile(lockDir, key);
  if (existsSync(file)) removeFile(file);
  try {
    writeFileSync(file, JSON.stringify(lock, null, 2), { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') return { acquired: false, key, holder: readLock(lockDir, key), note: 'lost race' };
    return { acquired: false, key, error: error?.message || String(error) };
  }
  // 两边同时各写一把互斥的锁时，各自让出，下一轮再抢。
  const late = blockingLocks(lockDir, key, lock.runId, options);
  if (late.length) {
    releaseLock(lockDir, key, lock.runId);
    return { acquired: false, key, holder: late[0].lock, holderKey: late[0].key, note: 'lost race' };
  }
  notifyLocal();
  return { acquired: true, key, lock };
}

export function heartbeatLock(lockDir, key, runId, options = {}) {
  const lock = readLock(lockDir, key);
  if (!lock || lock.runId !== runId) return false;
  const next = { ...lock, heartbeatAt: new Date(options.now ?? Date.now()).toISOString() };
  writeFileSync(lockFile(lockDir, key), JSON.stringify(next, null, 2), 'utf-8');
  return true;
}

export function releaseLock(lockDir, key, runId, options = {}) {
  const lock = readLock(lockDir, key);
  if (!lock) return { released: true, note: 'no lock' };
  if (lock.runId !== runId) return { released: false, reason: 'not holder', holder: lock };
  if (options.keepEngineLock && lock.owner === 'engine') {
    return { released: false, reason: 'engine lock is released by the engine when the step ends', holder: lock };
  }
  try {
    retryFs(() => unlinkSync(lockFile(lockDir, key)));
    notifyLocal();
    return { released: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { released: true, note: 'no lock' };
    return { released: false, error: error?.message || String(error) };
  }
}

export function cleanStaleLocks(lockDir, options = {}) {
  if (!existsSync(lockDir)) return 0;
  let cleaned = 0;
  const liveOptions = { lockDir, ...options };
  for (const name of readdirSync(lockDir)) {
    if (!name.endsWith('.lock')) continue;
    const key = name.slice(0, -'.lock'.length);
    if (isLockLive(readLock(lockDir, key), liveOptions)) continue;
    if (removeFile(lockFile(lockDir, key))) cleaned += 1;
  }
  for (const platform of PLATFORMS) liveTickets(lockDir, platform, liveOptions);
  const sessions = sessionDir(lockDir);
  if (existsSync(sessions)) {
    for (const name of readdirSync(sessions)) {
      if (!name.endsWith('.json')) continue;
      const session = readJson(join(sessions, name));
      if (!session || !isSessionLive(lockDir, session.runId, liveOptions)) removeFile(join(sessions, name));
    }
  }
  return cleaned;
}

/** 从 HAP 路径、工作目录等推断 run id（run-workspaces/<runId> 或 runs/<runId>）。 */
export function inferRunId(candidates) {
  for (const value of candidates) {
    const match = /(?:^|[\\/])(?:run-workspaces|runs)[\\/](run-[^\\/]+)/.exec(String(value || ''));
    if (match) return match[1];
  }
  return '';
}

// ---------------------------------------------------------------------------
// 文件操作：Windows 上被其他进程短暂打开的文件 rename/unlink 会报 EPERM/EBUSY，重试几次。

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
let tmpCounter = 0;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retryFs(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (!RETRY_CODES.has(error?.code) || attempt >= 9) throw error;
      sleepSync(20 * (attempt + 1));
    }
  }
}

function removeFile(file) {
  try { retryFs(() => unlinkSync(file)); return true; } catch { return false; }
}

function readJson(file) {
  try { return JSON.parse(retryFs(() => readFileSync(file, 'utf-8'))); } catch { return null; }
}

/** 先写临时文件再改名，读方不会读到写了一半的 JSON。 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  try {
    retryFs(() => renameSync(tmp, file));
  } catch (error) {
    removeFile(tmp);
    throw error;
  }
}

function isoAt(now) {
  return new Date(now ?? Date.now()).toISOString();
}

// ---------------------------------------------------------------------------
// 平台锁：host-ohos / host-android / host-ios

export function platformLockKey(platform) {
  return `host-${platform}`;
}

/** 'ohos,android' / ['HarmonyOS','adb'] → ['ohos','android']，去重保序，不认识的丢掉。 */
export function normalizePlatforms(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const platforms = [];
  for (const item of items) {
    const platform = PLATFORM_ALIASES[String(item).trim().toLowerCase()];
    if (platform && !platforms.includes(platform)) platforms.push(platform);
  }
  return platforms;
}

function queueDir(lockDir) { return join(lockDir, 'queue'); }
function sessionDir(lockDir) { return join(lockDir, 'sessions'); }
function mutexDir(lockDir, platform) { return join(lockDir, 'mutex', platform); }
function ticketFile(lockDir, platform, runId) { return join(queueDir(lockDir), `${platform}~${lockKey(runId)}.json`); }
function sessionFile(lockDir, runId) { return join(sessionDir(lockDir), `${lockKey(runId)}.json`); }

export function ensureLockDirs(lockDir) {
  mkdirSync(queueDir(lockDir), { recursive: true });
  mkdirSync(sessionDir(lockDir), { recursive: true });
  mkdirSync(join(lockDir, 'mutex'), { recursive: true });
}

const MUTEX_STALE_MS = 10 * 1000;

/** 同一平台的交接决定串行做：mkdir 在三个系统上都是原子的。拿不到返回 undefined。 */
function withPlatformMutex(lockDir, platform, fn) {
  const dir = mutexDir(lockDir, platform);
  mkdirSync(join(lockDir, 'mutex'), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(dir);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(dir).mtimeMs > MUTEX_STALE_MS) { rmdirSync(dir); continue; }
      } catch { /* 对方刚放掉 */ }
      if (attempt >= 300) return undefined;
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    try { retryFs(() => rmdirSync(dir)); } catch { /* 过期后由下一位清理 */ }
  }
}

// --- 设备会话 ---------------------------------------------------------------

export function startDeviceSession(lockDir, runId, info = {}, options = {}) {
  ensureLockDirs(lockDir);
  const now = isoAt(options.now);
  writeJsonAtomic(sessionFile(lockDir, runId), {
    runId, stepName: info.stepName || '', pid: info.pid ?? process.pid, startedAt: now, heartbeatAt: now,
  });
}

export function touchDeviceSession(lockDir, runId, options = {}) {
  const session = readJson(sessionFile(lockDir, runId));
  if (!session || session.runId !== runId) return false;
  writeJsonAtomic(sessionFile(lockDir, runId), { ...session, heartbeatAt: isoAt(options.now) });
  return true;
}

function readSession(lockDir, runId) {
  if (!runId) return null;
  const session = readJson(sessionFile(lockDir, runId));
  return session?.runId === runId ? session : null;
}

function sessionAlive(session, options) {
  const alive = options.pidAlive ?? pidAlive;
  return alive(session.pid) && (options.now ?? Date.now()) - timeOf(session.heartbeatAt) <= ENGINE_HEARTBEAT_STALE_MS;
}

/** 引擎进程还活着且心跳未超过 10 分钟；会话失效时该 run 的平台锁一起失效。 */
export function isSessionLive(lockDir, runId, options = {}) {
  const session = readSession(lockDir, runId);
  return Boolean(session && sessionAlive(session, options));
}

/**
 * 停止分析或步骤结束：放掉本 run 的平台锁、整机锁、单台设备锁，撤掉排队，删掉设备会话，
 * 再把空出来的平台锁按排队顺序交给下一位。
 */
export function releaseAllForRun(lockDir, runId, options = {}) {
  const releasedKeys = [];
  if (runId && existsSync(lockDir)) {
    for (const name of readdirSync(lockDir)) {
      if (!name.endsWith('.lock')) continue;
      const key = name.slice(0, -'.lock'.length);
      if (PLATFORMS.some((platform) => platformLockKey(platform) === key)) continue;
      const result = releaseLock(lockDir, key, runId);
      if (result.released && result.note !== 'no lock') releasedKeys.push(key);
    }
  }
  const sessionResult = endDeviceSession(lockDir, runId, options);
  return { releasedKeys, ...sessionResult };
}

/** 步骤结束：释放本 run 的全部平台锁、撤掉排队，并把空出来的锁交给下一位。 */
export function endDeviceSession(lockDir, runId, options = {}) {
  const released = [];
  for (const platform of PLATFORMS) {
    if (readLock(lockDir, platformLockKey(platform))?.runId !== runId) continue;
    const result = releaseOwnPlatformLock(lockDir, runId, platform);
    if (result.released && result.note !== 'no lock') released.push(platform);
  }
  for (const platform of PLATFORMS) removeFile(ticketFile(lockDir, platform, runId));
  removeFile(sessionFile(lockDir, runId));
  const handedTo = settleAllPlatforms(lockDir, options);
  return { released, handedTo };
}

// --- 排队票据 ---------------------------------------------------------------

function readTickets(lockDir, platform) {
  const dir = queueDir(lockDir);
  if (!existsSync(dir)) return [];
  const prefix = `${platform}~`;
  const tickets = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const ticket = readJson(join(dir, name));
    if (ticket?.runId && ticket.platform === platform) tickets.push({ ...ticket, file: join(dir, name) });
  }
  return tickets.sort((a, b) => (a.seq - b.seq) || String(a.runId).localeCompare(String(b.runId)));
}

/** runId → 正在持有的平台。 */
function platformHolders(lockDir, options) {
  const holders = new Map();
  for (const platform of PLATFORMS) {
    const lock = readLock(lockDir, platformLockKey(platform));
    if (lock && isLockLive(lock, { ...options, lockDir })) holders.set(lock.runId, platform);
  }
  return holders;
}

/** 有效票据按申请先后排好；本 run 正持有其他平台锁时票据暂停但保留位置。失效票据顺手删掉。 */
function liveTickets(lockDir, platform, options = {}, holders = platformHolders(lockDir, options)) {
  const now = options.now ?? Date.now();
  return readTickets(lockDir, platform).filter((ticket) => {
    if (holders.has(ticket.runId) || now - timeOf(ticket.touchedAt) <= TICKET_GRACE_MS) return true;
    removeFile(ticket.file);
    return false;
  });
}

function enqueueTicket(lockDir, platform, runId, info, options = {}) {
  const file = ticketFile(lockDir, platform, runId);
  const now = options.now ?? Date.now();
  const existing = readJson(file);
  const ticket = existing?.runId === runId
    ? { ...existing, pid: info.pid, stepName: info.stepName || existing.stepName, touchedAt: isoAt(now) }
    : { runId, platform, stepName: info.stepName || '', pid: info.pid, seq: now, enqueuedAt: isoAt(now), touchedAt: isoAt(now) };
  writeJsonAtomic(file, ticket);
  return ticket;
}

function touchTickets(lockDir, runId, platforms, options = {}) {
  for (const platform of platforms) {
    const file = ticketFile(lockDir, platform, runId);
    const ticket = readJson(file);
    if (ticket?.runId === runId) writeJsonAtomic(file, { ...ticket, touchedAt: isoAt(options.now) });
  }
}

export function cancelPlatformTickets(lockDir, runId, platforms = PLATFORMS) {
  let removed = 0;
  for (const platform of normalizePlatforms(platforms)) {
    if (removeFile(ticketFile(lockDir, platform, runId))) removed += 1;
  }
  if (removed) notifyLocal();
  return removed;
}

// --- 交接 -------------------------------------------------------------------

/** 锁空着时交给队里第一位没持有其他平台锁的 run（由释放方或任一等待方执行）。 */
export function settlePlatform(lockDir, platform, options = {}) {
  const key = platformLockKey(platform);
  const live = { ...options, lockDir };
  const current = readLock(lockDir, key);
  if (current && isLockLive(current, live)) return { holder: current };
  if (!readTickets(lockDir, platform).length) return { holder: null };
  const decided = withPlatformMutex(lockDir, platform, () => {
    const again = readLock(lockDir, key);
    if (again && isLockLive(again, live)) return { holder: again };
    const holders = platformHolders(lockDir, options);
    for (const ticket of liveTickets(lockDir, platform, options, holders)) {
      if (holders.has(ticket.runId)) continue;
      const result = createLock(lockDir, key, {
        runId: ticket.runId,
        deviceId: key,
        platform,
        acquiredAt: isoAt(options.now),
        claimedAt: null,
        queuedAt: ticket.enqueuedAt,
        stepName: ticket.stepName || '',
        pid: ticket.pid,
        owner: 'script',
      }, live);
      if (result.acquired) {
        removeFile(ticket.file);
        return { holder: result.lock, granted: ticket.runId };
      }
      if (result.error || result.note === 'lost race') return { holder: result.holder || null };
      // 被其他 run 的 host-devices 挡住：看下一位是不是 host-devices 的持有者。
    }
    return { holder: null };
  });
  return decided ?? { holder: readLock(lockDir, key) };
}

export function settleAllPlatforms(lockDir, options = {}) {
  const handedTo = {};
  for (const platform of PLATFORMS) {
    const result = settlePlatform(lockDir, platform, options);
    if (result.granted) handedTo[platform] = result.granted;
  }
  return handedTo;
}

/** 本 run 当前持有的平台锁。 */
export function heldPlatformLock(lockDir, runId, options = {}) {
  for (const platform of PLATFORMS) {
    const lock = readLock(lockDir, platformLockKey(platform));
    if (lock?.runId === runId && isLockLive(lock, { ...options, lockDir })) return { platform, lock };
  }
  return null;
}

function claimPlatformLock(lockDir, platform, runId, info, options = {}) {
  const key = platformLockKey(platform);
  return withPlatformMutex(lockDir, platform, () => {
    const lock = readLock(lockDir, key);
    if (!lock || lock.runId !== runId || !isLockLive(lock, { ...options, lockDir })) return null;
    const claimed = { ...lock, claimedAt: isoAt(options.now), pid: info.pid, stepName: info.stepName || lock.stepName };
    writeJsonAtomic(lockFile(lockDir, key), claimed);
    return claimed;
  }) ?? null;
}

function releaseOwnPlatformLock(lockDir, runId, platform) {
  const key = platformLockKey(platform);
  return withPlatformMutex(lockDir, platform, () => {
    const lock = readLock(lockDir, key);
    if (!lock) return { released: true, note: 'no lock' };
    if (lock.runId !== runId) return { released: false, reason: 'not holder', holder: lock };
    return releaseLock(lockDir, key, runId);
  }) ?? { released: false, error: `${key} 互斥区忙，稍后重试` };
}

/** 用完即放：释放后本 run 其他平台的排队重新计时，空出来的锁立刻交给下一位。 */
export function releasePlatformLock(lockDir, runId, platform, options = {}) {
  const [name] = normalizePlatforms([platform]);
  if (!name) return { released: false, error: `未知平台: ${platform}` };
  const result = releaseOwnPlatformLock(lockDir, runId, name);
  if (!result.released || result.note === 'no lock') return result;
  touchTickets(lockDir, runId, PLATFORMS.filter(p => p !== name), options);
  return { released: true, platform: name, handedTo: settleAllPlatforms(lockDir, options) };
}

function lockExpiresAt(lock, lockDir, options) {
  const ttl = options.scriptTtlMs ?? SCRIPT_LOCK_TTL_MS;
  if (lock.owner === 'engine') return timeOf(lock.heartbeatAt || lock.acquiredAt) + ENGINE_HEARTBEAT_STALE_MS;
  if (!lock.platform) return timeOf(lock.acquiredAt) + ttl;
  const session = readSession(lockDir, lock.runId);
  const sessionEnd = session ? timeOf(session.heartbeatAt) + ENGINE_HEARTBEAT_STALE_MS : Infinity;
  if (!lock.claimedAt) return Math.min(sessionEnd, timeOf(lock.acquiredAt) + CLAIM_GRACE_MS);
  return session ? sessionEnd : timeOf(lock.claimedAt) + ttl;
}

/** 挡住本 run 的锁和排在前面的票据里，最早失效的时间点；崩溃的持有者不会发事件，靠这个定时器接手。 */
function nextExpiry(lockDir, runId, platforms, options) {
  const now = options.now ?? Date.now();
  let next = Infinity;
  const holders = platformHolders(lockDir, options);
  for (const platform of platforms) {
    for (const { lock } of blockingLocks(lockDir, platformLockKey(platform), runId, options)) {
      next = Math.min(next, lockExpiresAt(lock, lockDir, options));
    }
    for (const ticket of liveTickets(lockDir, platform, options, holders)) {
      if (ticket.runId === runId) break;
      if (!holders.has(ticket.runId)) next = Math.min(next, timeOf(ticket.touchedAt) + TICKET_GRACE_MS);
    }
  }
  return next > now ? next : now + 1000;
}

export function platformQueueState(lockDir, options = {}, runId = '') {
  /** @type {Record<string, { holder: { runId: string, stepName: string, claimed: boolean } | null, queue: { runId: string, stepName: string, enqueuedAt: string, paused: boolean }[], position?: number }>} */
  const state = {};
  const holders = platformHolders(lockDir, options);
  for (const platform of PLATFORMS) {
    const lock = readLock(lockDir, platformLockKey(platform));
    const holder = lock && isLockLive(lock, { ...options, lockDir }) ? lock : null;
    const queue = liveTickets(lockDir, platform, options, holders).map(ticket => ({
      runId: ticket.runId, stepName: ticket.stepName, enqueuedAt: ticket.enqueuedAt, paused: holders.has(ticket.runId),
    }));
    const position = runId ? queue.findIndex(item => item.runId === runId) + 1 : 0;
    state[platform] = {
      holder: holder ? { runId: holder.runId, stepName: holder.stepName, claimed: Boolean(holder.claimedAt) } : null,
      queue,
      ...(runId ? { position } : {}),
    };
  }
  return state;
}

/**
 * 同进程的等待方直接唤醒。macOS 上同一进程反复增删 fs.watch 会重建 FSEvents 流，间隙里的事件可能丢；
 * 跨进程仍靠 fs.watch。
 */
const localWakers = new Set();

function notifyLocal() {
  for (const fire of localWakers) fire();
}

/** 监听锁目录和排队目录：锁被释放、交接、排队变化时立刻唤醒等待方。 */
function createWaker(lockDir, signal) {
  let wake = null;
  let dirty = false;
  const fire = () => {
    if (wake) { const resolve = wake; wake = null; resolve(); } else dirty = true;
  };
  localWakers.add(fire);
  const watchers = [];
  for (const [dir, suffix] of [[lockDir, '.lock'], [queueDir(lockDir), '.json']]) {
    try {
      const watcher = watch(dir, (_event, name) => { if (!name || String(name).endsWith(suffix)) fire(); });
      watcher.on('error', fire);
      watchers.push(watcher);
    } catch { /* 文件系统不支持监听时只靠定时复查 */ }
  }
  signal?.addEventListener('abort', fire, { once: true });
  return {
    watching: watchers.length === 2,
    wait(ms) {
      if (dirty) { dirty = false; return Promise.resolve(); }
      return new Promise((resolve) => {
        const timer = setTimeout(() => { wake = null; resolve(); }, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
        wake = () => { clearTimeout(timer); resolve(); };
      });
    },
    close() {
      localWakers.delete(fire);
      for (const watcher of watchers) { try { watcher.close(); } catch { /* ignore */ } }
      signal?.removeEventListener('abort', fire);
    },
  };
}

/**
 * 申请 platforms 里任意一把平台锁：有空闲立刻拿，都被占就在每个平台排队，谁先轮到就拿谁。
 * 返回 reason：
 *   - holding_other：本 run 已持有其他平台锁，先释放再申请（防互锁）
 *   - still_queued：本次调用等满 waitMs 仍在排队，排队位置保留，再调一次即可
 *   - timeout：从第一次排队起超过 totalWaitMs，撤掉排队，按降级处理
 *   - cancelled：排队被撤（步骤结束）；aborted：signal 中止
 */
export async function waitForPlatformLock(lockDir, request, options = {}) {
  const platforms = normalizePlatforms(request.platforms);
  const runId = String(request.runId || '');
  if (!runId) return { acquired: false, reason: 'invalid', error: 'runId 必填' };
  if (!platforms.length) return { acquired: false, reason: 'invalid', error: `平台必须是 ${PLATFORMS.join('/')}` };
  ensureLockDirs(lockDir);
  const live = { ...options, lockDir };
  const info = { stepName: request.stepName || '', pid: request.pid ?? process.pid };
  const started = Date.now();
  const callDeadline = started + (options.waitMs ?? 4 * 60 * 1000);
  const totalWaitMs = options.totalWaitMs ?? 180 * 60 * 1000;
  const waitedMs = () => Date.now() - started;

  const holding = heldPlatformLock(lockDir, runId, live);
  if (holding && !platforms.includes(holding.platform)) {
    return { acquired: false, reason: 'holding_other', holding: holding.platform, platforms };
  }
  if (!holding) {
    const holders = platformHolders(lockDir, options);
    for (const platform of platforms) {
      liveTickets(lockDir, platform, options, holders);
      enqueueTicket(lockDir, platform, runId, info, options);
    }
  }

  const waker = createWaker(lockDir, options.signal);
  const safetyMs = waker.watching ? (options.safetyMs ?? 60 * 1000) : (options.fallbackPollMs ?? 5 * 1000);
  let lastTouch = Date.now();
  try {
    for (;;) {
      if (options.signal?.aborted) return { acquired: false, reason: 'aborted', platforms, waitedMs: waitedMs() };
      for (const platform of platforms) settlePlatform(lockDir, platform, options);
      const got = heldPlatformLock(lockDir, runId, live);
      if (got) {
        if (!platforms.includes(got.platform)) return { acquired: false, reason: 'holding_other', holding: got.platform, platforms };
        const lock = claimPlatformLock(lockDir, got.platform, runId, info, options);
        if (lock) {
          return {
            acquired: true, platform: got.platform, key: platformLockKey(got.platform), lock,
            waitedMs: waitedMs(), remaining: platforms.filter(p => p !== got.platform),
          };
        }
        continue;
      }
      const mine = platforms.map(platform => readJson(ticketFile(lockDir, platform, runId))).filter(t => t?.runId === runId);
      if (!mine.length) return { acquired: false, reason: 'cancelled', platforms, waitedMs: waitedMs() };
      const now = Date.now();
      const firstQueuedAt = Math.min(...mine.map(ticket => timeOf(ticket.enqueuedAt)));
      if (now - firstQueuedAt >= totalWaitMs) {
        cancelPlatformTickets(lockDir, runId, platforms);
        return { acquired: false, reason: 'timeout', platforms, waitedMs: waitedMs(), queuedMs: now - firstQueuedAt, state: platformQueueState(lockDir, options, runId) };
      }
      if (now >= callDeadline) {
        touchTickets(lockDir, runId, platforms, options);
        return { acquired: false, reason: 'still_queued', platforms, waitedMs: waitedMs(), queuedMs: now - firstQueuedAt, state: platformQueueState(lockDir, options, runId) };
      }
      if (now - lastTouch >= TICKET_TOUCH_MS) {
        touchTickets(lockDir, runId, platforms, options);
        lastTouch = now;
      }
      const wakeAt = Math.min(
        callDeadline,
        firstQueuedAt + totalWaitMs,
        lastTouch + TICKET_TOUCH_MS,
        nextExpiry(lockDir, runId, platforms, options),
        now + safetyMs,
      );
      await waker.wait(wakeAt - now);
    }
  } finally {
    waker.close();
  }
}
