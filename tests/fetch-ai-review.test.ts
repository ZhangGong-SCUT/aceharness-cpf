import { afterEach, describe, expect, test } from 'vitest';
import {
  classifyPrComment,
  commentTimeLE,
  isAiReviewComment,
  isCiBroadcastComment,
  isPrCommandComment,
  isSystemEventComment,
  parseReviewBots,
  selectActionableReviews,
} from '../skills/gitcode-pr-review/scripts/ohos-pr-gates.mjs';
import { PR1913_COMMENTS, PR1914_COMMENTS } from './fixtures/pr1913-ai-review';

describe('isAiReviewComment（1913 真意见漏报修复）', () => {
  test('识别 cpf-manager 白名单作者', () => {
    expect(isAiReviewComment({ author: 'cpf-manager', body: '随便说什么' })).toBe(true);
  });

  test('识别【AI-Review】连字符格式（旧正则 AI\\s*检视|AI Review 认不出）', () => {
    expect(isAiReviewComment({ author: 'someone', body: '【AI-Review】【建议】【基础代码问题】缺测试' })).toBe(true);
  });

  test('兼容旧格式 AI Review / AI检视', () => {
    expect(isAiReviewComment({ author: 'someone', body: 'AI Review: please fix' })).toBe(true);
    expect(isAiReviewComment({ author: 'someone', body: 'AI检视意见如下' })).toBe(true);
  });

  test('普通评论不算 AI 检视', () => {
    expect(isAiReviewComment({ author: 'huhaodong', body: 'start build' })).toBe(false);
    expect(isAiReviewComment({ author: 'z2036709353', body: '1' })).toBe(false);
  });

  test('ACE_GITCODE_REVIEW_BOTS 可扩展白名单', () => {
    const previous = process.env.ACE_GITCODE_REVIEW_BOTS;
    process.env.ACE_GITCODE_REVIEW_BOTS = 'my-review-bot';
    try {
      expect(parseReviewBots()).toContain('my-review-bot');
      expect(parseReviewBots()).toContain('cpf-manager');
      expect(isAiReviewComment({ author: 'my-review-bot', body: 'x' })).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ACE_GITCODE_REVIEW_BOTS;
      else process.env.ACE_GITCODE_REVIEW_BOTS = previous;
    }
  });
});

describe('噪声分类', () => {
  test('口令与纯数字不是意见', () => {
    for (const body of ['start build', 'start  build', 'check dco', 'submit', '1', '123']) {
      expect(isPrCommandComment({ body })).toBe(true);
    }
    expect(isPrCommandComment({ body: '这里建议补个单测' })).toBe(false);
  });

  test('CI 播报账号精确匹配（不误伤人名含 dcp/ci 的贡献者）', () => {
    expect(isCiBroadcastComment({ author: 'openharmony_ci' })).toBe(true);
    expect(isCiBroadcastComment({ author: 'openharmony_dcp' })).toBe(true);
    expect(isCiBroadcastComment({ author: 'dcpeng' })).toBe(false);
    expect(isCiBroadcastComment({ author: 'huhaodong' })).toBe(false);
  });

  test('系统事件播报不是意见（cpf-manager 发的 Added label 也不能算检视意见）', () => {
    expect(isSystemEventComment({ body: 'Added label: AI已检视' })).toBe(true);
    expect(isSystemEventComment({ body: 'Removed label: AI检视中' })).toBe(true);
    expect(isSystemEventComment({ body: 'Pushed 1 commits: b47ff35a test(ohos)' })).toBe(true);
    expect(isSystemEventComment({ body: 'Approval passed' })).toBe(true);
    expect(isSystemEventComment({ body: '【AI-Review】【建议】缺测试' })).toBe(false);
  });

  test('classifyPrComment 返回正确类别', () => {
    expect(classifyPrComment({ author: 'z2036709353', body: '1' })).toBe('command');
    expect(classifyPrComment({ author: 'openharmony_ci', body: '代码门禁未通过 <table>…' })).toBe('ci');
    expect(classifyPrComment({ author: 'cpf-manager', body: '【AI-Review】x' })).toBe('ai_review');
    expect(classifyPrComment({ author: 'gaoyu321', body: '这里改成单引号', path: 'a.ets', line: 10 })).toBe('diff_comment');
    expect(classifyPrComment({ author: 'gaoyu321', body: '整体看了没问题' })).toBe('conversation');
    expect(classifyPrComment({ author: 'cpf-manager', body: 'Added label: AI已检视' })).toBe('system');
  });
});

