import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type Job = { key: string; revision: string; payload: unknown; receivedAt: number; dueAt: number; attempts: number;
  lastStatus?: number; lastError?: string; lastAttemptAt?: number };
type Result = { status: number; reason: string; started?: boolean; woken?: boolean; runId?: string };
type Receipt = { key: string; fingerprint: string; finishedAt: number; delayMs: number; status: number };
type Attempt = { key: string; at: number; status: number; reason: string };

/** Atomic disk queue, latest snapshot per PR. Dispatch and disk writes are serialized separately. */
export class PrEventQueue {
  private jobs = new Map<string, Job>();
  private receipts: Receipt[] = [];
  private attempts: Attempt[] = [];
  private attemptsCapped = false;
  private loaded = false;
  private lock: Promise<unknown> = Promise.resolve();
  private draining = false;
  constructor(private file: string, private dispatch: (payload: unknown) => Promise<Result>, private now = Date.now) {}

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }
  private async load() {
    if (this.loaded) return;
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.jobs)) throw new Error('PR 事件队列格式错误');
      this.jobs = new Map(data.jobs.map((job: Job) => [job.key, job]));
      this.receipts = data.receipts || [];
      this.attempts = data.attempts || [];
      this.attemptsCapped = !!data.attemptsCapped;
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    this.loaded = true;
  }
  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, jobs: [...this.jobs.values()], receipts: this.receipts,
      attempts: this.attempts, attemptsCapped: this.attemptsCapped }), { mode: 0o600 });
    await rename(temp, this.file);
  }
  private fingerprint(payload: unknown) { return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }

  async enqueue(key: string, payload: unknown) {
    return this.exclusive(async () => {
      await this.load();
      const now = this.now();
      const fingerprint = this.fingerprint(payload);
      const old = this.jobs.get(key);
      if (old && this.fingerprint(old.payload) === fingerprint) return { queued: true, duplicate: true };
      if (!old && this.receipts.some(r => r.key === key && r.fingerprint === fingerprint && now - r.finishedAt < 30000)) {
        return { queued: false, duplicate: true };
      }
      if (!old && this.jobs.size >= 2048) throw new Error('PR 事件队列已满，请稍后重试');
      this.jobs.set(key, { key, revision: randomUUID(), payload, receivedAt: old?.receivedAt ?? now,
        dueAt: old ? Math.min(old.dueAt, now + 1000) : now + 1000, attempts: 0 });
      try { await this.save(); } catch (error) {
        if (old) this.jobs.set(key, old); else this.jobs.delete(key);
        throw error;
      }
      return { queued: true, duplicate: false };
    });
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.exclusive(async () => this.load());
      // A slow API for one PR must not block unrelated PR notifications.
      const batch = [...this.jobs.values()].filter(j => j.dueAt <= this.now()).slice(0, 3);
      await Promise.all(batch.map(async job => {
        let result: Result;
        try { result = await this.dispatch(job.payload); }
        catch { result = { status: 503, reason: '事件处理暂时失败' }; }
        await this.exclusive(async () => {
          const receiptsBefore = [...this.receipts];
          const attemptsBefore = this.attempts;
          const cappedBefore = this.attemptsCapped;
          this.attempts = this.attempts.filter(a => this.now() - a.at < 86400000);
          this.attempts.push({ key: job.key, at: this.now(), status: result.status, reason: result.reason });
          if (this.attempts.length > 10000) { this.attempts = this.attempts.slice(-10000); this.attemptsCapped = true; }
          // A newer PR snapshot may arrive during dispatch. Keep its job while recording this attempt.
          if (this.jobs.get(job.key)?.revision !== job.revision) {
            try { await this.save(); } catch (error) { this.attempts = attemptsBefore; this.attemptsCapped = cappedBefore; throw error; }
            return;
          }
          if (result.status === 409 || result.status === 429 || result.status >= 500) {
            const attempts = job.attempts + 1;
            this.jobs.set(job.key, { ...job, attempts, lastStatus: result.status,
              lastError: result.reason || `HTTP ${result.status}`, lastAttemptAt: this.now(),
              dueAt: this.now() + (result.status === 409 ? 5000 : Math.min(60000, 2000 * 2 ** Math.min(attempts, 5))) });
          } else {
            this.jobs.delete(job.key);
            this.receipts.push({ key: job.key, fingerprint: this.fingerprint(job.payload), finishedAt: this.now(),
              delayMs: this.now() - job.receivedAt, status: result.status });
            this.receipts = this.receipts.filter(r => this.now() - r.finishedAt < 86400000).slice(-2048);
          }
          try { await this.save(); } catch (error) {
            this.jobs.set(job.key, job);
            this.receipts = receiptsBefore;
            this.attempts = attemptsBefore;
            this.attemptsCapped = cappedBefore;
            throw error;
          }
        });
      }));
    } finally { this.draining = false; }
  }

  async status() {
    return this.exclusive(async () => {
      await this.load();
      const now = this.now();
      const jobs = [...this.jobs.values()];
      const recent = this.receipts.filter(r => now - r.finishedAt < 86400000);
      const delays = recent.map(r => r.delayMs).sort((a, b) => a - b);
      const percentile = (p: number) => delays.length ? delays[Math.min(delays.length - 1, Math.floor(p * (delays.length - 1)))] : 0;
      const attempts = this.attempts.filter(a => now - a.at < 86400000);
      const busy = attempts.filter(a => a.status === 409).length;
      const failures = attempts.filter(a => a.status >= 400 && a.status !== 409).length;
      const retryAttempts = attempts.filter(a => a.status === 429 || a.status >= 500).length;
      const outcomes = attempts.length - busy;
      return {
        pending: jobs.length, retrying: jobs.filter(j => j.attempts > 0).length,
        oldestWaitMs: jobs.length ? now - Math.min(...jobs.map(j => j.receivedAt)) : 0,
        recentDispatchMs: this.receipts.slice(-20).map(r => r.delayMs),
        samples24h: recent.length,
        retryAttempts24h: retryAttempts,
        attempts24h: attempts.length, capacityWaits24h: busy,
        p50ms: percentile(0.5), p95ms: percentile(0.95),
        failureRate24h: outcomes ? Number((failures / outcomes).toFixed(4)) : 0,
        sampleWindowCapped: this.attemptsCapped || this.receipts.length >= 2048,
        prs: this.prHealth(jobs, now),
      };
    });
  }

  /** Per-PR (per queue key) health: whether still queued, next attempt, most recent result. */
  private prHealth(jobs: Job[], now: number) {
    const empty = () => ({ pending: 0, retrying: 0, attempts: 0, oldestReceivedAt: null as number | null,
      nextDueAt: null as number | null, lastStatus: null as number | null, lastError: null as string | null,
      lastSuccessAt: null as number | null, lastFinishedAt: null as number | null, lastDelayMs: null as number | null,
      lastAttemptAt: null as number | null });
    const prs: Record<string, ReturnType<typeof empty>> = {};
    // 先铺已完成的结果（按时间先后，成功会清除历史错误）
    for (const r of this.receipts.filter(r => now - r.finishedAt < 86400000)) {
      const item = prs[r.key] ||= empty();
      item.lastStatus = r.status;
      item.lastDelayMs = r.delayMs;
      item.lastFinishedAt = r.finishedAt;
      if (r.status < 400) {
        item.lastSuccessAt = Math.max(item.lastSuccessAt || 0, r.finishedAt);
        item.lastError = null;
      } else {
        item.lastError = `HTTP ${r.status}`;
      }
    }
    for (const attempt of this.attempts.filter(a => now - a.at < 86400000)) {
      const item = prs[attempt.key] ||= empty();
      item.lastAttemptAt = attempt.at;
      item.lastStatus = attempt.status;
      item.lastError = attempt.status >= 400 ? attempt.reason || `HTTP ${attempt.status}` : null;
      if (attempt.status < 400) item.lastSuccessAt = attempt.at;
    }
    // 仍在队列中的 job 覆盖为当前最新尝试（重试失败也可见）
    for (const job of jobs) {
      const item = prs[job.key] ||= empty();
      item.pending += 1;
      item.attempts = Math.max(item.attempts, job.attempts);
      if (job.attempts > 0) item.retrying += 1;
      item.oldestReceivedAt = item.oldestReceivedAt === null ? job.receivedAt : Math.min(item.oldestReceivedAt, job.receivedAt);
      item.nextDueAt = item.nextDueAt === null ? job.dueAt : Math.min(item.nextDueAt, job.dueAt);
      if (job.lastAttemptAt && now - job.lastAttemptAt < 86400000 && job.lastAttemptAt >= (item.lastAttemptAt || item.lastFinishedAt || 0)) {
        if (job.lastStatus !== undefined) item.lastStatus = job.lastStatus;
        if (job.lastError) item.lastError = job.lastError;
        item.lastAttemptAt = job.lastAttemptAt;
      }
    }
    return prs;
  }
}
