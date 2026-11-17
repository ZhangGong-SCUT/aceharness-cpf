import { createHash } from 'node:crypto';

export const FAILURE_CATEGORIES = Object.freeze({
  PLATFORM_DEFECT: 'platform_defect',
  TRANSIENT_ENV: 'transient_env',
  STEP_GUIDANCE: 'step_guidance_needed',
  ISSUE_UNRESOLVED: 'issue_unresolved',
});

const DEFECT_RULES = [
  { code: 'snapshot_path_escape', pattern: /snapshot(?:_display)?[^\n]{0,100}(?:must resolve under|not absolute|path escape|symlink|outside run directory)|ohos: invalid snapshot path/i, advice: '修正截图路径校验和软链接边界；保留 run 目录所有权校验。' },
  { code: 'device_lock_leak', pattern: /device[^\n]{0,60}lock[^\n]{0,100}(?:stale|leak|zombie|expired|still held)|host-(?:ohos|android|ios)[^\n]{0,80}(?:zombie|stale|lock leak)|设备锁[^\n]{0,100}(?:泄漏|残留|僵尸)|(?:泄漏|残留|僵尸)[^\n]{0,50}设备锁|(?:stale|leak|zombie|expired|still held)[^\n]{0,100}(?:device|host-(?:ohos|android|ios))[^\n]{0,60}lock/i, advice: '清理已失效的锁和排队记录，验证心跳、超时及释放交接，不要抢占仍存活任务的设备。' },
  { code: 'archive_path_mismatch', pattern: /(?:arch|archive|outputs?\/step-logs)[^\n]{0,120}(?:ENOENT|not found|does not exist)|(?:非法产物|invalid artifact)[^\n]{0,80}(?:path|路径)/i, advice: '统一步骤日志与归档产物的路径映射，验证含空格和特殊字符的步骤名。' },
  { code: 'consistency_false_positive', pattern: /consisten(?:cy|t)[^\n]{0,100}(?:false positive|qualifier|误报)|一致性(?:检查|校验)[^\n]{0,80}误报/i, advice: '修正一致性校验的限定词与证据归属判断；不得删除或跳过真实冲突。' },
  { code: 'engine_native_crash', pattern: /(?:SIGSEGV|SIGABRT|Fatal signal|native crash|libflutter\.so[^\n]{0,60}crash|flutter engine[^\n]{0,60}crash)/i, advice: '单独定位引擎或宿主崩溃，完成最小复现和回归验证后再恢复。' },
  { code: 'sdk_isolation_invalid', pattern: /SDK 隔离失败[^\n]{0,160}(?:缺少有效清单|不兼容|不完整|共享 SDK)/i, advice: '修复该 run 的 SDK 隔离清单及目录映射，验证工作区仍与原 run 隔离；不得退回共享 SDK 绕过隔离门禁。' },
];

const TRANSIENT_PATTERNS = [
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network timeout/i,
  /HTTP (?:408|429|500|502|503|504)\b|\b(?:408|429|502|503|504) (?:Timeout|Too Many|Bad Gateway|Service Unavailable)/i,
  /服务重启时检测到运行中断|RESTART_INTERRUPT|agent process (?:exited|terminated)|引擎进程意外退出/i,
  /(?:rate limit|temporarily overloaded|connection reset by peer)/i,
];

function text(value, limit = 12000) {
  return String(value == null ? '' : value).replace(/\b(?:gh[ps]_|glpat-)[A-Za-z0-9_-]+/g, '[已隐藏凭证]').slice(0, limit);
}

function stepName(log) {
  const full = String(log?.stepName || '');
  const separator = full.indexOf('-');
  return separator > 0 ? full.slice(separator + 1) : full;
}

function failureFingerprint(category, code, step, error) {
  return createHash('sha256').update([category, code, step, text(error, 500).replace(/\b\d{4,}\b/g, '<n>')].join('|')).digest('hex').slice(0, 20);
}

