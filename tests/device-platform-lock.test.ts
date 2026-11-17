import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAIM_GRACE_MS,
  HOST_DEVICES_KEY,
  TICKET_GRACE_MS,
  heldPlatformLock,
  isLockLive,
  normalizePlatforms,
  platformQueueState,
  readLock,
  releaseAllForRun,
  releasePlatformLock,
  startDeviceSession,
  tryAcquireLock,
  waitForPlatformLock,
} from '../scripts/device-lock-core.mjs';
import { foreignDeviceLock } from '../scripts/ohos-har-install.mjs';
import { beginStepDeviceSession, deviceLockMode, deviceLockPromptNote } from '@/lib/workflow/device-lock';

const DEAD_PID = 2 ** 22 + 12345;
const CLI = resolve(process.cwd(), 'skills/cpf-ohos-issue-analysis/scripts/device-lock.mjs');
/** 兜底复查定得很长：等待方在这之前醒来，只能是被释放事件或到期定时器唤醒的。 */
const NO_POLL = { safetyMs: 120_000, totalWaitMs: 600_000, waitMs: 120_000 };

let root: string;
let lockDir: string;
let runsDir: string;
let savedAceHome: string | undefined;

function opts(extra: Record<string, unknown> = {}) {
  return { runsDir, ...NO_POLL, ...extra };
}

function acquire(runId: string, platforms: string[], extra: Record<string, unknown> = {}) {
  return waitForPlatformLock(lockDir, { runId, platforms, stepName: '问题复现' }, opts(extra));
}

function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>(r => setTimeout(() => r('pending'), ms))]);
}

function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'platform-lock-'));
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

describe('平台锁基础', () => {
  it('平台名归一化，去重保序', () => {
    expect(normalizePlatforms('HarmonyOS, adb ios ohos')).toEqual(['ohos', 'android', 'ios']);
    expect(normalizePlatforms(['windows', 'Android'])).toEqual(['android']);
  });

  it('空闲时立刻拿到并认领，同 run 再申请同平台是续租', async () => {
    const first = await acquire('run-a', ['ohos']);
    expect(first).toMatchObject({ acquired: true, platform: 'ohos', key: 'host-ohos' });
    expect(readLock(lockDir, 'host-ohos')).toMatchObject({ runId: 'run-a', platform: 'ohos', claimedAt: expect.any(String) });
    expect((await acquire('run-a', ['ohos', 'android'])).platform).toBe('ohos');
  });

  it('持有一把平台锁时不能再申请别的平台（防互锁）', async () => {
    await acquire('run-a', ['ohos']);
    const result = await acquire('run-a', ['android']);
    expect(result).toMatchObject({ acquired: false, reason: 'holding_other', holding: 'ohos' });
    expect(readdirSync(join(lockDir, 'queue')).filter(n => n.endsWith('.json'))).toEqual([]);
  });

  it('其他 run 的 host-devices 挡住所有平台，本 run 的 host-devices 不挡', async () => {
    tryAcquireLock(lockDir, HOST_DEVICES_KEY, { runId: 'run-a', stepName: 'h', owner: 'engine' }, { runsDir });
    expect((await acquire('run-a', ['android'])).acquired).toBe(true);
    const blocked = await acquire('run-b', ['ohos'], { waitMs: 50 });
    expect(blocked.reason).toBe('still_queued');
    // 平台锁存在时，其他 run 也拿不到 host-devices
    expect(tryAcquireLock(lockDir, HOST_DEVICES_KEY, { runId: 'run-c', stepName: 'h', owner: 'engine' }, { runsDir }).acquired).toBe(false);
  });
});

