export function buildPrMonitorHealth({ runStatus, waitReason, gateWait, lastCheckedAt, generatedAt, queryError, now = Date.now() }) {
    const checked = Date.parse(lastCheckedAt || '');
    const valid = Number.isFinite(checked);
    const active = ['running', 'preparing', 'pending', 'paused'].includes(runStatus);
    return {
        lastCheckedAt: valid ? lastCheckedAt : null,
        dataAsOf: valid ? lastCheckedAt : null,
        generatedAt,
        waitReason,
        dataAgeMs: valid ? Math.max(0, now - checked) : null,
        reconcileIntervalMs: gateWait ? 30000 : null,
        nextCheckAt: gateWait && valid ? new Date(checked + 30000).toISOString() : null,
        monitoringPaused: active && !gateWait && !!waitReason?.startsWith('等待用户'),
        stale: active && (!valid || now - checked > 90000),
        queryUnavailable: !!queryError,
        lastQueryError: queryError || null,
    };
}
