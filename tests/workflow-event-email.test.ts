import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMailViaSmtp = vi.fn();

vi.mock('@/lib/notify/smtp-client', () => ({
  sendMailViaSmtp,
}));

const loadSystemSettings = vi.fn();

vi.mock('@/lib/config/system-settings', () => ({
  loadSystemSettings,
}));

const loadRunState = vi.fn();

vi.mock('@/lib/run/state-persistence', () => ({
  loadRunState,
}));

const getUserById = vi.fn();

const loadGateSummary = vi.fn();

vi.mock('@/lib/notify/gate-summary', () => ({
  loadGateSummary,
  gateStatusLine: (g: any) => g.__statusLine || '',
  gateChecklistLine: (g: any) => g.__checklist || '',
  gateFailureLines: (g: any) => g.__failure || [],
  gateNextStepLines: (g: any) => g.__next || [],
  buildWorkbenchUrl: (runId: string) => `https://example.test/dashboard?run=${runId}`,
}));

vi.mock('@/lib/core/user-store', () => ({
  getUserById,
}));

function mockSettings(overrides: Record<string, unknown> = {}) {
  loadSystemSettings.mockResolvedValue({
    emailNotifications: {
      enabled: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpSecure: true,
      fromEmail: 'bot@example.com',
      fromName: 'ACEHarness',
      ccEmails: 'team@example.com',
      subjectPrefix: '[ACE]',
      ...overrides,
    },
  });
}

