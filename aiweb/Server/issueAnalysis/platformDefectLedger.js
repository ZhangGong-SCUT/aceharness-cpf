import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { aceDataDir } from '../library/aceRuntime.js';
import config from '../library/config.js';

const FILE_NAME = 'platform-defects.json';

/** A ledger bound to the same configured directory as the Issue task database. */
export function createPlatformDefectLedger(rootDirectory) {
  let writeQueue = Promise.resolve();
  const filePath = () => path.join(rootDirectory, FILE_NAME);

  async function readLedger() {
    try {
      const value = JSON.parse(await readFile(filePath(), 'utf8'));
      return value?.version === 1 && Array.isArray(value.defects) ? value : { version: 1, defects: [] };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, defects: [] };
      throw new Error(`平台缺陷台账读取失败：${error.message}`);
    }
  }

  function serialized(operation) {
    const next = writeQueue.catch(() => {}).then(operation);
    writeQueue = next;
    return next;
  }

  // Atomic rename prevents partial reads; the lock prevents lost updates between AIWeb workers.
  async function locked(operation) {
    await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
    const lockPath = `${filePath()}.lock`;
    let handle;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { handle = await open(lockPath, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * 30));
      }
    }
    if (!handle) throw new Error('平台缺陷台账正被其他进程更新，请稍后重试');
    try { return await operation(); }
    finally { await handle.close(); await rm(lockPath, { force: true }); }
  }

  async function save(ledger) {
    const temporary = `${filePath()}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filePath());
  }

  async function record(defect) {
    return serialized(() => locked(async () => {
      const ledger = await readLedger();
      const now = new Date().toISOString();
      let item = ledger.defects.find(entry => entry.signature === defect.signature);
      if (item) {
        item.occurrenceCount += 1;
        item.lastSeenAt = now;
        item.latestEvidence = defect.evidence || item.latestEvidence;
        if (!item.affectedRuns.some(run => run.runId === defect.runId)) {
          item.affectedRuns.push({ runId: defect.runId, taskId: defect.taskId, stepKey: defect.stepKey, observedAt: now });
        }
      } else {
        item = {
          defectId: `PD-${randomUUID()}`, signature: defect.signature, code: defect.code,
          title: defect.title, summary: defect.summary, status: 'open', occurrenceCount: 1,
          firstSeenAt: now, lastSeenAt: now, latestEvidence: defect.evidence || '',
          affectedRuns: [{ runId: defect.runId, taskId: defect.taskId, stepKey: defect.stepKey, observedAt: now }], history: [],
        };
        ledger.defects.push(item);
      }
      item.history.push({ action: 'recorded', at: now, runId: defect.runId, taskId: defect.taskId });
      await save(ledger);
      return structuredClone(item);
    }));
  }

  async function markFixed(signature, evidence) {
    return serialized(() => locked(async () => {
      const ledger = await readLedger();
      const item = ledger.defects.find(entry => entry.signature === signature);
      if (!item) throw new Error('未找到对应的平台缺陷记录');
      const value = String(evidence || '').trim();
      if (value.length < 8) throw new Error('请提供平台修复验证证据（验证命令、测试或修复说明），不能只填写“已修复”');
      item.status = 'fix_verified';
      item.fixVerifiedAt = new Date().toISOString();
      item.fixEvidence = value.slice(0, 6000);
      item.history.push({ action: 'fix_verified', at: item.fixVerifiedAt, evidence: item.fixEvidence });
      await save(ledger);
      return structuredClone(item);
    }));
  }

  async function list() {
    const ledger = await readLedger();
    return {
      version: 1, total: ledger.defects.length,
      open: ledger.defects.filter(item => item.status === 'open').length,
      fixVerified: ledger.defects.filter(item => item.status === 'fix_verified').length,
      occurrences: ledger.defects.reduce((sum, item) => sum + item.occurrenceCount, 0),
      defects: ledger.defects,
    };
  }
  return { record, markFixed, list };
}

const defaultLedger = createPlatformDefectLedger(config.issueanalysisRoot || path.join(aceDataDir(), 'aiweb', 'issueanalysis'));
export const recordPlatformDefect = defaultLedger.record;
export const markPlatformDefectFixed = defaultLedger.markFixed;
export const listPlatformDefects = defaultLedger.list;
