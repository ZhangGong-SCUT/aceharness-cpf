import { getServiceToken, getWorkflowStatusCompact, httpRequest } from './aceHarnessClient.js';
import { getPersistedIssueRun } from './runRecovery.js';
import { buildSupervisorTriagePrompt, mergeSupervisorReview } from './failureTriage.js';
import { readLocalDiagnosticEvents, readLocalIssueRunForTriage } from './localFailureEvidence.js';
import config from '../library/config.js';

const localOnly = ['localhost', '127.0.0.1', '::1'].includes(new URL(config.aceharness.apiBaseUrl).hostname);

export function issueRunIdentity(task) {
  let metadata = task?.metadata || {};
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
  }
  return {
    metadata,
    runId: metadata.runId || task?.analysisSessionId,
    configFile: metadata.configFile,
  };
}

async function diagnosticEvents(runId, token, localReader, request = httpRequest) {
  const response = await request('GET', `/api/runs/${encodeURIComponent(runId)}/failure-evidence`, null, { token, timeoutMs: 5000 }).catch(() => null);
  // An older ACE serves the SPA fallback with HTTP 200 HTML for unknown API routes.
  // Only a real event array is evidence; otherwise retain the local diagnostic fallback.
  if (response?.status === 200 && Array.isArray(response.data?.events)) return response.data.events;
  return localReader(runId);
}

function missingFinalVerificationFields(run) {
  return !(run.stepLogs || []).some(log => /^(?:完成|报告沉淀|修复验证)-/.test(String(log.stepName || ''))
    && [log.output, log.childSummary].some(value => /issue_golden_flag_met|bug_fixed|android_evidence_contradiction/i.test(String(value || ''))));
}

/** Read-only, bounded evidence snapshot; never starts or changes the original run. */
export async function loadIssueRunForTriage(runId, configFile, dependencies = {}) {
  const token = dependencies.token || await getServiceToken();
  const localReader = dependencies.localReader || (localOnly ? readLocalDiagnosticEvents : async () => []);
  const localRunReader = dependencies.localRunReader || (localOnly ? readLocalIssueRunForTriage : async () => null);
  const readStatus = dependencies.readStatus || getWorkflowStatusCompact;
  let run = null;
  try {
    const status = await readStatus(runId, configFile);
    if (status?.runId === runId && Array.isArray(status.stepLogs)) {
      run = { ...status, configFile: status.currentConfigFile || configFile };
    }
  } catch { /* Try a bounded persisted record before declaring the run unavailable. */ }
  if (!run) {
    try {
      const persisted = await (dependencies.readPersisted || getPersistedIssueRun)(runId, configFile);
      if (Array.isArray(persisted?.stepLogs) && persisted.stepLogs.length) run = persisted;
    } catch { /* The local snapshot below retains the original failure evidence. */ }
  }
  if (!run) run = await localRunReader(runId, configFile);
  if (!run) {
    const error = new Error('运行证据不存在，不能安全恢复');
    error.status = 404;
    throw error;
  }
  const [diagnostics, local] = await Promise.all([
    diagnosticEvents(runId, token, localReader, dependencies.readDiagnosticEvents || httpRequest),
    // Old ACE history responses can contain only one terminal step and no verification
    // fields. Always enrich terminal runs so both causal history and the final gate survive.
    ['failed', 'crashed'].includes(run.status) ? localRunReader(runId, configFile).catch(() => null) : null,
  ]);
  if (local) {
    const compactLogs = new Map((run.stepLogs || []).map(log => [log.stepName, log]));
    const localLogs = new Map((local.stepLogs || []).map(log => [log.stepName, log]));
    const logsHaveSameIdentity = run.stepLogs?.length === local.stepLogs?.length
      && local.stepLogs.every((log, index) => log.stepName === run.stepLogs[index]?.stepName);
    const mergeOutput = log => ({ ...log, output: localLogs.get(log.stepName)?.output || log.output || '' });
    const enrichCompact = log => ({ ...log, output: log.output || localLogs.get(log.stepName)?.output || '' });
    run = {
      ...run,
      statusReason: run.statusReason || local.statusReason,
      completedSteps: [...new Set([...(run.completedSteps || []), ...(local.completedSteps || [])])],
      // Preserve compact live metadata when it is complete; replace only a truncated history.
      stepLogs: logsHaveSameIdentity ? local.stepLogs.map(mergeOutput)
        : [...local.stepLogs.filter(log => !compactLogs.has(log.stepName)).map(mergeOutput),
          ...run.stepLogs.map(enrichCompact)],
    };
  }
  return { ...run, diagnostics };
}

/** Ask the existing Supervisor to refine instructions; safety categories remain fail-closed. */
export async function reviewFailureWithSupervisor(run, diagnosis) {
  if (['platform_defect', 'issue_unresolved', 'transient_env'].includes(diagnosis.category)
    || !run?.configFile || run.mode !== 'state-machine') return diagnosis;
  try {
    const token = await getServiceToken();
    const response = await httpRequest('POST', '/api/workflow/failure-review', {
      runId: run.runId, prompt: buildSupervisorTriagePrompt(diagnosis),
    }, { token, timeoutMs: 75000 });
    if (response.status !== 200) return diagnosis;
    const raw = String(response.data?.rawOutput || '');
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    return json ? mergeSupervisorReview(diagnosis, JSON.parse(json)) : diagnosis;
  } catch {
    // A review outage cannot lose the deterministic evidence or block manual triage.
    return diagnosis;
  }
}