describe('排队与触发式交接', () => {
  it('按申请先后交接，释放时立刻唤醒队头，不靠轮询', async () => {
    await acquire('run-a', ['ohos']);
    const order: string[] = [];
    const b = acquire('run-b', ['ohos']).then(r => { order.push('run-b'); return r; });
    await new Promise(r => setTimeout(r, 30));
    const c = acquire('run-c', ['ohos']).then(r => { order.push('run-c'); return r; });
    await new Promise(r => setTimeout(r, 30));
    expect(platformQueueState(lockDir, { runsDir }).ohos.queue.map(q => q.runId)).toEqual(['run-b', 'run-c']);

    const started = Date.now();
    expect(releasePlatformLock(lockDir, 'run-a', 'ohos', { runsDir })).toMatchObject({ released: true, handedTo: { ohos: 'run-b' } });
    const gotB = await settledWithin(b, 5000);
    expect(gotB).toMatchObject({ acquired: true, platform: 'ohos' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await settledWithin(c, 200)).toBe('pending');

    releasePlatformLock(lockDir, 'run-b', 'ohos', { runsDir });
    expect(await settledWithin(c, 5000)).toMatchObject({ acquired: true, platform: 'ohos' });
    expect(order).toEqual(['run-b', 'run-c']);
  });

  it('多平台申请时哪个先空拿哪个，另一个平台的排队位置保留', async () => {
    await acquire('run-a', ['ohos']);
    const b = await acquire('run-b', ['ohos', 'android']);
    expect(b).toMatchObject({ acquired: true, platform: 'android', remaining: ['ohos'] });
    const state = platformQueueState(lockDir, { runsDir }, 'run-b');
    expect(state.ohos).toMatchObject({ holder: { runId: 'run-a' }, position: 1, queue: [{ runId: 'run-b', paused: true }] });
  });

  it('两个 run 清单都是 ohos+android：并行各做一个，做完交换，不互锁', async () => {
    const a1 = await acquire('run-a', ['ohos', 'android']);
    const b1 = await acquire('run-b', ['ohos', 'android']);
    expect([a1.platform, b1.platform]).toEqual(['ohos', 'android']);

    // A 鸿蒙做完：B 还持有 android，B 的 ohos 排队暂停，ohos 先空着
    releasePlatformLock(lockDir, 'run-a', 'ohos', { runsDir });
    const a2 = acquire('run-a', ['android']);
    expect(await settledWithin(a2, 200)).toBe('pending');

    // B 安卓做完：android 交给 A，ohos 交给 B
    expect(releasePlatformLock(lockDir, 'run-b', 'android', { runsDir }).handedTo).toEqual({ ohos: 'run-b', android: 'run-a' });
    expect(await settledWithin(a2, 5000)).toMatchObject({ acquired: true, platform: 'android' });
    expect(await acquire('run-b', ['ohos'])).toMatchObject({ acquired: true, platform: 'ohos' });
  });

  it('单次等待到点返回 still_queued，再调用时排队位置不变', async () => {
    await acquire('run-a', ['ohos']);
    expect((await acquire('run-b', ['ohos'], { waitMs: 50 })).reason).toBe('still_queued');
    const c = acquire('run-c', ['ohos']);
    await new Promise(r => setTimeout(r, 30));
    const b = acquire('run-b', ['ohos']);
    await new Promise(r => setTimeout(r, 30));
    releasePlatformLock(lockDir, 'run-a', 'ohos', { runsDir });
    expect(await settledWithin(b, 5000)).toMatchObject({ acquired: true });
    expect(await settledWithin(c, 200)).toBe('pending');
    releasePlatformLock(lockDir, 'run-b', 'ohos', { runsDir });
    expect(await settledWithin(c, 5000)).toMatchObject({ acquired: true });
  });

  it('总等待超时撤掉排队', async () => {
    await acquire('run-a', ['ohos']);
    const result = await acquire('run-b', ['ohos'], { totalWaitMs: 50 });
    expect(result.reason).toBe('timeout');
    expect(platformQueueState(lockDir, { runsDir }).ohos.queue).toEqual([]);
  });

  it('中止信号让等待立刻返回', async () => {
    await acquire('run-a', ['ohos']);
    const controller = new AbortController();
    const pending = acquire('run-b', ['ohos'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect(await settledWithin(pending, 5000)).toMatchObject({ acquired: false, reason: 'aborted' });
  });
});

describe('崩溃与过期', () => {
  it('失效的排队票据被跳过', async () => {
    const old = new Date(Date.now() - TICKET_GRACE_MS - 1000).toISOString();
    writeJson(join(lockDir, 'queue', 'ohos~run-x.json'), { runId: 'run-x', platform: 'ohos', seq: 1, enqueuedAt: old, touchedAt: old, pid: DEAD_PID });
    expect(await acquire('run-b', ['ohos'])).toMatchObject({ acquired: true });
  });

  it('交接后没人认领的锁到期后，由定时器唤醒下一位接手', async () => {
    const almost = new Date(Date.now() - CLAIM_GRACE_MS + 400).toISOString();
    writeJson(join(lockDir, 'host-ohos.lock'), { runId: 'run-x', platform: 'ohos', deviceId: 'host-ohos', owner: 'script', acquiredAt: almost, claimedAt: null, pid: DEAD_PID });
    const started = Date.now();
    expect(await settledWithin(acquire('run-b', ['ohos']), 5000)).toMatchObject({ acquired: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it('设备会话的引擎进程不在了，该 run 的平台锁立刻失效', () => {
    const now = new Date().toISOString();
    writeJson(join(lockDir, 'sessions', 'run-x.json'), { runId: 'run-x', pid: DEAD_PID, heartbeatAt: now });
    const lock = { runId: 'run-x', platform: 'ohos', owner: 'script', acquiredAt: now, claimedAt: now };
    expect(isLockLive(lock, { lockDir, runsDir })).toBe(false);
    startDeviceSession(lockDir, 'run-x', { pid: process.pid });
    expect(isLockLive(lock, { lockDir, runsDir })).toBe(true);
  });
});

describe('引擎设备会话', () => {
  it('步骤结束释放本 run 的锁和排队，并把锁交给下一位', async () => {
    const session = beginStepDeviceSession({ runId: 'run-a', stepName: '问题复现/问题复现' });
    expect(deviceLockMode({})).toBe('platform');
    expect(deviceLockMode({ ACE_DEVICE_LOCK_MODE: 'host' })).toBe('host');
    expect((await acquire('run-a', ['ohos', 'android'])).platform).toBe('ohos');
    await acquire('run-c', ['android']);
    const b = acquire('run-b', ['ohos']);
    await new Promise(r => setTimeout(r, 30));

    session.release();
    expect(await settledWithin(b, 5000)).toMatchObject({ acquired: true, platform: 'ohos' });
    expect(heldPlatformLock(lockDir, 'run-a', { runsDir })).toBeNull();
    expect(platformQueueState(lockDir, { runsDir }).android.queue).toEqual([]);
    expect(existsSync(join(lockDir, 'sessions', 'run-a.json'))).toBe(false);
  });

  it('提示词给出可直接执行的命令（含 runId，路径用正斜杠）', () => {
    const note = deviceLockPromptNote({ mode: 'platform', acquired: true, waitedMs: 0, holder: null, runId: 'run-a', stepName: '问题复现/问题复现' });
    expect(note).toContain('acquire --platforms ohos,android --run run-a --step "问题复现/问题复现"');
    expect(note).toContain('release --platform <平台> --run run-a');
    expect(note).not.toMatch(/\\/);
  });

  it('安装脚本：其他 run 持有 host-ohos 时拒绝；本 run 在设备步骤里没拿锁时拒绝；拿到后放行', async () => {
    const hap = (runId: string) => join(root, 'run-workspaces', runId, 'demo.hap');
    await acquire('run-a', ['ohos']);
    expect((await foreignDeviceLock({ hap: hap('run-b') }, root)).holder?.runId).toBe('run-a');
    expect(await foreignDeviceLock({ hap: hap('run-a') }, root)).toMatchObject({ holder: null, missingOwn: false });

    releasePlatformLock(lockDir, 'run-a', 'ohos', { runsDir });
    startDeviceSession(lockDir, 'run-b', { pid: process.pid });
    await acquire('run-c', ['android']);
    expect(await foreignDeviceLock({ hap: hap('run-b') }, root)).toMatchObject({ holder: null, missingOwn: true });
    await acquire('run-b', ['ohos']);
    expect(await foreignDeviceLock({ hap: hap('run-b') }, root)).toMatchObject({ holder: null, missingOwn: false });
  });
});

describe('停止分析时放锁', () => {
  it('release --all 放掉本 run 的平台锁、排队、会话、整机锁和单设备锁，并交给下一位', async () => {
    startDeviceSession(lockDir, 'run-a', { stepName: '问题复现', pid: process.pid });
    await acquire('run-a', ['ohos', 'android']);
    const waiting = acquire('run-b', ['ohos']);
    await new Promise(r => setTimeout(r, 30));
    expect(platformQueueState(lockDir, { runsDir }).ohos.queue.map(q => q.runId)).toEqual(['run-b']);
    tryAcquireLock(lockDir, 'SERIAL-A', { runId: 'run-a', stepName: '问题复现', owner: 'script' }, { runsDir });
    tryAcquireLock(lockDir, HOST_DEVICES_KEY, { runId: 'run-a', stepName: '问题复现', owner: 'engine', pid: process.pid }, { runsDir });

    const released = releaseAllForRun(lockDir, 'run-a', { runsDir });
    expect(released.releasedKeys).toEqual(expect.arrayContaining([HOST_DEVICES_KEY, 'SERIAL-A']));
    expect(released.released).toContain('ohos');
    expect(released.handedTo).toMatchObject({ ohos: 'run-b' });
    expect(existsSync(join(lockDir, 'sessions', 'run-a.json'))).toBe(false);
    expect(readLock(lockDir, 'SERIAL-A')).toBeNull();
    expect(readLock(lockDir, HOST_DEVICES_KEY)).toBeNull();
    expect(readLock(lockDir, 'host-ohos')?.runId).toBe('run-b');
    expect(platformQueueState(lockDir, { runsDir }, 'run-a').android.queue).toEqual([]);

    const got = await settledWithin(waiting, 5000);
    expect(got).toMatchObject({ acquired: true, platform: 'ohos' });

    const cli = await new Promise<{ code: number | null; body: any }>((done) => {
      const child = spawn(process.execPath, [CLI, 'release', '--all', '--run', 'run-b'], {
        env: { ...process.env, ACE_HOME: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (code) => {
        let body = null;
        try { body = JSON.parse(stdout.trim().split('\n').pop() || ''); } catch { body = { raw: stdout }; }
        done({ code, body });
      });
    });
    expect(cli.code).toBe(0);
    expect(cli.body).toMatchObject({ released: true, platforms: ['ohos'] });
    expect(readLock(lockDir, 'host-ohos')).toBeNull();
    expect(existsSync(join(lockDir, 'sessions', 'run-b.json'))).toBe(false);
  });
});

describe('并发压力', () => {
  it('6 个 run 随机顺序抢两把锁，都能做完且同一平台不会同时被两个 run 持有', async () => {
    const holding = new Map<string, string>();
    let overlap = false;
    const worker = async (runId: string, platforms: string[]) => {
      const remaining = [...platforms];
      while (remaining.length) {
        const got = await acquire(runId, remaining);
        expect(got.acquired).toBe(true);
        const platform = got.platform!;
        if (holding.has(platform)) overlap = true;
        holding.set(platform, runId);
        await new Promise(r => setTimeout(r, 5 + Math.random() * 20));
        holding.delete(platform);
        releasePlatformLock(lockDir, runId, platform, { runsDir });
        remaining.splice(remaining.indexOf(platform), 1);
      }
    };
    const runs = Array.from({ length: 6 }, (_, i) => worker(`run-${i}`, i % 2 ? ['ohos', 'android'] : ['android', 'ohos']));
    expect(await settledWithin(Promise.all(runs), 20_000)).not.toBe('pending');
    expect(overlap).toBe(false);
    expect(platformQueueState(lockDir, { runsDir }).ohos).toMatchObject({ holder: null, queue: [] });
  }, 30_000);

  it('4 个进程抢两把锁：都做完，同一平台的持锁时间段互不重叠', async () => {
    const coreUrl = pathToFileURL(resolve(process.cwd(), 'scripts/device-lock-core.mjs')).href;
    const code = `
      import { waitForPlatformLock, releasePlatformLock } from ${JSON.stringify(coreUrl)};
      const [lockDir, runsDir, runId, ...platforms] = process.argv.slice(1);
      const remaining = [...platforms];
      while (remaining.length) {
        const got = await waitForPlatformLock(lockDir, { runId, platforms: remaining }, { runsDir, safetyMs: 120000, waitMs: 120000 });
        if (!got.acquired) { console.log(JSON.stringify({ error: got })); process.exit(1); }
        const start = Date.now();
        await new Promise(r => setTimeout(r, 20 + Math.random() * 40));
        const end = Date.now();
        releasePlatformLock(lockDir, runId, got.platform, { runsDir });
        console.log(JSON.stringify({ platform: got.platform, start, end }));
        remaining.splice(remaining.indexOf(got.platform), 1);
      }
    `;
    const runWorker = (runId: string, platforms: string[]) => new Promise<{ code: number | null; spans: any[] }>((done) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, lockDir, runsDir, runId, ...platforms], { stdio: ['ignore', 'pipe', 'inherit'] });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('close', exitCode => done({ code: exitCode, spans: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }));
    });
    const results = await settledWithin(Promise.all([
      runWorker('run-p0', ['ohos', 'android']),
      runWorker('run-p1', ['android', 'ohos']),
      runWorker('run-p2', ['ohos', 'android']),
      runWorker('run-p3', ['android', 'ohos']),
    ]), 40_000);
    expect(results).not.toBe('pending');
    const finished = results as { code: number | null; spans: any[] }[];
    expect(finished.map(r => r.code)).toEqual([0, 0, 0, 0]);
    for (const platform of ['ohos', 'android']) {
      const spans = finished.flatMap(r => r.spans).filter(s => s.platform === platform).sort((a, b) => a.start - b.start);
      expect(spans).toHaveLength(4);
      for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
  }, 60_000);
});

describe('跨进程（device-lock.mjs 命令行）', () => {
  function cli(args: string[]) {
    return new Promise<{ code: number | null; json: any; ms: number }>((resolveRun) => {
      const started = Date.now();
      const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ACE_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('close', (code) => {
        let json: any = null;
        try { json = JSON.parse(stdout.trim().split('\n').pop() || 'null'); } catch { /* 保留 null */ }
        resolveRun({ code, json, ms: Date.now() - started });
      });
    });
  }

  it('另一个进程释放后，排队进程被唤醒拿到锁；退出码 0/4/5 对得上', async () => {
    expect(await cli(['acquire', '--platforms', 'ohos', '--run', 'run-a', '--step', '问题复现'])).toMatchObject({ code: 0, json: { platform: 'ohos' } });
    expect((await cli(['acquire', '--platforms', 'android', '--run', 'run-a'])).code).toBe(5);
    expect((await cli(['acquire', '--platforms', 'ohos', '--run', 'run-c', '--wait', '1'])).code).toBe(4);

    const waiting = cli(['acquire', '--platforms', 'ohos', '--run', 'run-b', '--wait', '4']);
    await new Promise(r => setTimeout(r, 800));
    expect((await cli(['release', '--platform', 'ohos', '--run', 'run-a'])).code).toBe(0);
    // run-c 先排的队，它的进程已退出但票据还在宽限期内：锁留给 run-c，run-b 继续排队
    expect(readLock(lockDir, 'host-ohos')).toMatchObject({ runId: 'run-c', claimedAt: null });
    expect((await waiting).code).toBe(4);
    expect(await cli(['acquire', '--platforms', 'ohos', '--run', 'run-c'])).toMatchObject({ code: 0, json: { platform: 'ohos' } });
  }, 90_000);

  it('排队进程在释放后几秒内被唤醒（兜底复查是 60 秒）', async () => {
    expect((await cli(['acquire', '--platforms', 'ohos', '--run', 'run-a'])).code).toBe(0);
    const waiting = cli(['acquire', '--platforms', 'ohos', '--run', 'run-b', '--wait', '60']);
    await new Promise(r => setTimeout(r, 800));
    const released = Date.now();
    await cli(['release', '--platform', 'ohos', '--run', 'run-a']);
    const result = await waiting;
    expect(result).toMatchObject({ code: 0, json: { acquired: true, platform: 'ohos' } });
    expect(Date.now() - released).toBeLessThan(10_000);
    expect((await cli(['status', '--run', 'run-b'])).json.platforms.ohos.holder.runId).toBe('run-b');
    expect((await cli(['release', '--all', '--run', 'run-b'])).json).toMatchObject({ released: true, platforms: ['ohos'] });
  }, 90_000);
});