describe('selectActionableReviews 真实事故回归', () => {
  test('1913：唯一真意见已被后续 push 覆盖 → actionable=0、stale=1、噪声=19（旧版 20 全 actionable）', () => {
    const result = selectActionableReviews(PR1913_COMMENTS);
    expect(result.counts).toMatchObject({
      actionable_count: 0,
      ai_review_count: 0,
      human_diff_comment_count: 0,
      stale_count: 1,
      noise_filtered_count: 19,
    });
    expect(result.stale[0]).toMatchObject({ author: 'cpf-manager', kind: 'ai_review', stale: true });
    expect(result.stale[0].body).toContain('【AI-Review】');
  });

  test('1914：全是噪声 → actionable=0（旧版 20 全 actionable）', () => {
    const result = selectActionableReviews(PR1914_COMMENTS);
    expect(result.counts).toMatchObject({
      actionable_count: 0,
      stale_count: 0,
      noise_filtered_count: 20,
    });
  });

  test('1913 加 --include-stale 语义：旧意见合并回 actionable 兜底', () => {
    const result = selectActionableReviews(PR1913_COMMENTS, { include_stale: true });
    expect(result.counts.actionable_count).toBe(1);
    expect(result.counts.ai_review_count).toBe(1);
    expect(result.actionable[0]).toMatchObject({ author: 'cpf-manager', stale: true });
  });
});

describe('selectActionableReviews stale 边界', () => {
  const aiOpinion = { author: 'cpf-manager', body: '【AI-Review】补个单测', created_at: '2026-09-04T10:00:00Z' };
  const pushReset = { author: 'openharmony_ci', body: '监测到PR: x 代码有更新,当前正在执行的门禁任务已自动中止', created_at: '2026-09-04T11:00:00Z' };
  const buildStart = { author: 'openharmony_ci', body: '本地或库上代码有更新,全量重新构建 门禁构建开始', created_at: '2026-09-04T11:30:00Z' };

  test('push 重置之后的意见是 actionable', () => {
    const freshOpinion = { author: 'cpf-manager', body: '【AI-Review】补个单测', created_at: '2026-09-04T12:00:00Z' };
    const result = selectActionableReviews([pushReset, freshOpinion]);
    expect(result.counts.actionable_count).toBe(1);
    expect(result.actionable[0]).toMatchObject({ kind: 'ai_review', stale: false });
  });

  test('push 重置之前的意见是 stale（已被新代码覆盖，bot 会重审）', () => {
    const result = selectActionableReviews([aiOpinion, pushReset]);
    expect(result.counts).toMatchObject({ actionable_count: 0, stale_count: 1 });
  });

  test('「门禁构建开始」响应不是版本边界，不产生 stale', () => {
    const result = selectActionableReviews([aiOpinion, buildStart]);
    expect(result.counts).toMatchObject({ actionable_count: 1, stale_count: 0 });
  });

  test('没有 push 重置时首轮意见全部 actionable', () => {
    const result = selectActionableReviews([aiOpinion]);
    expect(result.counts.actionable_count).toBe(1);
  });

  test('人工行内评论参与同样规则：重置前 stale、重置后 actionable', () => {
    const inlineBefore = { author: 'gaoyu321', body: '改成单引号', path: 'a.ets', line: 10, created_at: '2026-09-04T10:00:00Z' };
    const inlineAfter = { author: 'gaoyu321', body: '改成单引号', path: 'a.ets', line: 10, created_at: '2026-09-04T12:00:00Z' };
    expect(selectActionableReviews([inlineBefore, pushReset]).counts.stale_count).toBe(1);
    expect(selectActionableReviews([pushReset, inlineAfter]).counts.actionable_count).toBe(1);
  });

  test('--include-conversation 把人工顶层讨论也算意见', () => {
    const chatter = { author: 'gaoyu321', body: '整体思路 OK，但命名再想想', created_at: '2026-09-04T10:00:00Z' };
    expect(selectActionableReviews([chatter]).counts.actionable_count).toBe(0);
    expect(selectActionableReviews([chatter], { include_conversation: true }).counts.actionable_count).toBe(1);
  });
});

