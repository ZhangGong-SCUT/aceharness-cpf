import { httpRequest, getServiceToken } from './aceHarnessClient.js';

/** Query the engine's persisted record, independent of this proxy's filesystem. */
export async function getPersistedIssueRun(runId, configFile) {
    const token = await getServiceToken();
    const response = await httpRequest('GET', `/api/run-history?runId=${encodeURIComponent(runId)}&pageSize=1`, null, { token, timeoutMs: 4000 });
    if (response.status !== 200) throw new Error(`持久化运行状态查询失败（HTTP ${response.status}）`);
    const run = response.data?.runs?.find(r => r.id === runId && r.configFile === configFile);
    if (run) return { ...run, runId, endTime: run.endTime || null, runEndTime: run.endTime, currentPhase: run.currentPhase };
    // An empty access-filtered list is not proof of absence. Only explicit 404 from detail is.
    const detail = await httpRequest('GET', `/api/runs/${encodeURIComponent(runId)}/detail?compact=1`, null, { token, timeoutMs: 4000 });
    if (detail.status === 404) return null;
    if (detail.status !== 200) throw new Error(`运行记录暂不可读（HTTP ${detail.status}）`);
    const data = detail.data;
    if (!data?.status || (data.configFile && data.configFile !== configFile)) throw new Error('运行记录身份或状态未确认');
    return { ...data, runId, endTime: data.endTime || null, currentPhase: data.currentPhase || data.currentState };
}
