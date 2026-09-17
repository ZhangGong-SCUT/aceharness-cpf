import { describe, expect, test } from 'vitest';
import { classifyOhosPrGates, commentBelongsToPull, isFlakyTestFailure, routeClassifyState } from '../skills/gitcode-pr-review/scripts/ohos-pr-gates.mjs';
import { findQuoteCandidates, parsePatchAddedLines } from '../skills/gitcode-pr-review/scripts/scan-same-rule-defects.mjs';
import { decideGitcodeWebhookRun } from '@/lib/workflow/gitcode-pr-wake';
import { parseGitcodeWebhookPayload } from '@/lib/workflow/pr-review-input';
import { PR1978_GATE_FAIL_COMMENT } from './fixtures/pr1978-gate-comment';

describe('scan-same-rule-defects', () => {
  test('parses hunk headers and tracks new-file line numbers', () => {
    const added = parsePatchAddedLines([
      '@@ -180,10 +180,25 @@ class X',
      '    ctx line',
      '-    removed line',
      '+    const a = 1;',
      '+    const b = 2;',
      '    ctx2',
      '+    const c = 3;',
    ].join('\n'));
    expect(added).toEqual([
      { line: 181, text: '    const a = 1;' },
      { line: 182, text: '    const b = 2;' },
      { line: 184, text: '    const c = 3;' },
    ]);
  });

  test('flags double-quoted string literals on added lines, skips comments/imports/escapes', () => {
    const candidates = findQuoteCandidates([
      { line: 184, text: '      Log.i(TAG, "onRestoreInstanceState. Giving framework");' },
      { line: 185, text: "      Log.i(TAG, 'already single');" },
      { line: 186, text: '      // comment with "quotes" in prose' },
      { line: 187, text: "      import { Foo } from \"some-module\";" },
      { line: 188, text: '      const s = "it\'s escaped anyway";' },
    ]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ line: 184, needs_escape: false });
    expect(candidates[1]).toMatchObject({ line: 188, needs_escape: true });
  });
});

