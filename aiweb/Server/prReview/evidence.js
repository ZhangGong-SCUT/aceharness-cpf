/**
 * 修复状态证据模型（R05）
 *
 * 把「有新提交 / 未验证 / 验证通过 / 仍未修复 / 意见已失效」明确分开。
 * 关键约束：PR 收到新提交 ≠ 已修复；只有结构化推送证据（push-result.json）才允许进入
 * 「已推送待验证」，且不存在"已验证"的自动推断——验证需另据门禁/测试结果。
 *
 * 该函数为纯函数，便于单测与复用。
 */

/**
 * @param {object} data - getReviewFixData 的返回
 * @param {{prState?: string|null, prHeadSha?: string|null}} ctx
 */
export function buildFixEvidence(data, { prState = null, prHeadSha = null } = {}) {
    const baseline = String((data?.suggestionMode ? data?.suggestion?.headSha : '') || data?.prMeta?.origHeadSha || '');
    const current = String(prHeadSha || '');
    const hasNewCommit = Boolean(baseline && current && baseline !== current);
    let fixState = 'none';
    // A later suggestion in the same run has not been pushed, even when an earlier round was.
    if (data?.suggestionMode) fixState = 'suggested';
    else if (data?.pushSucceeded && data.commitSha && data.remoteHeadSha === data.commitSha
        && data.ciPassed && data.ciSha === data.commitSha && current === data.commitSha) fixState = 'verified';
    else if (data?.pushSucceeded) fixState = 'pushed_unverified';
    else if (data?.pushFailed) fixState = 'push_failed';
    else if (data?.patch) fixState = 'patched_unpushed';
    else if (data?.hasReviewFix) fixState = 'unfixed';
    const labels = {
        none: '无修复',
        unfixed: '未修复',
        suggested: '建议待决策',
        patched_unpushed: '已生成未推送',
        push_failed: '推送失败',
        pushed_unverified: '已推送待验证',
        verified: '当前提交已验证通过',
    };
    return {
        baselineHeadSha: baseline || null,
        currentHeadSha: current || null,
        hasNewCommit,
        // 有新提交但既没有推送成功、也非推送失败 → 不能声称已修复
        hasNewCommitUnverified: hasNewCommit && fixState !== 'verified'
            && !(fixState === 'pushed_unverified' && current === data?.remoteHeadSha),
        fixState,
        fixStateLabel: labels[fixState],
        patchSource: data?.patchSource || null,
        pushStatus: data?.suggestionMode ? 'not_attempted' : data?.pushStatus || null,
        previousPush: data?.suggestionMode && data?.pushSucceeded ? {
            commitSha: data.commitSha || null,
            remoteHeadSha: data.remoteHeadSha || null,
        } : null,
        staleCount: data?.staleCount || 0,
        actionableCount: data?.actionableCount || 0,
        prState: prState || null,
        asOf: new Date().toISOString(),
    };
}
