/**
 * R06：按任务类型调度 + 公平排队（admission control）
 *
 * 目标（验收）：
 *   - 轻量读取 / AI 推理 / 构建 / 外部写分别限流；
 *   - 同一 PR 串行（同一 PR 同时最多一个在跑），不同 PR 并发；
 *   - 公平：某个忙 PR 的等待者不会挡住其他 PR；
 *   - 等待 CI / 人工确认的 run 不占计算名额（由调用方在进入调度前过滤）。
 *
 * 该调度器只做"准入"（acquire/release），不负责启动工作流本身，便于单测与复用。
 */

export type PrTaskClass = 'read' | 'ai' | 'build' | 'write';

export type PrTaskClassLimits = Record<PrTaskClass, number>;

export const DEFAULT_CLASS_LIMITS: PrTaskClassLimits = { read: 6, ai: 3, build: 2, write: 2 };

const ENV_KEYS: Record<PrTaskClass, string> = {
  read: 'ACE_SCHED_READ_MAX',
  ai: 'ACE_SCHED_AI_MAX',
  build: 'ACE_SCHED_BUILD_MAX',
  write: 'ACE_SCHED_WRITE_MAX',
};

export function resolveClassLimits(env: NodeJS.ProcessEnv = process.env): PrTaskClassLimits {
  const out = { ...DEFAULT_CLASS_LIMITS };
  for (const klass of Object.keys(DEFAULT_CLASS_LIMITS) as PrTaskClass[]) {
    const raw = Number(env[ENV_KEYS[klass]] || 0);
    if (Number.isFinite(raw) && raw >= 1) out[klass] = Math.floor(raw);
  }
  return out;
}

export interface SchedulerStatus {
  running: number;
  waiting: number;
  runningByClass: Record<PrTaskClass, number>;
  waitingByClass: Record<PrTaskClass, number>;
  runningByPr: Record<string, number>;
  oldestWaitMs: number;
}

type Waiter = {
  pr: string;
  klass: PrTaskClass;
  enqueuedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  grant: () => void;
  reject: (error: Error) => void;
};

export class PrTaskScheduler {
  private limits: PrTaskClassLimits;
  private running: Array<{ pr: string; klass: PrTaskClass; at: number }> = [];
  private waiters: Waiter[] = [];
  private now: () => number;
  private lastServedPr = '';

  constructor(limits: PrTaskClassLimits = resolveClassLimits(), now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  private runningOfClass(klass: PrTaskClass): number {
    return this.running.filter((item) => item.klass === klass).length;
  }
  private runningOfPr(pr: string): number {
    return this.running.filter((item) => item.pr === pr).length;
  }

  private admit(waiter: Waiter, index: number) {
    this.waiters.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    this.running.push({ pr: waiter.pr, klass: waiter.klass, at: this.now() });
    this.lastServedPr = waiter.pr;
    waiter.grant();
  }

  private canAdmit(waiter: Waiter): boolean {
    if (this.runningOfPr(waiter.pr) >= 1) return false; // 同一 PR 串行
    return this.runningOfClass(waiter.klass) < this.limits[waiter.klass]; // 类别上限
  }

  /**
   * 公平放行：FIFO，但刚服务过的 PR 让位给其他等待 PR（反饥饿）；
   * 仍遵守同 PR 串行与类别上限。第一轮跳过 lastServedPr，第二轮才允许，避免一个忙 PR 连占名额。
   */
  private pump() {
    let progressed = true;
    while (progressed && this.waiters.length) {
      progressed = false;
      for (const preferFresh of [true, false]) {
        for (let i = 0; i < this.waiters.length; i += 1) {
          const waiter = this.waiters[i];
          if (!this.canAdmit(waiter)) continue;
          const othersWaiting = this.waiters.some((w) => w.pr !== this.lastServedPr);
          if (preferFresh && waiter.pr === this.lastServedPr && othersWaiting) continue;
          this.admit(waiter, i);
          progressed = true;
          break;
        }
        if (progressed) break;
      }
    }
  }

  /**
   * 申请一个执行名额；返回释放函数。超时抛错（不会静默占用）。
   */
  acquire(pr: string, klass: PrTaskClass, options: { timeoutMs?: number } = {}): Promise<() => void> {
    const key = String(pr || 'unknown');
    return new Promise<() => void>((resolve, reject) => {
      let granted = false;
      const grant = () => {
        granted = true;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          const index = this.running.findIndex((item) => item.pr === key && item.klass === klass);
          if (index >= 0) this.running.splice(index, 1);
          this.pump();
        });
      };
      const waiter: Waiter = { pr: key, klass, enqueuedAt: this.now(), grant, reject };
      const timeoutMs = Number(options.timeoutMs || 0);
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          if (!granted) reject(new Error(`等待 ${klass} 执行名额超时（${timeoutMs}ms）`));
        }, timeoutMs);
        waiter.timer.unref?.();
      }
      this.waiters.push(waiter);
      this.pump();
    });
  }

  status(): SchedulerStatus {
    const by = () => ({ read: 0, ai: 0, build: 0, write: 0 } as Record<PrTaskClass, number>);
    const runningByClass = by();
    const waitingByClass = by();
    const runningByPr: Record<string, number> = {};
    for (const item of this.running) {
      runningByClass[item.klass] += 1;
      runningByPr[item.pr] = (runningByPr[item.pr] || 0) + 1;
    }
    for (const waiter of this.waiters) waitingByClass[waiter.klass] += 1;
    return {
      running: this.running.length,
      waiting: this.waiters.length,
      runningByClass,
      waitingByClass,
      runningByPr,
      oldestWaitMs: this.waiters.length ? this.now() - Math.min(...this.waiters.map((w) => w.enqueuedAt)) : 0,
    };
  }
}

/** 依据事件 payload 判定任务类别：轮询补查是轻量读取，其余（可能启动/唤醒 AI 修复）按 AI 计。 */
export function classifyDispatchClass(payload: unknown): PrTaskClass {
  const body = payload as any;
  if (body?.hook_name === 'monitor_poll' || body?.monitor_poll !== undefined) return 'read';
  const action = String(body?.action || '').toLowerCase();
  if (action === 'close' || action === 'closed' || action === 'merge' || action === 'merged') return 'read';
  return 'ai';
}
