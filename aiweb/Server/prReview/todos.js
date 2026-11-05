/**
 * R09：统一待办聚合
 *
 * 把"待审批、权限失效、推送失败、冲突、长期 CI 等待"等收敛成一个列表，
 * 每项带类型、严重度、目标 PR/run、可执行动作与原因，便于页面集中处理。
 *
 * 纯函数：输入来自各持久化来源，输出稳定排序的待办数组，便于单测。
 */

export const TODO_SEVERITY = { high: 3, medium: 2, low: 1 };

/**
 * @param {object} input
 * @param {Array} input.operations - 操作记录（operations.js listOperations）
 * @param {Array} input.notifications - 出站通知（outbox status().items）
 * @param {Array} input.capabilities - 能力阻断项 [{login, repo, reason}]
 * @param {Array} input.pendingApprovals - 等待用户决策 [{runId, pr, repo}]
 */
export function buildTodos(input = {}) {
    const todos = [];
    for (const op of input.operations || []) {
        if (op.state !== 'blocked' && op.status !== 'failed') continue;
        todos.push({
            type: 'push_blocked',
            severity: 'high',
            title: `修复受阻（${op.action || 'apply'}）`,
            detail: op.error || op.blockedReason || '执行失败或推送被拒',
            repo: op.repo || '', number: op.number || '', prUrl: op.prUrl || '',
            runId: op.runId || op.sourceRunId || '',
            action: 'retry_apply',
            operationKey: op.key || '',
        });
    }
    for (const item of input.notifications || []) {
        if (item.status !== 'failed') continue;
        todos.push({
            type: 'notify_failed',
            severity: 'medium',
            title: `通知发送失败：${item.subject || item.kind || '通知'}`,
            detail: item.lastError || '投递失败',
            action: 'retry_notify',
            notificationId: item.id,
        });
    }
    for (const cap of input.capabilities || []) {
        todos.push({
            type: 'permission_required',
            severity: 'high',
            title: `令牌权限不足：${cap.login || ''}${cap.repo ? ` @ ${cap.repo}` : ''}`,
            detail: cap.reason || '需要重新绑定具备写权限的令牌',
            action: 'rebind_token',
        });
    }
    for (const pending of input.pendingApprovals || []) {
        todos.push({
            type: 'pending_approval',
            severity: 'medium',
            title: `等待你确认修复${pending.number ? `（PR #${pending.number}）` : ''}`,
            detail: '检视修复建议等待应用 / 驳回 / 反馈',
            repo: pending.repo || '', number: pending.number || '',
            runId: pending.runId || '',
            action: 'review_fix',
        });
    }
    return todos.sort((a, b) => (TODO_SEVERITY[b.severity] || 0) - (TODO_SEVERITY[a.severity] || 0)
        || String(a.type).localeCompare(String(b.type)));
}