function failedStepIndex(logs) {
  const candidates = logs.map((log, index) => ({ log, index }))
    .filter(({ log }) => log?.status === 'failed' && !/^完成-/.test(String(log?.stepName || '')));
  const latest = candidates.at(-1);
  if (!latest) return logs.map((log, index) => ({ log, index }))
    .findLastIndex(({ log }) => log?.status === 'failed');
  // Persisted gate failures can repeat the same infrastructure error in later states.
  // Select the first failed step in that final propagation chain, not the final archive step.
  let first = latest.index;
  while (first > 0) {
    const previous = logs[first - 1];
    if (previous?.status !== 'failed'
      || text(previous.error || previous.output) !== text(latest.log.error || latest.log.output)) break;
    first -= 1;
  }
  return first;
}

function platformRule(logs, reason, index = failedStepIndex(logs)) {
  // The causal failed step is authoritative. A recovered earlier step must not mask its successor's failure.
  const failed = logs[index];
  const evidence = failed ? [failed.error, failed.output, failed.childSummary, reason] : [reason];
  const haystack = evidence.map(item => text(item)).join('\n');
  return DEFECT_RULES.find(rule => rule.pattern.test(haystack)) || null;
}

function isIssueUnresolved(logs, reason, index = failedStepIndex(logs)) {
  const failed = logs[index];
  // Completion/report steps may be completed while the final diagnosis gate rejects the run.
  // Inspect their explicit verification fields; never infer success from step status alone.
  const failedEvidence = [failed?.error, failed?.output, failed?.childSummary].filter(Boolean).join('\n');
  const failedVerification = /(?:bug_fixed|issue_golden_flag_met)["'\s:=]+(?:false|"false"|'false')|修复(?:后)?验证(?:未通过|失败)|fix verification (?:failed|did not pass)|黄金标志(?:未满足|未通过)|Issue 原始黄金标志的修复效果尚未确认/i.test(text(failedEvidence));
  const reportEvidence = index < 0 || !failedVerification
    ? logs.filter(log => /^(?:完成|报告沉淀|修复验证)-/.test(String(log?.stepName || '')) && log?.status === 'completed')
      .flatMap(log => [log.output, log.childSummary]) : [];
  const haystack = text([failedVerification ? failedEvidence : '', ...reportEvidence, reason].filter(Boolean).join('\n'));
  const explicitConflict = /android_evidence_contradiction|证据[^\n]{0,80}(?:矛盾|冲突)/i.test(haystack);
  if (explicitConflict) return true;
  return /(?:bug_fixed|issue_golden_flag_met)["'\s:=]+(?:false|"false"|'false')|修复(?:后)?验证(?:未通过|失败)|fix verification (?:failed|did not pass)|黄金标志(?:未满足|未通过)|Issue 原始黄金标志的修复效果尚未确认/i.test(haystack);
}

function getFailedStep(run) {
  const logs = Array.isArray(run?.stepLogs) ? run.stepLogs : [];
  const index = failedStepIndex(logs);
  const failed = index >= 0 ? logs[index] : null;
  const current = String(run?.currentStep || '');
  const currentLog = [...logs].reverse().find(log => log?.stepName === current && !/^完成-/.test(current));
  return failed || currentLog || null;
}

/** Pure contract shared with the state machine so diagnosis and execution select the same step. */
export function selectResumeStepKey(runState, state) {
  if (!runState || !state?.name || state.name === '__human_approval__') return null;
  const stepKeys = new Set((state.steps || []).map(step => `${state.name}-${typeof step === 'string' ? step : step?.name || ''}`));
  const index = failedStepIndex(Array.isArray(runState.stepLogs) ? runState.stepLogs : []);
  const failedKey = index >= 0 ? String(runState.stepLogs[index]?.stepName || '') : '';
  if (stepKeys.has(failedKey)) return failedKey;
  const activeStep = (runState.activeSteps || []).find(stepKey => stepKeys.has(stepKey));
  if (activeStep) return activeStep;
  return stepKeys.has(runState.currentStep) ? runState.currentStep : null;
}

function completedSteps(run) {
  const logs = Array.isArray(run?.stepLogs) ? run.stepLogs : [];
  const completed = new Set(Array.isArray(run?.completedSteps) ? run.completedSteps : []);
  for (const log of logs) if (log?.status === 'completed' && log.stepName) completed.add(log.stepName);
  return [...completed];
}

function guidanceFor(failedStep, evidence, metadata) {
  const name = stepName(failedStep);
  const fullName = failedStep?.stepName || '最近未完成的步骤';
  const needsAndroid = /(?:android|安卓)[^\n]{0,100}(?:missing|not run|未|缺|没有|跳过)/i.test(evidence)
    || /(?:missing|未|缺|没有|跳过)[^\n]{0,100}(?:android|安卓)/i.test(evidence);
  const runtimeLimited = metadata?.verificationStatus === 'needs_runtime_validation' || /needs_runtime_validation/.test(evidence);
  const evidenceIncomplete = metadata?.verificationStatus === 'evidence_incomplete' || /evidence_incomplete|证据(?:不全|不足|缺失)/i.test(evidence);
  const actions = [];
  if (needsAndroid) actions.push('补做 Android 对照实验，记录设备、版本、操作步骤和结果；只读源码推断不能代替对照运行。');
  if (runtimeLimited) actions.push('优先完成目标平台真机/模拟器运行验证，补充操作前后截图和对应时间窗口日志；设备不可用时明确保留验证受限。');
  if (evidenceIncomplete) actions.push('逐项核对本步骤产物、复现/验证日志和截图的实际路径，补齐缺失证据并重新运行一致性检查。');
  if (!actions.length) actions.push('阅读上一次错误和输出，只修复本步骤已证实的问题；不要重做已完成的步骤，保留已有证据。');
  return {
    stepKey: failedStep?.stepName || null,
    stepName: name || fullName,
    prompt: [
      '# 失败恢复协调器：仅针对本次失败步骤的补充要求',
      `恢复步骤：${fullName}`,
      `上次失败证据：${text(failedStep?.error || evidence, 1200) || '未提供明确错误，请检查该步骤输出与产物。'}`,
      ...actions.map((action, index) => `${index + 1}. ${action}`),
      `${actions.length + 1}. 沿用已完成的分析结论和产物；如果新证据推翻旧结论，明确记录原因，不得伪造运行结果。`,
      `${actions.length + 2}. 不得把真实 bug_fixed=false 或 issue_golden_flag_met=false 改成通过；设备锁、凭证或平台异常仍无法解决时如实报告。`,
    ].join('\n'),
    actions,
  };
}

function diagnosticContext(run, logs, fallbackStep, includeBusinessCause) {
  const events = Array.isArray(run?.diagnostics) ? run.diagnostics : [];
  const validStep = log => log?.stepName && !/^完成-/.test(String(log.stepName));
  // A reproduction limitation can be the earliest business cause even when a later
  // platform defect is the first failed step. Keep those causal domains separate.
  const reproductionEvidence = logs.filter(log => log?.status === 'completed'
    && /^(?:问题复现|复现验证)-/.test(String(log.stepName)));
  const explicitReproduction = reproductionEvidence.filter(log => /"reproduction_status"\s*:/.test(text(log.output)));
  const latestReproduction = explicitReproduction.at(-1);
  const incompleteReproduction = includeBusinessCause && (explicitReproduction.length
    ? /"reproduction_status"\s*:\s*"(?:theoretical|not_reproduced|unverified)"/i.test(text(latestReproduction.output)) ? latestReproduction : null
    : reproductionEvidence.findLast(log => /黄金标志(?:未满足|未实际触发|无法在本机实际触发)/i.test(text(log.output))));
  const businessRootCause = incompleteReproduction ? {
    code: 'reproduction_not_established',
    domain: 'issue',
    stepKey: incompleteReproduction.stepName,
    stepName: stepName(incompleteReproduction),
    timestamp: incompleteReproduction.timestamp || null,
    summary: '原始 Issue 的黄金标志未在目标环境中实际复现，仅有理论分析或替代环境证据；后续修复缺少可靠的修复前后对照。',
    evidence: text(incompleteReproduction.output, 3000),
  } : null;
  const matched = events.filter(event => event?.event === 'ohos.flutter.sdk'
    && event.matched === true && typeof event.branch === 'string' && event.branch);
  // The last good pin is not necessarily the one corrupted by this event. A later run
  // may already have lost its SDK; anchor the causal window to this exact pin instead.
  let pinned = null;
  let corrupted = null;
  for (let index = matched.length - 1; index >= 0 && !corrupted; index -= 1) {
    const candidatePin = matched[index];
    const candidateCorruption = events.find(event => event?.event === 'ohos.flutter.sdk'
      && event.matched === false && typeof event.branch === 'string' && /^[A-Z]\d*$/.test(event.branch)
      && (!event.timestamp || !candidatePin.timestamp || event.timestamp > candidatePin.timestamp));
    if (candidateCorruption) {
      pinned = candidatePin;
      corrupted = candidateCorruption;
    }
  }
  if (!pinned || !corrupted) {
    const failed = logs.find(log => log?.status === 'failed' && validStep(log));
    return { businessRootCause, rootCause: null, firstFailure: failed || fallbackStep };
  }
  const afterCorruption = log => !log?.timestamp || !corrupted.timestamp || log.timestamp >= corrupted.timestamp;
  const firstFailure = logs.find(log => log?.status === 'failed' && validStep(log) && afterCorruption(log)) || fallbackStep;
  const prompts = events.filter(event => event?.event === 'step.prompt'
    && (!corrupted.timestamp || !event.timestamp || event.timestamp <= corrupted.timestamp));
  const latestPrompt = prompts.at(-1);
  const causalLog = [...logs].reverse().find(log => log?.status === 'completed'
    && log.stepName === `${latestPrompt?.state || ''}-${latestPrompt?.step || ''}`);
  return {
    businessRootCause,
    firstFailure,
    rootCause: {
      code: 'sdk_branch_pin_corrupted',
      domain: 'platform',
      stepKey: causalLog?.stepName || firstFailure?.stepName || null,
      stepName: causalLog ? stepName(causalLog) : firstFailure ? stepName(firstFailure) : 'SDK 分支解析',
      timestamp: corrupted.timestamp || null,
      expectedBranch: pinned.branch,
      actualBranch: corrupted.branch,
      expectedSdkId: pinned.sdkId || null,
      summary: `平台把业务文本中的伪分支「${corrupted.branch}」当成 Git 分支，覆盖了已确认的「${pinned.branch}」及 SDK pin；后续隔离目录与清单错误都是次生后果。`,
      evidence: [pinned, corrupted].map(event => ({ timestamp: event.timestamp, branch: event.branch,
        sdkId: event.sdkId, matched: event.matched, reason: text(event.reason, 1000) })),
    },
  };
}

/** Deterministic, fail-closed triage. It never turns a failing issue verdict into a pass. */
export function diagnoseFailure({ task = {}, run = {}, recovery = {}, now = new Date().toISOString() } = {}) {
  const logs = Array.isArray(run.stepLogs) ? run.stepLogs : [];
  const failedStep = getFailedStep(run);
  const reason = text(run.statusReason || task.error);
  const failedEvidence = text([failedStep?.error, failedStep?.output, failedStep?.childSummary, reason].filter(Boolean).join('\n'));
  const metadata = task.metadata || {};
  const attempts = Array.isArray(recovery.attempts) ? recovery.attempts : [];
  const completed = completedSteps(run);
  let category = FAILURE_CATEGORIES.STEP_GUIDANCE;
  let code = 'incomplete_step';
  let platformRuleMatch = null;

  if (isIssueUnresolved(logs, reason)) {
    category = FAILURE_CATEGORIES.ISSUE_UNRESOLVED;
    code = 'issue_verification_failed';
  } else if ((platformRuleMatch = platformRule(logs, reason))) {
    category = FAILURE_CATEGORIES.PLATFORM_DEFECT;
    code = platformRuleMatch.code;
  } else if (TRANSIENT_PATTERNS.some(pattern => pattern.test(failedEvidence))) {
    category = FAILURE_CATEGORIES.TRANSIENT_ENV;
    code = /RESTART_INTERRUPT|服务重启/.test(failedEvidence) ? 'service_restart' : 'transient_environment';
  } else if (metadata.verificationStatus === 'needs_runtime_validation') {
    code = 'runtime_validation_missing';
  } else if (metadata.verificationStatus === 'evidence_incomplete') {
    code = 'evidence_incomplete';
  } else if (/evidence_conflict/i.test(String(metadata.verificationStatus || ''))) {
    category = FAILURE_CATEGORIES.ISSUE_UNRESOLVED;
    code = 'evidence_conflict';
  }

  const fingerprint = failureFingerprint(category, code, failedStep?.stepName, failedStep?.error || reason);
  const sameFailureAttempts = attempts.filter(item => item.fingerprint === fingerprint).length;
  const maxAttemptsPerFailure = 2;
  const maxTotalAttempts = 5;
  const budgetExhausted = sameFailureAttempts >= maxAttemptsPerFailure || attempts.length >= maxTotalAttempts;
  const guidance = guidanceFor(failedStep, failedEvidence, metadata);
  const { businessRootCause: reproductionCause, rootCause, firstFailure } = diagnosticContext(run, logs, failedStep,
    category === FAILURE_CATEGORIES.ISSUE_UNRESOLVED || code === 'runtime_validation_missing');
  const businessRootCause = reproductionCause || (category === FAILURE_CATEGORIES.ISSUE_UNRESOLVED ? {
    code: [...logs].reverse().some(log => /^(?:完成|报告沉淀|修复验证)-/.test(String(log.stepName || ''))
      && /android_evidence_contradiction|证据[^\n]{0,80}(?:矛盾|冲突)/i.test(text(log.output || log.childSummary)))
      ? 'evidence_contradiction' : 'fix_verification_not_confirmed',
    domain: 'issue',
    stepKey: failedStep?.stepName || null,
    stepName: failedStep ? stepName(failedStep) : '最终验证',
    timestamp: failedStep?.timestamp || null,
    summary: 'Issue 的修复验证未通过或证据存在冲突，最终结论必须保留；当前证据不足以确定更早的业务根因。',
    evidence: text(failedEvidence, 3000),
  } : null);
  const independentCauses = Boolean(businessRootCause && rootCause);
  const businessPrecedesPlatform = independentCauses && businessRootCause.timestamp && rootCause.timestamp
    ? businessRootCause.timestamp < rootCause.timestamp : null;
  const platformDefect = platformRuleMatch ? {
    code,
    signature: fingerprint,
    title: `平台缺陷：${code}`,
    stepKey: firstFailure?.stepName || failedStep?.stepName || null,
    rootCauseStepKey: rootCause?.stepKey || null,
    rootCauseCode: rootCause?.code || null,
    summary: rootCause?.summary || platformRuleMatch.advice,
    evidence: text(failedStep?.error || reason, 2500),
    runId: run.runId || task.runId,
    taskId: task.taskId,
  } : null;
  const terminal = ['failed', 'crashed'].includes(run.status) || task.stage === 'failed';
  const needsRuntimeFollowup = ['needs_runtime_validation', 'evidence_incomplete'].includes(metadata.verificationStatus);
  let action = 'guided_resume';
  if (category === FAILURE_CATEGORIES.ISSUE_UNRESOLVED) action = 'preserve_failure_and_review';
  else if (category === FAILURE_CATEGORIES.PLATFORM_DEFECT) action = 'repair_verify_then_resume';
  else if (category === FAILURE_CATEGORIES.TRANSIENT_ENV) action = 'retry_same_step';
  if (budgetExhausted) action = 'escalate_retry_budget';

  const canResume = !budgetExhausted && Boolean(failedStep?.stepName) && category !== FAILURE_CATEGORIES.ISSUE_UNRESOLVED
    && (terminal || (needsRuntimeFollowup && category === FAILURE_CATEGORIES.STEP_GUIDANCE));
  return {
    version: 1,
    diagnosedAt: now,
    taskId: task.taskId || null,
    runId: run.runId || task.runId || null,
    category,
    code,
    summary: independentCauses
      ? `Issue 未解决的首要业务原因：${businessRootCause.summary} 执行期间另有平台故障：${rootCause.summary} 修复平台故障不等于 Issue 已解决。`
      : businessRootCause?.summary || rootCause?.summary || null,
    businessRootCause,
    causeRelationship: independentCauses ? {
      type: 'independent',
      businessPrecedesPlatform,
      summary: '业务复现缺口与平台执行故障是两条独立因果链，必须分别处理，不能相互替代。',
    } : null,
    fingerprint,
    failedStep: failedStep ? {
      stepKey: failedStep.stepName,
      stepName: stepName(failedStep),
      state: run.currentState || run.currentPhase || String(failedStep.stepName || '').split('-')[0],
      error: text(failedStep.error || reason, 2500),
      timestamp: failedStep.timestamp || null,
    } : null,
    rootCause,
    originFailedStep: rootCause && firstFailure ? {
      stepKey: firstFailure.stepName,
      stepName: stepName(firstFailure),
      error: text(firstFailure.error || firstFailure.output, 2500),
      timestamp: firstFailure.timestamp || null,
    } : null,
    preserved: { completedStepCount: completed.length, completedSteps: completed },
    examinedStepCount: logs.length,
    evidence: text(failedEvidence, 3000),
    action,
    canResume,
    requiresPlatformFix: category === FAILURE_CATEGORIES.PLATFORM_DEFECT,
    automaticRetry: category === FAILURE_CATEGORIES.TRANSIENT_ENV && canResume && sameFailureAttempts === 0,
    guidance,
    platformDefect,
    retry: { totalAttempts: attempts.length, sameFailureAttempts, maxAttemptsPerFailure, maxTotalAttempts, exhausted: budgetExhausted },
    truthfulnessGuard: '恢复只重试执行，不修改 Issue 验证事实；真实修复未通过或证据冲突必须保留并交人工复核。',
    analyzer: { mode: 'deterministic', supervisorReviewed: false },
  };
}

/** Semantic review may refine guidance, never override evidence-based safety categories. */
export function mergeSupervisorReview(diagnosis, review) {
  if (!review || typeof review !== 'object') return diagnosis;
  const result = { ...diagnosis, analyzer: { mode: 'deterministic+supervisor', supervisorReviewed: true } };
  if (typeof review.summary === 'string' && review.summary.trim()) result.summary = text(review.summary, 2000);
  if (typeof review.guidance === 'string' && review.guidance.trim()) {
    result.guidance = { ...diagnosis.guidance, prompt: `${diagnosis.guidance.prompt}\n\n# Supervisor 补充复核\n${text(review.guidance, 3000)}` };
  }
  // Only an unclassified execution gap can be promoted to a transient retry.
  if (diagnosis.category === FAILURE_CATEGORIES.STEP_GUIDANCE && diagnosis.code === 'incomplete_step'
    && review.category === FAILURE_CATEGORIES.TRANSIENT_ENV && typeof review.transientEvidence === 'string' && review.transientEvidence.trim()) {
    result.category = FAILURE_CATEGORIES.TRANSIENT_ENV;
    result.code = 'supervisor_confirmed_transient';
    result.action = 'retry_same_step';
    result.transientEvidence = text(review.transientEvidence, 1500);
  }
  return result;
}

export function buildSupervisorTriagePrompt(diagnosis) {
  return [
    '你是 Issue 分析工作流的失败恢复 Supervisor。根据已定位的失败步骤和证据，给出可执行的恢复建议。',
    '禁止把真实修复失败、证据冲突或缺少运行时证据判成平台问题；禁止建议删除验证、伪造 bug_fixed 或黄金标志。',
    '平台缺陷必须已有明确错误签名；本轮只允许对暂时性环境故障补充证据，不允许自行宣布平台缺陷已修复。',
    JSON.stringify({ category: diagnosis.category, code: diagnosis.code, failedStep: diagnosis.failedStep, evidence: diagnosis.evidence }, null, 2),
    '只输出 JSON：{"summary":"故障摘要","guidance":"只针对失败步骤的恢复指令","category":"transient_env 或 step_guidance_needed","transientEvidence":"仅暂时性故障填写，否则空字符串"}',
  ].join('\n\n');
}
