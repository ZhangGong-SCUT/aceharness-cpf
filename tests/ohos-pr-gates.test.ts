import { describe, expect, test } from 'vitest';
import { classifyOhosPrGates, routeClassifyState } from '../skills/gitcode-pr-review/scripts/ohos-pr-gates.mjs';
import { decideGitcodeWebhookRun } from '@/lib/workflow/gitcode-pr-wake';
import { parseGitcodeWebhookPayload } from '@/lib/workflow/pr-review-input';

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

  test('green labels do not require AI已检视', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查成功', '编译成功', 'AI未检视'],
      comments: [
        { author: 'dev', body: 'start build' },
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

  test('returns 409 semantics when another PR holds the yaml lock', () => {
    const decision = decideGitcodeWebhookRun({
      incoming,
      running: {
        runId: 'run-2',
        status: 'running',
        currentState: '等待门禁',
        globalContext: 'owner: CPF-Flutter\nrepo: flutter_flutter\nnumber: 1910',
      },
    });
    expect(decision.action).toBe('busy-other-pr');
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