describe('push 时间边界（1914 限流期 push 假阳性修复）', () => {
  const review1457 = { author: 'cpf-manager', body: '【AI-Review】意见A', created_at: '2026-09-04T14:08:10+08:00' };
  const reviewLatest = { author: 'cpf-manager', body: '【AI-Review】意见B', created_at: '2026-09-04T16:30:00+08:00' };

  test('1914 实况：限流期 push（无 reset 评论）之后，针对旧代码的意见按 last_pushed_at 判 stale', () => {
    // 15:34 DCP 限流 → 15:44:52 push b47ff35a（CI 未发「代码有更新」）→ 14:08 的意见已修但旧边界看不见
    const result = selectActionableReviews([review1457], { last_pushed_at: '2026-09-04T15:44:52+08:00' });
    expect(result.counts).toMatchObject({ actionable_count: 0, stale_count: 1 });
    expect(result.stale[0]).toMatchObject({ stale_reason: 'pushed_after' });
  });

  test('push 之后的意见仍然 actionable', () => {
    const result = selectActionableReviews([review1457, reviewLatest], { last_pushed_at: '2026-09-04T15:44:52+08:00' });
    expect(result.counts.actionable_count).toBe(1);
    expect(result.actionable[0].body).toContain('意见B');
  });

  test('跨时区格式不能字典序比较：commit 的 Z 时间与评论的 +08:00 时间', () => {
    // 07:44:52Z = 15:44:52+08:00，晚于 14:08+08:00 的评论；
    // 字典序 '07' < '14' 会误判评论在 push 之后（假阳性），时间序才能判对
    expect('2026-09-04T07:44:52Z' > '2026-09-04T14:08:10+08:00').toBe(false); // 字典序给出错误答案
    expect(commentTimeLE('2026-09-04T14:08:10+08:00', '2026-09-04T07:44:52Z')).toBe(true); // 时间序：评论早于 push
    const result = selectActionableReviews([review1457], { last_pushed_at: '2026-09-04T07:44:52Z' });
    expect(result.counts.stale_count).toBe(1);
  });

  test('两条边界取并集：reset 在 11:00、push 在 12:00，11:30 的意见按 pushed_after 判 stale', () => {
    const reset = { author: 'openharmony_ci', body: '代码有更新,重置PR验证状态', created_at: '2026-09-04T11:00:00Z' };
    const midReview = { author: 'cpf-manager', body: '【AI-Review】意见C', created_at: '2026-09-04T11:30:00Z' };
    const result = selectActionableReviews([reset, midReview], { last_pushed_at: '2026-09-04T12:00:00Z' });
    expect(result.counts).toMatchObject({ actionable_count: 0, stale_count: 1 });
    expect(result.stale[0].stale_reason).toBe('pushed_after');
  });

  test('不传 last_pushed_at 时保持 reset 边界行为（向后兼容）', () => {
    const reset = { author: 'openharmony_ci', body: '代码有更新,重置PR验证状态', created_at: '2026-09-04T11:00:00Z' };
    const midReview = { author: 'cpf-manager', body: '【AI-Review】意见C', created_at: '2026-09-04T11:30:00Z' };
    expect(selectActionableReviews([reset, midReview]).counts.actionable_count).toBe(1);
  });
});

describe('fetch-ai-review 输出契约（下游 分流检视 只读 actionable_count）', () => {
  afterEach(() => {
    delete process.env.ACE_GITCODE_REVIEW_BOTS;
  });

  test('counts 字段齐备，actionable 条目带 kind/ai_review 标记', () => {
    const result = selectActionableReviews([
      { author: 'openharmony_ci', body: '代码有更新,重置PR验证状态', created_at: '2026-09-04T09:00:00Z' },
      { author: 'cpf-manager', body: '【AI-Review】意见', created_at: '2026-09-04T10:00:00Z' },
    ]);
    expect(result.counts).toHaveProperty('actionable_count');
    expect(result.counts).toHaveProperty('ai_review_count');
    expect(result.counts).toHaveProperty('stale_count');
    expect(result.counts).toHaveProperty('noise_filtered_count');
    expect(result.actionable[0].kind).toBe('ai_review');
  });
});