describe('classifyOhosPrGates', () => {
  test('does not start build before welcome comment', () => {
    const result = classifyOhosPrGates({
      labels: [],
      comments: [],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('running');
    expect(result.verdict).toBe('conditional_pass');
  });

  test('need_start_build after welcome and DCO, without waiting for AI review', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', 'AI检视中'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
      ],
      pull: { body: 'fix #1900' },
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('need_start_build');
    expect(result.verdict).toBe('pass');
  });

  test('recognizes HTML welcome comment from GitCode PR notes', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功'],
      comments: [
        {
          author: 'openharmony_ci',
          body: '<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>',
        },
      ],
      pull: { body: 'Fixes #2573' },
      state: 'open',
      own_pr: true,
    });
    expect(result.welcome).toBe(true);
    expect(result.phase).toBe('need_start_build');
  });

  test('does not treat repeated welcome as another start build if start build already exists', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查成功'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'zhong_ning', body: 'start build' },
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'openharmony_ci', body: '构建任务已开始' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('running');
  });

  test('static check failure wins while compile is still pending', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'dev', body: 'start build' },
        { author: 'openharmony_ci', body: '静态检查 noPass http://dcp.openharmony.cn/workbench/cicd/detail/1/runlist' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('static_failed');
    expect(result.report_url).toContain('dcp.openharmony.cn');
    expect(routeClassifyState('分流静态', result.phase)).toEqual({
      verdict: 'fail',
      next_state: '静态修复',
    });
    expect(routeClassifyState('分流编译', result.phase).next_state).toBe('分流测试');
  });

  test('smoke test pending stays running, not green (#1958 regression)', () => {
    // #1958 实际形态:DCO/静态/编译/AI 四绿,CI 评论写明构建包含测试,
    // 但「冒烟测试成功」label 一直没打——此前被误判 green 提前收口
    const result = classifyOhosPrGates({
      labels: ['AI已检视', 'dco检查成功', '编译成功', '静态检查成功'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'liujiake', body: 'start build' },
        { author: 'openharmony_ci', body: '部分构建失败,仅触发失败构建\n门禁构建开始,包含代码编译和测试【flutter_3.35.7-dev_flutter_integration 编译, flutter_3.35.7-dev_flutter_integration 测试】预计在60分钟内完成' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('running');
    expect(result.summary).toContain('冒烟测试');
  });

  test('five gates all green (incl. smoke test) reaches green', () => {
    const result = classifyOhosPrGates({
      labels: ['AI已检视', 'dco检查成功', '编译成功', '静态检查成功', '冒烟测试成功'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'dev', body: 'start build' },
        { author: 'openharmony_ci', body: '门禁构建开始,包含代码编译和测试,预计60分钟内完成' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('green');
  });

  test('compile-only gate (CI never mentions tests) still reaches green with four labels', () => {
    // 不含测试任务的门禁(纯编译仓库/流程)不受新约束影响,四绿即可
    const result = classifyOhosPrGates({
      labels: ['AI已检视', 'dco检查成功', '编译成功', '静态检查成功'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'dev', body: 'start build' },
        { author: 'openharmony_ci', body: '门禁构建开始,仅包含代码编译,预计30分钟内完成' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('green');
  });

  test('static failure with retry budget left reruns start build instead of fixing', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'huhaodong', body: 'start build' },
        { author: 'openharmony_ci', body: '首次触发 门禁构建开始,预计60分钟' },
        { author: 'openharmony_ci', body: '代码门禁未通过 静态检查 codeCheck noPass http://dcp.openharmony.cn/x/runlist' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('need_start_build');
    expect(result.start_build_count).toBe(1);
    expect(result.start_build_max).toBe(3);
    expect(routeClassifyState('分流触发', result.phase).next_state).toBe('推送并触发');
  });

  test('compile failure also retries start build while budget remains', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '编译失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'huhaodong', body: 'start build' },
        { author: 'openharmony_ci', body: '门禁构建开始' },
        { author: 'openharmony_ci', body: '代码门禁未通过 编译失败' },
        { author: 'huhaodong', body: 'start build' },
        { author: 'openharmony_ci', body: '部分构建失败,仅触发失败构建 门禁构建开始' },
        { author: 'openharmony_ci', body: '代码门禁未通过 编译失败' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('need_start_build');
    expect(result.start_build_count).toBe(2);
  });

  test('retry budget exhausted falls back to real failure phase', () => {
    const comments: any[] = [
      { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
    ];
    for (let i = 0; i < 3; i++) {
      comments.push({ author: 'huhaodong', body: 'start build' });
      comments.push({ author: 'openharmony_ci', body: '门禁构建开始' });
      comments.push({ author: 'openharmony_ci', body: '代码门禁未通过 静态检查失败' });
    }
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查失败'],
      comments,
      state: 'open',
      own_pr: true,
    });
    expect(result.start_build_count).toBe(3);
    expect(result.phase).toBe('static_failed');
    expect(routeClassifyState('分流静态', result.phase).next_state).toBe('静态修复');
  });

  test('new push resets the start build retry budget', () => {
    const comments: any[] = [
      { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
    ];
    for (let i = 0; i < 3; i++) {
      comments.push({ author: 'huhaodong', body: 'start build' });
      comments.push({ author: 'openharmony_ci', body: '门禁构建开始,预计在60分钟内完成' });
      comments.push({ author: 'openharmony_ci', body: '代码门禁未通过 静态检查失败' });
    }
    comments.push({ author: 'openharmony_ci', body: '代码有更新,重置PR验证状态 感谢提交 Pull Requests！' });
    comments.push({ author: 'huhaodong', body: 'start build' });
    comments.push({ author: 'openharmony_ci', body: '门禁构建开始,预计在60分钟内完成' });
    comments.push({ author: 'openharmony_ci', body: '代码门禁未通过 静态检查失败' });
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查失败'],
      comments,
      state: 'open',
      own_pr: true,
    });
    expect(result.start_build_count).toBe(1);
    expect(result.phase).toBe('need_start_build');
  });

  test('CI rebuild in flight keeps waiting instead of posting duplicate start build', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'huhaodong', body: 'start build' },
        { author: 'openharmony_ci', body: '代码门禁未通过 静态检查失败' },
        { author: 'huhaodong', body: 'start build' },
        { author: 'openharmony_ci', body: '门禁构建开始,预计60分钟' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('running');
    expect(result.verdict).toBe('conditional_pass');
  });

  test('DCP rate limit disables start build retry', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'huhaodong', body: 'start build' },
        { author: 'openharmony_dcp', body: '你因提交次数过多被限制提交，请先观看学习视频' },
        { author: 'openharmony_ci', body: '代码门禁未通过 静态检查失败' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.gate_rate_limited).toBe(true);
    expect(result.phase).toBe('static_failed');
  });

  test('custom start build max via input', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'huhaodong', body: 'start build' },
        { author: 'openharmony_ci', body: '门禁构建开始,预计在60分钟内完成' },
        { author: 'openharmony_ci', body: '代码门禁未通过 静态检查失败' },
      ],
      state: 'open',
      own_pr: true,
      start_build_max: 1,
    });
    expect(result.start_build_count).toBe(1);
    expect(result.phase).toBe('static_failed');
  });

  test('push reset isolates start build: aborted gate with stale comment re-triggers instead of waiting', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', 'AI已检视'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'huhaodong', body: 'start build', created_at: '2026-09-04T01:51:23Z' },
        { author: 'openharmony_ci', body: '监测到PR: x 代码有更新,当前正在执行的门禁任务已自动中止,如有需要,可重新触发', created_at: '2026-09-04T01:52:01Z' },
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！', created_at: '2026-09-04T01:52:18Z' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.start_build_posted).toBe(false);
    expect(result.phase).toBe('need_start_build');
    expect(result.verdict).toBe('pass');
  });

  test('CI build-start message is not a revision reset: running build keeps waiting', () => {
    // CI 对 start build 的响应「本地或库上代码有更新…门禁构建开始」不是版本重置，
    // 否则窗口会把紧邻其前的 start build 挤出去，误判 need_start_build 导致重复触发
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', 'AI已检视'],
      comments: [
        { author: 'openharmony_ci', body: '代码有更新,重置PR验证状态', created_at: '2026-09-04T02:47:00Z' },
        { author: 'huhaodong', body: 'start build', created_at: '2026-09-04T02:48:00Z' },
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！', created_at: '2026-09-04T02:49:00Z' },
        { author: 'openharmony_ci', body: '本地或库上代码有更新,全量重新构建,重置所有关联PR的验证状态 门禁构建开始,预计在60分钟内完成', created_at: '2026-09-04T02:49:10Z' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.start_build_posted).toBe(true);
    expect(result.start_build_count).toBe(1);
    expect(result.phase).toBe('running');
    expect(result.verdict).toBe('conditional_pass');
  });

  test('rejected start build (wrong user) does not count as gate running', () => {
    // 非 PR 提交人评论 start build 被 CI 拒：门禁从未跑过，必须重新触发（用作者自己的 token）
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', 'AI已检视'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'z2036709353', body: 'start build', created_at: '2026-09-03T11:16:00Z' },
        { author: 'openharmony_ci', body: '非PR提交人或管理员不允许触发门禁', created_at: '2026-09-03T11:16:05Z' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.trigger_rejected).toBe(true);
    expect(result.start_build_posted).toBe(false);
    expect(result.phase).toBe('need_start_build');
  });

  test("someone else's accepted start build runs the gate but does not consume the author's retry budget", () => {
    // 管理员触发了门禁且 CI 接受：门禁在跑（posted=true, phase=running），
    // 但不占 PR 作者的重试预算（start_build_count=0）
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', 'AI已检视'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'some-admin', body: 'start build', created_at: '2026-09-04T03:00:00Z' },
        { author: 'openharmony_ci', body: '门禁构建开始,预计在60分钟内完成', created_at: '2026-09-04T03:00:10Z' },
      ],
      pull: { user: { login: 'huhaodong' } },
      state: 'open',
      own_pr: true,
    });
    expect(result.start_build_posted).toBe(true);
    expect(result.start_build_count).toBe(0);
    expect(result.phase).toBe('running');
    expect(result.verdict).toBe('conditional_pass');
  });

  test('rate limit comment is stale once CI started a build after it', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'openharmony_dcp', body: '你因提交次数过多被限制提交，请先观看学习视频', created_at: '2026-09-04T01:54:02Z' },
        { author: 'huhaodong', body: 'start build', created_at: '2026-09-04T02:16:58Z' },
        { author: 'openharmony_ci', body: '部分构建失败,仅触发失败构建 门禁构建开始', created_at: '2026-09-04T02:17:20Z' },
        { author: 'openharmony_ci', body: '代码门禁未通过 静态检查 noPass', created_at: '2026-09-04T02:23:00Z' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.gate_rate_limited).toBe(false);
    // 无 DCP 明细输入时仍走抖动重试
    expect(result.phase).toBe('need_start_build');
    expect(result.start_build_count).toBe(1);
  });

  test('known DCP defects skip the flaky retry and go straight to static fix', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'huhaodong', body: 'start build', created_at: '2026-09-04T02:16:58Z' },
        { author: 'openharmony_ci', body: '部分构建失败,仅触发失败构建 门禁构建开始', created_at: '2026-09-04T02:17:20Z' },
        { author: 'openharmony_ci', body: '代码门禁未通过 静态检查 noPass', created_at: '2026-09-04T02:23:00Z' },
      ],
      state: 'open',
      own_pr: true,
      dcp_defect_count: 1,
    });
    expect(result.dcp_defect_count).toBe(1);
    expect(result.phase).toBe('static_failed');
    expect(routeClassifyState('分流静态', result.phase).next_state).toBe('静态修复');
  });

  test('static fail label wins over welcome-based need_start_build after push reset', () => {
    // push 后重置评论排在 start build 之后 → startBuildPosted=false、welcome=true、dcoOk=true
    // 但静态失败标签 + DCP 明细存在 → 必须 static_failed，不能 need_start_build（会重复触发）
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查失败', 'AI已检视'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'openharmony_ci', body: '代码有更新,重置PR验证状态', created_at: '2026-09-04T02:31:00Z' },
        { author: 'huhaodong', body: 'start build', created_at: '2026-09-04T02:31:10Z' },
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！', created_at: '2026-09-04T02:31:20Z' },
        { author: 'openharmony_ci', body: '本地或库上代码有更新,全量重新构建,重置所有关联PR的验证状态 门禁构建开始', created_at: '2026-09-04T02:31:30Z' },
        { author: 'openharmony_ci', body: '代码门禁未通过 静态检查 noPass https://dcp.openharmony.cn/x/runlist?pop=codecheck&taskId=MR_57e2395', created_at: '2026-09-04T02:38:00Z' },
      ],
      state: 'open',
      own_pr: true,
      dcp_defect_count: 1,
    });
    expect(result.phase).toBe('static_failed');
    expect(result.start_build_posted).toBe(true);
    expect(routeClassifyState('分类处置', result.phase).verdict).toBe('pass');
    expect(routeClassifyState('分流静态', result.phase).verdict).toBe('fail');
  });

  test('DCO failure is classified before anything else', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查失败'],
      comments: [
        { author: 'openharmony_ci', body: '此PR未通过DCO校验' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('dco_failed');
    expect(routeClassifyState('分类处置', result.phase)).toEqual({
      verdict: 'fail',
      next_state: 'DCO修复',
    });
  });

  test('historical DCO failure text goes stale after a clean welcome (1913 deadlock regression)', () => {
    // 邮箱问题修掉后：干净的新欢迎评论在旧失败文本之后 → DCO 应视为已通过
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '编译失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'huhaodong', body: 'start build' },
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！此PR未通过DCO校验。校验失败可能原因：1. 未签署DCO协议' },
        { author: 'huhaodong', body: 'start build' },
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！此PR未通过DCO校验。' },
        { author: 'openharmony_ci', body: '代码有更新,重置PR验证状态' },
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！ Thanks for submitting a pull request.' },
        { author: 'openharmony_ci', body: '门禁构建开始' },
        { author: 'openharmony_ci', body: '代码门禁未通过 编译失败' },
      ],
      pull: { user: { login: 'huhaodong' } },
      state: 'open',
      own_pr: true,
    });
    expect(result.dco_ok).toBe(true);
    expect(result.dco_fail).toBe(false);
    // 编译失败才是当前状态，不再误路由 DCO修复
    expect(result.phase).toBe('compile_failed');
    expect(routeClassifyState('分类处置', result.phase).next_state).toBe('分流静态');
  });

  test('test failure goes to human confirmation', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查成功', '编译成功', '冒烟测试失败'],
      comments: [
        { author: 'dev', body: 'start build' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('test_failed');
    expect(routeClassifyState('分流测试', result.phase).next_state).toBe('人工确认');
  });

  test('real-assertion test failure still goes to human confirmation even with retry budget', () => {
    // 混入真实断言失败（非 timeout）→ 不是抖动，不重试
    const realFailComment = PR1978_GATE_FAIL_COMMENT.replace('failed(ecotest timeout)', 'failed(expect 1 got 2)');
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查成功', '编译成功', '冒烟测试失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'dev', body: 'start build', created_at: '2026-09-09T09:58:00Z' },
        { author: 'openharmony_ci', body: '门禁构建开始,预计60分钟', created_at: '2026-09-09T09:59:00Z' },
        { author: 'openharmony_ci', body: realFailComment, created_at: '2026-09-09T11:13:00Z' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.test_flaky).toBe(false);
    expect(result.phase).toBe('test_failed');
  });

  test('pure ecotest-timeout test failure reuses retry budget instead of asking human (PR 1978)', () => {
    // 1978 真实 DCP 评论：编译全过，测试两处 ecotest timeout（一处 DCP 自标 IGNORE）
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查成功', '编译成功', '冒烟测试失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'dev', body: 'start build', created_at: '2026-09-09T09:58:00Z' },
        { author: 'openharmony_ci', body: '门禁构建开始,预计60分钟', created_at: '2026-09-09T09:59:00Z' },
        { author: 'openharmony_ci', body: PR1978_GATE_FAIL_COMMENT, created_at: '2026-09-09T11:13:00Z' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.test_flaky).toBe(true);
    expect(result.phase).toBe('need_start_build');
    expect(result.start_build_count).toBe(1);
    expect(routeClassifyState('分流触发', result.phase).next_state).toBe('推送并触发');
  });

  test('flaky failures beyond normal budget use jitter budget, stop only when jitter budget exhausted', () => {
    const comments: any[] = [{ author: 'openharmony_ci', body: '感谢提交 Pull Requests！' }];
    for (let i = 0; i < 3; i++) {
      comments.push({ author: 'dev', body: 'start build', created_at: `2026-09-09T1${i}:00:00Z` });
      comments.push({ author: 'openharmony_ci', body: '门禁构建开始,预计60分钟', created_at: `2026-09-09T1${i}:00:10Z` });
      comments.push({ author: 'openharmony_ci', body: PR1978_GATE_FAIL_COMMENT, created_at: `2026-09-09T1${i}:30:00Z` });
    }
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查成功', '编译成功', '冒烟测试失败'],
      comments,
      state: 'open',
      own_pr: true,
    });
    expect(result.test_flaky).toBe(true);
    expect(result.start_build_count).toBe(3);
    // 方案B：普通预算（3）尽但全为平台抖动 → 抖动预算（默认5）续命，继续重试
    expect(result.phase).toBe('need_start_build');
    expect(result.jitter_fail_count).toBe(3);
    expect(result.summary).toContain('抖动失败 3/5');

    // 抖动预算也用尽（5 次）→ 停下转人工
    for (let i = 3; i < 5; i++) {
      comments.push({ author: 'dev', body: 'start build', created_at: `2026-09-09T2${i}:00:00Z` });
      comments.push({ author: 'openharmony_ci', body: '门禁构建开始,预计60分钟', created_at: `2026-09-09T2${i}:00:10Z` });
      comments.push({ author: 'openharmony_ci', body: PR1978_GATE_FAIL_COMMENT, created_at: `2026-09-09T2${i}:30:00Z` });
    }
    const exhausted = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查成功', '编译成功', '冒烟测试失败'],
      comments,
      state: 'open',
      own_pr: true,
    });
    expect(exhausted.phase).toBe('test_failed');
    expect(exhausted.jitter_fail_count).toBe(5);
    expect(exhausted.summary).toContain('反馈 DCP');
  });

  test('stale test-fail label while CI reruns keeps waiting', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查成功', '编译成功', '冒烟测试失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'dev', body: 'start build', created_at: '2026-09-09T09:58:00Z' },
        { author: 'openharmony_ci', body: PR1978_GATE_FAIL_COMMENT, created_at: '2026-09-09T11:13:00Z' },
        { author: 'dev', body: 'start build', created_at: '2026-09-09T11:20:00Z' },
        { author: 'openharmony_ci', body: '门禁构建开始,预计60分钟', created_at: '2026-09-09T11:21:00Z' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('running');
    expect(result.verdict).toBe('conditional_pass');
  });

  test('isFlakyTestFailure: 裸 failed 与无门禁评论保守返回 false', () => {
    expect(isFlakyTestFailure([{ author: 'openharmony_ci', body: '代码门禁未通过 <td>failed</td>' }])).toBe(false);
    expect(isFlakyTestFailure([])).toBe(false);
    expect(isFlakyTestFailure([{ author: 'someone', body: '代码门禁未通过 failed(ecotest timeout)' }])).toBe(false); // 非 CI 机器人
  });

  test('green labels do not require AI已检视', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查成功', '编译成功', 'AI未检视'],
      comments: [
        { author: 'dev', body: 'start build' },
        { author: 'openharmony_ci', body: '门禁构建开始,预计在60分钟内完成' },
      ],
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('green');
    expect(routeClassifyState('分流触发', result.phase).next_state).toBe('就绪');
  });

  test('missing issue association after CI rejection blocks start build', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'openharmony_ci', body: '此PR必须关联 Issue 后才能 start build' },
      ],
      pull: { body: 'no issue link' },
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('blocked_no_issue');
  });
});