describe('workflow state email notification', () => {
  beforeEach(async () => {
    loadGateSummary.mockReset();
    loadGateSummary.mockReturnValue(null);
    sendMailViaSmtp.mockReset();
    sendMailViaSmtp.mockResolvedValue(undefined);
    loadRunState.mockReset();
    getUserById.mockReset();
    loadSystemSettings.mockReset();
    mockSettings();
    // 模块内去重集合按 runId 去重，用例间用不同 runId 隔离，无需清空
  });

  it('进入就绪状态时给 run 所属人发邮件并抄送', async () => {
    loadRunState.mockResolvedValue({
      runOwnerId: 'user-1',
      globalContext: 'owner: CPF-Flutter\npr_url: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1906',
    });
    getUserById.mockResolvedValue({ id: 'user-1', email: 'zhanggong22@huawei.com' });

    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const result = await sendWorkflowStateEmailNotification({
      state: '就绪',
      message: '门禁已全绿',
      runId: 'run-1',
      __configFile: 'gitcode-pr-review.yaml',
    });

    expect(result.ok).toBe(true);
    expect(sendMailViaSmtp).toHaveBeenCalledTimes(1);
    const [config, input] = sendMailViaSmtp.mock.calls[0];
    expect(config).toMatchObject({ host: 'smtp.example.com', fromEmail: 'bot@example.com' });
    expect(input.to).toEqual(['zhanggong22@huawei.com']);
    expect(input.cc).toEqual(['team@example.com']);
    expect(input.subject).toContain('flutter_flutter#1906');
    expect(input.subject).toContain('gitcode-pr-review');
    expect(input.subject).not.toContain('就绪');
    expect(input.text).toContain('就绪');
    expect(input.text).toContain('https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1906');
    expect(input.text).toContain('评论 submit');
    expect(input.messageId).toMatch(/^<[^>]+>$/);
  });

  it('普通中间状态（等待门禁/分类处置）不发邮件', async () => {
    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const result = await sendWorkflowStateEmailNotification({
      state: '等待门禁',
      message: 'CI 还在跑',
      runId: 'run-2',
      __configFile: 'gitcode-pr-review.yaml',
    });
    expect(result).toMatchObject({ ok: false, reason: 'state-not-notified' });
    expect(sendMailViaSmtp).not.toHaveBeenCalled();
  });

  it('同一 run 重复进入同一状态只发一次（去重）', async () => {
    loadRunState.mockResolvedValue({ runOwnerId: 'user-1' });
    getUserById.mockResolvedValue({ id: 'user-1', email: 'zhanggong22@huawei.com' });

    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const first = await sendWorkflowStateEmailNotification({
      state: '完成',
      message: 'run 结束',
      runId: 'run-dedupe',
      __configFile: 'gitcode-pr-review.yaml',
    });
    const second = await sendWorkflowStateEmailNotification({
      state: '完成',
      message: 'run 结束（重复事件）',
      runId: 'run-dedupe',
      __configFile: 'gitcode-pr-review.yaml',
    });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: true, reason: 'already-sent' });
    expect(sendMailViaSmtp).toHaveBeenCalledTimes(1);
  });

  it('notifyStates 可自定义：加进列表的自定义状态会发', async () => {
    mockSettings({ notifyStates: '人工确认, 人工复核' });
    loadRunState.mockResolvedValue({ runOwnerId: 'user-1' });
    getUserById.mockResolvedValue({ id: 'user-1', email: 'zhanggong22@huawei.com' });

    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const result = await sendWorkflowStateEmailNotification({
      state: '人工复核',
      runId: 'run-custom',
      __configFile: 'demo.yaml',
    });
    expect(result.ok).toBe(true);
    expect(sendMailViaSmtp).toHaveBeenCalledTimes(1);
  });

  it('邮件开关关闭时跳过', async () => {
    mockSettings({ enabled: false });
    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const result = await sendWorkflowStateEmailNotification({
      state: '就绪',
      runId: 'run-off',
      __configFile: 'demo.yaml',
    });
    expect(result).toMatchObject({ ok: false, reason: 'email-disabled' });
    expect(sendMailViaSmtp).not.toHaveBeenCalled();
  });

  it('SMTP 配置不完整时跳过并给出原因', async () => {
    mockSettings({ smtpHost: '' });
    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const result = await sendWorkflowStateEmailNotification({
      state: '就绪',
      runId: 'run-incomplete',
      __configFile: 'demo.yaml',
    });
    expect(result).toMatchObject({ ok: false, reason: 'email-config-incomplete' });
  });

  it('查不到 run 所属人邮箱时仅抄送；无任何收件人则跳过', async () => {
    loadRunState.mockResolvedValue({ runOwnerId: 'ghost' });
    getUserById.mockResolvedValue(undefined);

    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const ccOnly = await sendWorkflowStateEmailNotification({
      state: '终止',
      runId: 'run-cc-only',
      __configFile: 'demo.yaml',
    });
    expect(ccOnly.ok).toBe(true);
    expect(sendMailViaSmtp.mock.calls[0][1].to).toEqual([]);
    expect(sendMailViaSmtp.mock.calls[0][1].cc).toEqual(['team@example.com']);

    mockSettings({ ccEmails: '' });
    const none = await sendWorkflowStateEmailNotification({
      state: '终止',
      runId: 'run-none',
      __configFile: 'demo.yaml',
    });
    expect(none).toMatchObject({ ok: false, reason: 'no-recipients' });
  });
  it('门禁失败时邮件包含结构化结论：状态清单 / 失败原因 / 下一步', async () => {
    loadRunState.mockResolvedValue({
      runOwnerId: 'user-1',
      globalContext: 'owner: CPF-Flutter\npr_url: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/2011',
    });
    getUserById.mockResolvedValue({ id: 'user-1', email: 'zhanggong22@huawei.com' });
    loadGateSummary.mockReturnValue({
      phase: 'compile_failed',
      __statusLine: '❌ 编译失败',
      __checklist: 'DCO ✓   静态 ✓   编译 ✗   冒烟 ✗（超时）',
      __failure: ['原因分类: 编译失败', '失败环节:', '  · test_flutter: compile failed'],
      __next: ['start build 重试预算已用尽（8/3）。'],
    });

    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const result = await sendWorkflowStateEmailNotification({
      state: '终止',
      message: '进入状态: 终止',
      runId: 'run-fail-1',
      __configFile: 'gitcode-pr-review.yaml',
    });

    expect(result.ok).toBe(true);
    const [, input] = sendMailViaSmtp.mock.calls[0];
    expect(input.text).toContain('#2011');
    expect(input.text).toContain('终止');
    expect(input.text).toContain('❌ 编译失败');
    expect(input.text).toContain('DCO ✓');
    expect(input.text).toContain('编译 ✗');
    expect(input.text).toContain('原因分类: 编译失败');
    expect(input.text).toContain('失败环节');
    expect(input.text).toContain('compile failed');
    expect(input.text).toContain('下一步');
    expect(input.text).toContain('重试预算已用尽');
    expect(input.text).toContain('https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/2011');
    expect(input.text).toContain('运行详情');
  });

  it('门禁全绿（就绪）邮件包含"还差什么"清单', async () => {
    loadRunState.mockResolvedValue({
      runOwnerId: 'user-1',
      globalContext: 'pr_url: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1958',
    });
    getUserById.mockResolvedValue({ id: 'user-1', email: 'zhanggong22@huawei.com' });
    loadGateSummary.mockReturnValue({
      phase: 'green',
      __statusLine: '✅ 门禁全绿',
      __checklist: 'DCO ✓   静态 ✓   编译 ✓   冒烟 ✓',
      __failure: [],
      __next: [],
    });

    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const result = await sendWorkflowStateEmailNotification({
      state: '就绪',
      runId: 'run-green-1',
      __configFile: 'gitcode-pr-review.yaml',
    });
    expect(result.ok).toBe(true);
    const [, input] = sendMailViaSmtp.mock.calls[0];
    expect(input.text).toContain('✅ 门禁全绿');
    expect(input.text).toContain('还差什么');
    expect(input.text).toContain('输入 submit');
    expect(input.text).not.toContain('失败原因');
  });
});

