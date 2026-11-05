import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMailViaSmtp = vi.fn();

const loadGateSummary = vi.fn();

vi.mock('@/lib/notify/gate-summary', () => ({
  loadGateSummary,
  gateStatusLine: (g: any) => g.__statusLine || '',
  gateChecklistLine: (g: any) => g.__checklist || '',
  gateFailureLines: (g: any) => g.__failure || [],
  gateNextStepLines: (g: any) => g.__next || [],
  buildWorkbenchUrl: (runId: string) => `https://example.test/dashboard?run=${runId}`,
}));

vi.mock('@/lib/notify/smtp-client', () => ({
  sendMailViaSmtp,
}));

vi.mock('@/lib/config/system-settings', () => ({
  loadSystemSettings: vi.fn(async () => ({
    emailNotifications: {
      enabled: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpSecure: true,
      smtpUsername: 'bot@example.com',
      smtpPassword: 'secret',
      fromEmail: 'bot@example.com',
      fromName: 'ACEHarness',
      ccEmails: 'team@example.com; audit@example.com',
      subjectPrefix: '[ACE]',
    },
  })),
}));

vi.mock('@/lib/run/state-persistence', () => ({
  loadRunState: vi.fn(async () => ({
    runOwnerId: 'user-1',
  })),
}));

vi.mock('@/lib/core/user-store', () => ({
  getUserById: vi.fn(async () => ({
    id: 'user-1',
    email: 'owner@example.com',
  })),
}));

describe('human review email notification', () => {
  beforeEach(() => {
    sendMailViaSmtp.mockReset();
    sendMailViaSmtp.mockResolvedValue(undefined);
  });

  it('sends review email to run owner with configured cc recipients', async () => {
    const { sendHumanReviewEmailNotification } = await import('@/lib/notify/human-review-email');

    const result = await sendHumanReviewEmailNotification({
      id: 'hq-1',
      runId: 'run-1',
      configFile: 'demo.yaml',
      currentState: '__human_approval__',
      title: '等待人工审查',
      message: '请确认是否进入下一阶段',
      status: 'unanswered',
      kind: 'approval',
      createdAt: new Date().toISOString(),
      answerSchema: { type: 'text', required: true },
      source: { type: 'human-approval' },
    } as any);

    expect(result.ok).toBe(true);
    expect(sendMailViaSmtp).toHaveBeenCalledTimes(1);
    expect(sendMailViaSmtp).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com',
        fromEmail: 'bot@example.com',
      }),
      expect.objectContaining({
        to: ['owner@example.com'],
        cc: ['team@example.com', 'audit@example.com'],
        subject: expect.stringContaining('demo'),
        text: expect.stringContaining('等待人工审查'),
        messageId: expect.stringMatching(/^<[^>]+>$/),
      }),
    );
  });

  it('挂起进审批（previousState=挂起，pr1958 场景）不发邮件', async () => {
    const { sendHumanReviewEmailNotification } = await import('@/lib/notify/human-review-email');
    const result = await sendHumanReviewEmailNotification({
      id: 'hq-parked-approval-' + Date.now(),
      currentState: '__human_approval__',   // 审批中 currentState 恒为此值
      previousState: '挂起',               // 来源状态才是判定依据
      title: '等待人工审查',
      message: '建议放行',
    } as any);
    expect(result).toMatchObject({ ok: false, reason: 'parked-auto-resume' });
  });

  it('真人工确认（previousState=人工确认）照发邮件', async () => {
    const { sendHumanReviewEmailNotification } = await import('@/lib/notify/human-review-email');
    const result = await sendHumanReviewEmailNotification({
      id: 'hq-real-approval-' + Date.now(),
      currentState: '__human_approval__',
      previousState: '人工确认',            // 非「挂起」来源 → 真需人处理
      title: '等待人工审查',
      message: '测试失败需人工决策',
    } as any);
    // 无收件人配置时应因 no-recipients 返回（而不是 parked 被跳过）
    expect(result.reason).not.toBe('parked-auto-resume');
  });

  it('挂起（自动等待 CI）不发人工审查邮件', async () => {
    const { sendHumanReviewEmailNotification } = await import('@/lib/notify/human-review-email');
    const result = await sendHumanReviewEmailNotification({
      id: 'hq-park-1',
      runId: 'run-park',
      configFile: 'gitcode-pr-review.yaml',
      currentState: '挂起',
      title: '记录挂起',
      message: '等待 CI 结果',
    } as any);
    expect(result).toMatchObject({ ok: false, reason: 'parked-auto-resume' });
    expect(sendMailViaSmtp).not.toHaveBeenCalled();
  });
});
