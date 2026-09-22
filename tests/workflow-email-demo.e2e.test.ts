import { mkdir, rm, writeFile } from 'fs/promises';
import { describe, expect, it } from 'vitest';
import { getWorkspaceRunsDir } from '@/lib/core/app-paths';
import { join } from 'path';

/**
 * 邮件会话线程演示（真实投递，不 mock）。默认跳过，显式开启：
 *   ACE_EMAIL_E2E=1 npx vitest run tests/workflow-email-demo.e2e.test.ts
 *
 * 模拟 PR 1906 的生命周期，向 zhanggong22@huawei.com 连发 4 封邮件：
 *   ① 人工审查（第 1 次挂起：start build 后等 CI）——线程根
 *   ② 人工审查（重复事件 → 去重不发；唤醒后再次挂起 → 新 question 才发）
 *   ③ 状态里程碑（就绪：门禁全绿）
 *   ④ 状态里程碑（完成：run 结束）
 * 所有邮件共用同一 PR 线程键与稳定主题 → 邮箱里折叠成一个会话。
 */
describe.skipIf(!process.env.ACE_EMAIL_E2E)('workflow email thread demo (real SMTP)', () => {
  it('演示：同一 PR 的全部通知归入一个邮件会话', async () => {
    const { sendHumanReviewEmailNotification } = await import('@/lib/notify/human-review-email');
    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const { resolveEmailThreadKey } = await import('@/lib/notify/email-thread');
    const { loadSystemSettings } = await import('@/lib/config/system-settings');
    const { getUserById } = await import('@/lib/core/user-store');

    const settings = await loadSystemSettings();
    expect(settings.emailNotifications?.enabled).toBe(true);

    const ZHANGGONG_USER_ID = 'f7798c97-4ddf-48bf-ab73-199c4618fe82';
    const zhanggong = await getUserById(ZHANGGONG_USER_ID);
    expect(zhanggong?.email).toBe('zhanggong22@huawei.com');

    const runId = `run-email-demo-${Date.now()}`;
    const runDir = join(getWorkspaceRunsDir(), runId);
    const globalContext = [
      'owner: CPF-Flutter',
      'repo: flutter_flutter',
      'number: 777',
      'pr_url: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/777',
    ].join('\n');
    await mkdir(runDir, { recursive: true });
    try {
      await writeFile(join(runDir, 'state.yaml'), [
        `runId: ${runId}`,
        'status: running',
        `runOwnerId: ${ZHANGGONG_USER_ID}`,
        'configFile: gitcode-pr-review.yaml',
        'currentState: 挂起',
        `globalContext: |\n${globalContext.split('\n').map((l) => `  ${l}`).join('\n')}`,
        '',
      ].join('\n'), 'utf-8');

      // ── 线程键一致性：人工审查邮件与状态邮件必须归入同一会话 ──────────────
      const stateThreadKey = resolveEmailThreadKey({ runId, globalContext });
      expect(stateThreadKey).toBe('pr-cpf-flutter/flutter_flutter#777');

      // ── ① 第 1 次挂起（线程根）──────────────────────────────────────────
      const parkQuestion = {
        id: `hq-park-1-${Date.now()}`,
        runId,
        configFile: 'gitcode-pr-review.yaml',
        currentState: '__human_approval__',
        previousState: '等待门禁',
        title: '等待人工审查',
        message: '已评论 start build，DCP 门禁构建中（预计 60 分钟）。Webhook 唤醒后将继续。',
        status: 'unanswered',
        kind: 'approval',
        createdAt: new Date().toISOString(),
        answerSchema: { type: 'approval-transition', required: true, options: [] },
        source: { type: 'checkpoint-advice', fromState: '等待门禁', suggestedNextState: '挂起' },
      } as any;
      const first = await sendHumanReviewEmailNotification(parkQuestion);
      expect(first.ok).toBe(true);

      // ── ② 同一次挂起的重复事件 → 去重；再次挂起（新 question）→ 会话内第二封 ─
      const duplicate = await sendHumanReviewEmailNotification(parkQuestion);
      expect(duplicate).toMatchObject({ ok: true, reason: 'already-sent' });
      const secondPark = await sendHumanReviewEmailNotification({ ...parkQuestion, id: `hq-park-2-${Date.now()}` });
      expect(secondPark.ok).toBe(true);

      // ── ③ 就绪（会话内第三封）───────────────────────────────────────────
      const ready = await sendWorkflowStateEmailNotification({
        state: '就绪',
        message: '门禁全绿（DCO/静态检查/编译/冒烟测试通过）。',
        runId,
        __configFile: 'gitcode-pr-review.yaml',
      });
      expect(ready).toEqual({ ok: true });

      // ── ④ 完成（会话内第四封；同状态重复事件去重）────────────────────────
      const done = await sendWorkflowStateEmailNotification({
        state: '完成',
        message: '已推送修复 4 个 commit。未 submit、未合入，等待作者评审。',
        runId,
        __configFile: 'gitcode-pr-review.yaml',
      });
      expect(done).toEqual({ ok: true });
      const doneAgain = await sendWorkflowStateEmailNotification({
        state: '完成',
        message: '重复事件',
        runId,
        __configFile: 'gitcode-pr-review.yaml',
      });
      expect(doneAgain).toMatchObject({ ok: true, reason: 'already-sent' });
    } finally {
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
