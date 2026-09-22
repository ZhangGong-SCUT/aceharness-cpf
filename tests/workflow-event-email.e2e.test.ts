import { mkdir, rm, writeFile } from 'fs/promises';
import { describe, expect, it } from 'vitest';
import { getWorkspaceRunsDir } from '@/lib/core/app-paths';
import { join } from 'path';

/**
 * E2E：真实 SMTP 投递（不 mock）。默认跳过，显式开启：
 *   ACE_EMAIL_E2E=1 npx vitest run tests/workflow-event-email.e2e.test.ts
 * 前置：~/.aceharness/data/system-settings.yaml 已配置可用 SMTP；
 * 收件人 = 临时 run 的所属人（本用例固定为 zhanggong，zhanggong22@huawei.com）。
 */
describe.skipIf(!process.env.ACE_EMAIL_E2E)('workflow state email E2E (real SMTP)', () => {
  it('向 zhanggong 的邮箱投递一封「就绪」状态邮件', async () => {
    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const { loadSystemSettings } = await import('@/lib/config/system-settings');
    const { getUserById } = await import('@/lib/core/user-store');

    const settings = await loadSystemSettings();
    expect(settings.emailNotifications?.enabled).toBe(true);
    expect(settings.emailNotifications?.smtpHost).toBeTruthy();

    // zhanggong（收件人）作为临时 run 的所属人
    const ZHANGGONG_USER_ID = 'f7798c97-4ddf-48bf-ab73-199c4618fe82';
    const zhanggong = await getUserById(ZHANGGONG_USER_ID);
    expect(zhanggong?.email).toBe('zhanggong22@huawei.com');

    const runId = `run-email-e2e-${Date.now()}`;
    const runDir = join(getWorkspaceRunsDir(), runId);
    await mkdir(runDir, { recursive: true });
    try {
      await writeFile(join(runDir, 'state.yaml'), [
        `runId: ${runId}`,
        'status: completed',
        `runOwnerId: ${ZHANGGONG_USER_ID}`,
        'configFile: gitcode-pr-review.yaml',
        'globalContext: |',
        '  owner: CPF-Flutter',
        '  repo: flutter_flutter',
        '  number: 1906',
        '  pr_url: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1906',
        '',
      ].join('\n'), 'utf-8');

      const result = await sendWorkflowStateEmailNotification({
        state: '就绪',
        message: '门禁已全绿（E2E 邮件测试：DCO/静态检查/编译/冒烟测试全部通过）',
        runId,
        __configFile: 'gitcode-pr-review.yaml',
      });

      expect(result).toEqual({ ok: true });
    } finally {
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