describe('decideGitcodeWebhookRun', () => {
  const incoming = {
    owner: 'CPF-Flutter',
    repo: 'flutter_flutter',
    number: '1900',
  };

  test('starts when nothing is running', () => {
    expect(decideGitcodeWebhookRun({ incoming }).action).toBe('start');
  });

  test('wakes the waiting run for the same PR', () => {
    const decision = decideGitcodeWebhookRun({
      incoming,
      running: {
        runId: 'run-1',
        status: 'running',
        currentState: '挂起',
        globalContext: 'owner: CPF-Flutter\nrepo: flutter_flutter\nnumber: 1900',
      },
    });
    expect(decision).toMatchObject({ action: 'wake', mode: 'resume-wait', runId: 'run-1' });
  });

  test('queues a snapshot when the same PR is mid-fix', () => {
    const decision = decideGitcodeWebhookRun({
      incoming,
      running: {
        runId: 'run-1',
        status: 'running',
        currentState: '静态修复',
        globalContext: 'owner: CPF-Flutter\nrepo: flutter_flutter\nnumber: 1900',
      },
    });
    expect(decision).toMatchObject({ action: 'wake', mode: 'queue' });
  });

  test('starts a parallel run for a different PR (multi-PR concurrency)', () => {
    const decision = decideGitcodeWebhookRun({
      incoming,
      running: {
        runId: 'run-2',
        status: 'running',
        currentState: '等待门禁',
        globalContext: 'owner: CPF-Flutter\nrepo: flutter_flutter\nnumber: 1910',
      },
    });
    expect(decision.action).toBe('start');
    expect(decision).toMatchObject({ activeCount: 1 });
  });

  test('wakes the matching run among several parallel runs by PR identity', () => {
    const decision = decideGitcodeWebhookRun({
      incoming,
      running: [
        {
          runId: 'run-a',
          status: 'running',
          currentState: '静态修复',
          globalContext: 'owner: CPF-Flutter\nrepo: flutter_flutter\nnumber: 1910',
        },
        {
          runId: 'run-b',
          status: 'running',
          currentState: '挂起',
          globalContext: 'owner: CPF-Flutter\nrepo: flutter_flutter\nnumber: 1900',
        },
      ],
    });
    expect(decision).toMatchObject({ action: 'wake', mode: 'resume-wait', runId: 'run-b' });
  });

  test('returns busy-parallel when the concurrency cap is reached', () => {
    const mk = (runId: string, number: string) => ({
      runId,
      status: 'running',
      currentState: '挂起',
      globalContext: `owner: CPF-Flutter\nrepo: flutter_flutter\nnumber: ${number}`,
    });
    const decision = decideGitcodeWebhookRun({
      incoming,
      maxParallel: 2,
      running: [mk('run-a', '1910'), mk('run-b', '1911')],
    });
    expect(decision.action).toBe('busy-parallel');
    expect(decision).toMatchObject({ activeCount: 2, runIds: ['run-a', 'run-b'] });
  });

  test('inactive snapshots do not count toward the cap', () => {
    const decision = decideGitcodeWebhookRun({
      incoming,
      maxParallel: 2,
      running: [
        { runId: 'run-stopped', status: 'completed', currentState: null, globalContext: 'owner: CPF-Flutter\nrepo: flutter_flutter\nnumber: 1910' },
        {
          runId: 'run-b',
          status: 'running',
          currentState: '挂起',
          globalContext: 'owner: CPF-Flutter\nrepo: flutter_flutter\nnumber: 1911',
        },
      ],
    });
    expect(decision.action).toBe('start');
  });
});

