import { describe, expect, it } from 'vitest';
import { detectReviewPendingDecision, isTesterApproved } from '../skills/gitcode-pr-review/scripts/check-pr-gates.mjs';
import { detectReviewDismissal } from '../skills/gitcode-pr-review/scripts/fetch-ai-review.mjs';

describe('detectReviewPendingDecision（检视建议等待决策判定）', () => {
  const HEAD = 'a'.repeat(40);

  it('建议标记 head 与当前 head 一致 → true（等待用户决策）', () => {
    expect(detectReviewPendingDecision({ mode: 'suggestion', head_sha: HEAD }, HEAD)).toBe(true);
  });

  it('head 漂移（用户等待期间又推送）→ false，走正常流程', () => {
    expect(detectReviewPendingDecision({ mode: 'suggestion', head_sha: 'b'.repeat(40) }, HEAD)).toBe(false);
  });

  it('无建议标记 / 非建议模式 / 缺 head → false', () => {
    expect(detectReviewPendingDecision(null, HEAD)).toBe(false);
    expect(detectReviewPendingDecision({}, HEAD)).toBe(false);
    expect(detectReviewPendingDecision({ mode: 'applied', head_sha: HEAD }, HEAD)).toBe(false);
    expect(detectReviewPendingDecision({ mode: 'suggestion' }, HEAD)).toBe(false);
    expect(detectReviewPendingDecision({ mode: 'suggestion', head_sha: HEAD }, '')).toBe(false);
  });

  it('head 前后空白不影响比较', () => {
    expect(detectReviewPendingDecision({ mode: 'suggestion', head_sha: ` ${HEAD} ` }, HEAD)).toBe(true);
  });
});

describe('isTesterApproved（测试人已通过判定）', () => {
  it('testers 非空且全部 accept → true（网页"测试人 ✓ 已通过"）', () => {
    expect(isTesterApproved([{ login: 'openharmony_ci', accept: true }])).toBe(true);
    expect(isTesterApproved([{ login: 'a', accept: true }, { login: 'b', accept: true }])).toBe(true);
  });

  it('任一未通过 → false（可继续监控）', () => {
    expect(isTesterApproved([{ login: 'openharmony_ci', accept: false }])).toBe(false);
    expect(isTesterApproved([{ login: 'a', accept: true }, { login: 'b', accept: false }])).toBe(false);
  });

  it('空/无测试人/异常输入 → false（无法判定不拦截）', () => {
    expect(isTesterApproved([])).toBe(false);
    expect(isTesterApproved(undefined)).toBe(false);
    expect(isTesterApproved(null)).toBe(false);
    expect(isTesterApproved([null, {}])).toBe(false);
  });
});

describe('detectReviewDismissal（驳回标记检测）', () => {
  const c = (at, body, kind = 'ai_review') => ({ created_at: at, body, kind });

  it('标记晚于全部待处理意见 → dismissed', () => {
    const comments = [
      c('2026-09-17T10:00:00Z', '【AI-Review】【一般】问题A'),
      c('2026-09-17T11:00:00Z', '【AI-Review】【严重】问题B'),
      c('2026-09-17T12:00:00Z', '【AI检视处理】用户已驳回全部 AI 检视意见（共 2 条）。'),
    ];
    const r = detectReviewDismissal(comments, comments.slice(0, 2));
    expect(r.dismissed).toBe(true);
    expect(r.dismissedAt).toBe('2026-09-17T12:00:00Z');
  });

  it('驳回后有新检视意见（重新检视）→ 不 dismissed', () => {
    const comments = [
      c('2026-09-17T10:00:00Z', '【AI-Review】【一般】问题A'),
      c('2026-09-17T12:00:00Z', '【AI检视处理】用户已驳回全部 AI 检视意见（共 1 条）。'),
      c('2026-09-17T13:00:00Z', '【AI-Review】【严重】新问题（驳回后重新检视）'),
    ];
    const r = detectReviewDismissal(comments, [comments[0], comments[2]]);
    expect(r.dismissed).toBe(false);
  });

  it('无标记 → 不 dismissed', () => {
    const comments = [c('2026-09-17T10:00:00Z', '【AI-Review】【一般】问题A')];
    expect(detectReviewDismissal(comments, comments).dismissed).toBe(false);
    expect(detectReviewDismissal([], []).dismissed).toBe(false);
  });

  it('多个标记取最新；标记缺少时间 → 不 dismissed', () => {
    const comments = [
      c('2026-09-16T10:00:00Z', '【AI检视处理】旧标记'),
      c('2026-09-17T12:00:00Z', '【AI检视处理】新标记'),
      c('2026-09-17T11:00:00Z', '【AI-Review】【一般】问题A'),
    ];
    expect(detectReviewDismissal(comments, [comments[2]]).dismissed).toBe(true);
    expect(detectReviewDismissal([c('', '【AI检视处理】无时间标记')], []).dismissed).toBe(false);
  });
});
