import { describe, it, expect, vi, beforeEach } from 'vitest';

/* 被测函数会动态 import 依赖链（user-store / state-persistence / system-settings / smtp-client），
 * 全部 mock 掉：只验证门控与收件逻辑，不触网。 */
vi.mock('@/lib/core/user-store', () => ({
  getUserById: vi.fn(async (id: string) =>
    id === 'owner-1' ? { id: 'owner-1', email: 'owner@example.com' } : undefined),
}));
vi.mock('@/lib/run/state-persistence', () => ({
  loadRunState: vi.fn(async (runId: string) => ({
    runOwnerId: runId === 'run-with-owner' ? 'owner-1' : '',
    globalContext: 'pr_url: https://gitcode.com/o/r/merge_requests/1958\n',
  })),
}));
vi.mock('@/lib/config/system-settings', () => ({
  loadSystemSettings: vi.fn(async () => ({
    emailNotifications: {
      enabled: true,
      smtpHost: 'smtp.test', smtpPort: '465', fromEmail: 'from@test',
      subjectPrefix: '[ACE]', notifyStates: '就绪, 完成, 终止', ccEmails: 'cc1@test',
    },
  })),
}));
vi.mock('@/lib/notify/smtp-client', () => ({
  sendMailViaSmtp: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/notify/gate-summary', () => ({
  buildWorkbenchUrl: () => 'http://wb/run',
  gateChecklistLine: () => '', gateFailureLines: () => [], gateNextStepLines: () => [],
  gateStatusLine: () => '', loadGateSummary: () => null,
}));

import { sendWorkflowRunFailureEmailNotification } from '@/lib/notify/workflow-event-email';
import { sendMailViaSmtp } from '@/lib/notify/smtp-client';

describe('sendWorkflowRunFailureEmailNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('failed 状态发送邮件（绕过 notifyStates）', async () => {
    const r = await sendWorkflowRunFailureEmailNotification({
      status: 'failed', runId: 'run-with-owner', __configFile: 'cpf-ohos-diagnosis.yaml',
      message: '引擎异常，已停止工作流',
    });
    expect(r.ok).toBe(true);
    expect(sendMailViaSmtp).toHaveBeenCalledTimes(1);
    const [, mail] = (sendMailViaSmtp as any).mock.calls[0];
    expect(mail.to).toEqual(['owner@example.com']);
    expect(mail.cc).toEqual(['cc1@test']);
    expect(mail.text).toContain('运行失败');
    expect(mail.text).toContain('引擎异常，已停止工作流');
  });

  it('非失败状态不发送', async () => {
    for (const status of ['running', 'preparing', 'completed', 'stopped', 'idle', '']) {
      const r = await sendWorkflowRunFailureEmailNotification({ status, runId: 'run-with-owner' });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('status-not-failure');
    }
    expect(sendMailViaSmtp).not.toHaveBeenCalled();
  });

  it('同 run 同状态去重（failed 只发一次）', async () => {
    const payload = { status: 'failed', runId: 'run-dedupe-1', __configFile: 'x.yaml' };
    const first = await sendWorkflowRunFailureEmailNotification(payload);
    const second = await sendWorkflowRunFailureEmailNotification(payload);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: true, reason: 'already-sent' });
    expect(sendMailViaSmtp).toHaveBeenCalledTimes(1);
  });

  it('crashed 状态同样发送（文案区分）', async () => {
    const r = await sendWorkflowRunFailureEmailNotification({
      status: 'crashed', runId: 'run-with-owner', __configFile: 'gitcode-pr-review.yaml',
    });
    expect(r.ok).toBe(true);
    expect((sendMailViaSmtp as any).mock.calls[0][1].text).toContain('运行崩溃');
  });

  it('缺 runId 不发送', async () => {
    const r = await sendWorkflowRunFailureEmailNotification({ status: 'failed' });
    expect(r).toEqual({ ok: false, reason: 'missing-run-id' });
    expect(sendMailViaSmtp).not.toHaveBeenCalled();
  });
});