describe('parseEmailNotifyStates', () => {
  it('默认就绪/完成/终止，支持中英文分隔符', async () => {
    const { parseEmailNotifyStates, DEFAULT_EMAIL_NOTIFY_STATES } = await import('@/lib/notify/workflow-event-email');
    expect(DEFAULT_EMAIL_NOTIFY_STATES).toEqual(['就绪', '完成', '终止']);
    expect(parseEmailNotifyStates(undefined)).toEqual(['就绪', '完成', '终止']);
    expect(parseEmailNotifyStates('就绪、完成；终止, 人工确认')).toEqual(['就绪', '完成', '终止', '人工确认']);
    expect(parseEmailNotifyStates('  ')).toEqual(['就绪', '完成', '终止']);
  });

  it('PR 已合入的终止邮件：显示成功终点，不出现"失败"字样', async () => {
    loadRunState.mockResolvedValue({
      runOwnerId: 'user-1',
      globalContext: 'pr_url: https://gitcode.com/CPF-Flutter/flutter_engine/merge_requests/1531',
    });
    getUserById.mockResolvedValue({ id: 'user-1', email: 'cj@example.com' });
    loadGateSummary.mockReturnValue({
      phase: 'unknown',
      merged: true,
      closed: true,
      __statusLine: '✅ PR 已合入（监控圆满结束）',
      __checklist: 'DCO ✓   静态 ✓   编译 ✓   冒烟 ·',
      __failure: ['门禁报告: http://example.test/report'],
      __next: ['PR 已成功合入，监控正常结束，无需任何操作。'],
    });

    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const result = await sendWorkflowStateEmailNotification({
      state: '终止',
      runId: 'run-merged-1',
      __configFile: 'gitcode-pr-review.yaml',
    });

    expect(result.ok).toBe(true);
    const [, input] = sendMailViaSmtp.mock.calls.at(-1);
    expect(input.text).toContain('✅ PR 已合入');
    expect(input.text).toContain('监控正常结束，无需任何操作');
    expect(input.text).not.toContain('失败原因');
    expect(input.text).not.toContain('失败明细');
    expect(input.text).toContain('#1531');
  });
});
