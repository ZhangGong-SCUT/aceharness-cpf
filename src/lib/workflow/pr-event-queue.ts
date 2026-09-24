import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type Job = { key: string; revision: string; payload: unknown; receivedAt: number; dueAt: number; attempts: number };
type Result = { status: number; reason: string; started?: boolean; woken?: boolean; runId?: string };
type Receipt = { key: string; fingerprint: string; finishedAt: number; delayMs: number; status: number };

/** Atomic disk queue, latest snapshot per PR. Dispatch and disk writes are serialized separately. */
export class PrEventQueue {
  private jobs = new Map<string, Job>();
  private receipts: Receipt[] = [];
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
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    this.loaded = true;
  }
  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, jobs: [...this.jobs.values()], receipts: this.receipts }), { mode: 0o600 });
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
          if (this.jobs.get(job.key)?.revision !== job.revision) return;
          const receiptsBefore = [...this.receipts];
          if (result.status === 409 || result.status === 429 || result.status >= 500) {
            const attempts = job.attempts + 1;
            this.jobs.set(job.key, { ...job, attempts,
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
      const failed = recent.filter(r => r.status >= 400).length;
      return {
        pending: jobs.length, retrying: jobs.filter(j => j.attempts > 0).length,
        oldestWaitMs: jobs.length ? now - Math.min(...jobs.map(j => j.receivedAt)) : 0,
        recentDispatchMs: this.receipts.slice(-20).map(r => r.delayMs),
        samples24h: recent.length,
        p50ms: percentile(0.5), p95ms: percentile(0.95),
        failureRate24h: recent.length ? Number((failed / recent.length).toFixed(4)) : 0,
        prs: this.prHealth(jobs, now),
      };
    });
  }

  /** Per-PR (per queue key) health: whether still queued, next attempt, most recent result. */
  private prHealth(jobs: Job[], now: number) {
    const empty = () => ({ pending: 0, retrying: 0, attempts: 0, oldestReceivedAt: null as number | null,
      nextDueAt: null as number | null, lastStatus: null as number | null, lastError: null as string | null,
      lastSuccessAt: null as number | null, lastFinishedAt: null as number | null, lastDelayMs: null as number | null });
    const prs: Record<string, ReturnType<typeof empty>> = {};
    for (const job of jobs) {
      const item = prs[job.key] ||= empty();
      item.pending += 1;
      item.attempts = Math.max(item.attempts, job.attempts);
      if (job.attempts > 0) item.retrying += 1;
      item.oldestReceivedAt = item.oldestReceivedAt === null ? job.receivedAt : Math.min(item.oldestReceivedAt, job.receivedAt);
      item.nextDueAt = item.nextDueAt === null ? job.dueAt : Math.min(item.nextDueAt, job.dueAt);
    }
    for (const r of this.receipts.slice(-500)) {
      const item = prs[r.key] ||= empty();
      item.lastStatus = r.status;
      item.lastDelayMs = r.delayMs;
      item.lastFinishedAt = r.finishedAt;
      if (r.status < 400) item.lastSuccessAt = Math.max(item.lastSuccessAt || 0, r.finishedAt);
      else item.lastError = `HTTP ${r.status}`;
    }
    return prs;
  }
}
