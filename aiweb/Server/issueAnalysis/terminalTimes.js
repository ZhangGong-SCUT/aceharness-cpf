/**
 * F08：任务终态时间契约（纯函数，便于独立测试）。
 *
 * 规则（审计要求）：
 *  1. finishedAt 只使用引擎时间：优先规范字段 endTime，兼容旧持久化路径的 runEndTime；
 *  2. 引擎时间缺失时，固化为"首次观察到终态"的时间 terminalObservedAt，之后不再随查询漂移；
 *  3. engineStartedAt/engineEndedAt 一旦获得即固化，不用 null 覆盖已有值。
 *
 * @param {object} ahStatus  AceHarness 状态对象（可能含 endTime / runEndTime / startTime）
 * @param {object} metadata 任务既有 metadata
 * @param {object} task     任务记录（读取 task.finishedAt 作为最后兜底）
 * @param {string} [now]    当前时间（注入便于测试）
 */
export function resolveTerminalTimes(ahStatus, metadata = {}, task = {}, now = new Date().toISOString()) {
    const ah = ahStatus || {};
    const engineStartedAt = ah.startTime || metadata.engineStartedAt || null;
    const engineEndedAt = ah.endTime || ah.runEndTime || metadata.engineEndedAt || null;
    const terminalObservedAt = metadata.terminalObservedAt || now;
    return {
        engineStartedAt,
        engineEndedAt,
        terminalObservedAt,
        finishedAt: engineEndedAt || task.finishedAt || terminalObservedAt,
    };
}