describe('parseGitcodeWebhookPayload head_repo', () => {
  test('keeps fork full name from source path', () => {
    const parsed = parseGitcodeWebhookPayload({
      object_kind: 'merge_request',
      action: 'update',
      user: { username: 'zhong_ning' },
      merge_request: {
        iid: 1900,
        title: 'fix',
        url: 'https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1900',
        source_branch: 'pr1881-split-b',
        target_branch: 'oh-3.44.9-dev',
        state: 'opened',
        source: { path_with_namespace: 'zhong_ning/flutter_flutter_xxx' },
      },
      project: { full_path: 'CPF-Flutter/flutter_flutter' },
    });
    expect(parsed.accepted).toBe(true);
    expect(parsed.input.headRepo).toBe('zhong_ning/flutter_flutter_xxx');
    expect(parsed.context).toContain('head_repo: zhong_ning/flutter_flutter_xxx');
  });
});

describe('commentBelongsToPull', () => {
  test('keeps GitCode PR notes and GitHub-style mocks', () => {
    expect(commentBelongsToPull({ comment_type: 'pr_comment', body: 'start build' })).toBe(true);
    expect(commentBelongsToPull({ user: { login: 'me' }, body: 'start build' })).toBe(true);
  });

  test('drops same-numbered Issue DiscussionNote', () => {
    expect(commentBelongsToPull({
      comment_type: 'DiscussionNote',
      body: 'start build',
      target: { issue: { id: 4044338, number: '1913', title: 'chore pipeline' } },
    })).toBe(false);
  });
});
