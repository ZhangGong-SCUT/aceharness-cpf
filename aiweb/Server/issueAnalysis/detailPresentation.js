/** AIWeb 只需要这些状态字段；原始 ACE 审计、对话和执行记录不应阻塞详情首屏。 */
const STATUS_FIELDS = [
    'status', 'statusReason', 'runId', 'currentConfigFile', 'currentState',
    'currentPhase', 'currentStep', 'startTime', 'endTime', 'runEndTime',
    'diagnosisArtifactStatus', 'diagnosisVerificationStatus', 'finalReview',
];
const STEP_FIELDS = [
    'id', 'stepName', 'status', 'outputRef', 'outputBytes', 'error',
    'timestamp', 'durationMs', 'childRunId', 'childStatus', 'childSummary',
];

export function issueDetailStatus(status) {
    if (!status) return null;
    const result = {};
    for (const key of STATUS_FIELDS) {
        if (status[key] !== undefined) result[key] = status[key];
    }
    result.stepLogs = Array.isArray(status.stepLogs)
        ? status.stepLogs.map(step => Object.fromEntries(
            STEP_FIELDS.filter(key => step?.[key] !== undefined).map(key => [key, step[key]]),
        )) : [];
    return result;
}
