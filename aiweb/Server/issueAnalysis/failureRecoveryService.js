import { diagnoseFailure } from './failureTriage.js';
import { issueRunIdentity, loadIssueRunForTriage, reviewFailureWithSupervisor } from './failureAnalysisAdapter.js';
import { listPlatformDefects, markPlatformDefectFixed, recordPlatformDefect } from './platformDefectLedger.js';

/**
 * Failure-recovery coordinator for Issue Analysis.
 * Existing engine resume() remains the only executor; this layer only diagnoses,
 * keeps audit evidence and supplies bounded, step-specific guidance.
 */
export function createFailureRecoveryService({
  store,
  aceConfigFile,
  resumeWorkflow,
  singleFlight,
  stageAnalyzing,
  logger = console,
  readRun = loadIssueRunForTriage,
  supervisorReview = reviewFailureWithSupervisor,
  ledger = { record: recordPlatformDefect, markFixed: markPlatformDefectFixed, list: listPlatformDefects },
} = {}) {
  async function diagnose(taskId, { persist = true, supervisor = false } = {}) {
    const task = store.get(taskId);
    if (!task) {
      const error = new Error('任务不存在');
      error.status = 404;
      throw error;
    }
    const { metadata, runId, configFile } = issueRunIdentity(task);
    if (!runId) {
      const error = new Error('这个任务还没有可分析的运行记录');
      error.status = 400;
      throw error;
    }
    const run = await readRun(runId, configFile || aceConfigFile);
    if (run.runId !== runId || (run.configFile && run.configFile !== (configFile || aceConfigFile))) {
      const error = new Error('运行身份不匹配，已拒绝恢复');
      error.status = 409;
      throw error;
    }
    let diagnosis = diagnoseFailure({ task, run, recovery: metadata.failureRecovery });
    if (supervisor) diagnosis = await supervisorReview(run, diagnosis);
    if (persist) {
      const latest = store.get(taskId);
      const latestMetadata = issueRunIdentity(latest).metadata;
      const previous = latestMetadata.failureRecovery || {};
      // A status query must not turn a newer running task back into a terminal diagnosis.
      if (!['issueanalysis_analyzing', 'issueanalysis_fetching', 'issueanalysis_pending'].includes(latest.stage)) {
        let platformDefect = null;
        if (diagnosis.platformDefect) {
          platformDefect = await ledger.record(diagnosis.platformDefect);
          diagnosis = { ...diagnosis, platformDefect: {
            defectId: platformDefect.defectId, status: platformDefect.status,
            occurrenceCount: platformDefect.occurrenceCount, code: platformDefect.code, signature: platformDefect.signature,
          } };
        }
        store.patch(taskId, { metadata: {
          ...latestMetadata,
          failureRecovery: { ...previous, diagnosis, lastDiagnosedAt: new Date().toISOString() },
        }, updatedAt: new Date().toISOString() });
      }
    }
    return diagnosis;
  }

  async function continueTask(taskId, { feedback = '', fixEvidence = '', automatic = false } = {}) {
    return singleFlight(`issue-failure-resume:${taskId}`, async () => {
      const task = store.get(taskId);
      if (!task) {
        const error = new Error('任务不存在');
        error.status = 404;
        throw error;
      }
      if (['issueanalysis_analyzing', 'issueanalysis_fetching', 'issueanalysis_pending'].includes(task.stage)) {
        const error = new Error('任务正在运行，不能重复恢复');
        error.status = 409;
        throw error;
      }
      let diagnosis = await diagnose(taskId, { persist: true, supervisor: true });
      if (diagnosis.category === 'issue_unresolved') {
        const error = new Error('这是 Issue 的真实验证失败或证据冲突，不是可绕过的执行故障。请保留结论并通过反馈迭代或人工复核处理。');
        error.status = 409;
        error.diagnosis = diagnosis;
        throw error;
      }
      if (diagnosis.retry.exhausted) {
        const error = new Error(`该故障已重试 ${diagnosis.retry.sameFailureAttempts} 次（或累计达到上限），需要人工排查，不能无限自动恢复`);
        error.status = 429;
        error.diagnosis = diagnosis;
        throw error;
      }
      if (!diagnosis.failedStep?.stepKey) {
        const error = new Error('没有定位到可安全恢复的失败步骤；请人工检查运行状态，不会从头重跑');
        error.status = 409;
        error.diagnosis = diagnosis;
        throw error;
      }
      if (diagnosis.requiresPlatformFix) {
        if (!fixEvidence) {
          const error = new Error(`已登记平台缺陷 ${diagnosis.platformDefect.code}。请先修复并提交验证证据，再从失败步骤继续。`);
          error.status = 409;
          error.diagnosis = diagnosis;
          throw error;
        }
        const defect = await ledger.markFixed(diagnosis.platformDefect.signature, fixEvidence);
        diagnosis = { ...diagnosis, platformDefect: { ...diagnosis.platformDefect, status: defect.status } };
      }
      if (automatic && !diagnosis.automaticRetry) {
        const error = new Error('该故障不满足自动重试条件，需要修复确认或人工触发定向恢复');
        error.status = 409;
        throw error;
      }
      const instruction = String(feedback || '').trim().slice(0, 6000);
      const attempt = {
        attemptId: `recovery-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        at: new Date().toISOString(),
        fingerprint: diagnosis.fingerprint,
        category: diagnosis.category,
        stepKey: diagnosis.failedStep.stepKey,
        mode: automatic ? 'automatic_transient_retry' : diagnosis.requiresPlatformFix ? 'verified_platform_resume' : 'guided_resume',
        fixEvidence: fixEvidence ? String(fixEvidence).slice(0, 6000) : undefined,
        feedback: instruction || undefined,
      };
      const recovery = issueRunIdentity(task).metadata.failureRecovery || {};
      const prompt = [
        diagnosis.guidance.prompt,
        fixEvidence ? `# 平台修复验证（由操作者提供，恢复后仍须独立验证）\n${String(fixEvidence).slice(0, 6000)}` : '',
        instruction ? `# 操作者针对该步骤的补充说明\n${instruction}` : '',
      ].filter(Boolean).join('\n\n');
      const latest = store.get(taskId);
      const latestMetadata = issueRunIdentity(latest).metadata;
      store.patch(taskId, {
        stage: stageAnalyzing,
        error: null,
        finishedAt: null,
        updatedAt: new Date().toISOString(),
        metadata: { ...latestMetadata, failureRecovery: {
          ...recovery, diagnosis,
          attempts: [...(recovery.attempts || []), attempt],
          lastResumeAt: attempt.at,
        } },
      });
      try {
        await resumeWorkflow(diagnosis.runId, prompt);
      } catch (error) {
        const current = store.get(taskId);
        const currentMetadata = issueRunIdentity(current).metadata;
        const currentRecovery = currentMetadata.failureRecovery || {};
        store.patch(taskId, {
          stage: 'failed', error: `恢复请求失败：${error.message}`, finishedAt: new Date().toISOString(),
          metadata: { ...currentMetadata, failureRecovery: { ...currentRecovery, lastResumeError: error.message } },
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
      logger.info('Issue 失败恢复已启动', { taskId, runId: diagnosis.runId, step: diagnosis.failedStep.stepKey, category: diagnosis.category });
      return {
        taskId, runId: diagnosis.runId,
        phase: diagnosis.failedStep.state,
        step: diagnosis.failedStep.stepName,
        diagnosis,
        message: `已保留 ${diagnosis.preserved.completedStepCount} 个已完成步骤，从「${diagnosis.failedStep.stepName}」继续，并向该步骤注入恢复指令。`,
      };
    });
  }

  async function automaticRecover(taskId, stage) {
    if (stage !== 'failed') return null;
    const task = store.get(taskId);
    const { metadata, runId } = issueRunIdentity(task);
    if (!runId || metadata.failureRecovery?.autoRetryInFlight) return null;
    // Preliminary classification avoids an expensive full-output read for ordinary failures.
    if (!/RESTART_INTERRUPT|服务重启|ETIMEDOUT|ECONNRESET|ECONNREFUSED|HTTP 50[0234]|socket hang up/i.test(String(task.error || ''))) return null;
    const latest = store.get(taskId);
    if (latest.stage !== task.stage) return null;
    store.patch(taskId, { metadata: { ...metadata, failureRecovery: { ...metadata.failureRecovery, autoRetryInFlight: true } } });
    try { return await continueTask(taskId, { automatic: true }); }
    catch (error) {
      const current = store.get(taskId);
      const currentMetadata = issueRunIdentity(current).metadata;
      store.patch(taskId, { metadata: { ...currentMetadata, failureRecovery: {
        ...currentMetadata.failureRecovery, autoRetryInFlight: false, lastAutoRetryError: error.message,
      } } });
      return null;
    }
  }

  return { diagnose, continueTask, automaticRecover, listDefects: ledger.list };
}
