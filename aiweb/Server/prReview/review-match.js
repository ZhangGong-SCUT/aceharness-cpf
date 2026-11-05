/**
 * 检视产物必须属于当前 PR。模板拷贝会把上一份 PR 的 ai-review-comments.json 带进新 run，
 * 门禁阶段又不会重写它，所以只看文件在不在会把别的 PR 的意见显示出来。
 */
export function reviewArtifactMatchesPr(review, meta) {
    if (!review || typeof review !== 'object') return false;
    const number = String(review.number ?? '').replace(/^#/, '');
    const current = String(meta?.number ?? '').replace(/^#/, '');
    if (number && current && number !== current) return false;
    const owner = String(review.owner || '').toLowerCase();
    const repo = String(review.repo || '').toLowerCase();
    if (owner && meta?.owner && owner !== String(meta.owner).toLowerCase()) return false;
    if (repo && meta?.repo && repo !== String(meta.repo).toLowerCase()) return false;
    return true;
}
