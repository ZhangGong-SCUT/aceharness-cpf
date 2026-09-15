import { getUserById } from '@/lib/core/user-store';
import { loadRunState } from '@/lib/run/state-persistence';
import type { HumanQuestion } from '@/lib/run/state-persistence';
import { loadSystemSettings } from '@/lib/config/system-settings';
import { sendMailViaSmtp } from '@/lib/notify/smtp-client';
import { buildThreadHeaders, buildWorkflowEmailSubject, resolveEmailThreadKey } from '@/lib/notify/email-thread';
import {
  buildWorkbenchUrl,
  gateChecklistLine,
  gateFailureLines,
  gateStatusLine,
  loadGateSummary,
} from '@/lib/notify/gate-summary';

const deliveredQuestionIds = new Set<string>();

function splitEmailList(raw?: string): string[] {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractPrUrl(globalContext?: string): string {
  const match = String(globalContext || '').match(/pr_url:\s*(\S+)/);
  return match?.[1] || '';
}

function buildBody(question: HumanQuestion, prUrl: string): string {
  const gate = /gitcode-pr-review/i.test(String(question.configFile || '')) && question.runId
    ? loadGateSummary(question.runId)
    : null;

  // 人工审查事项正文过长（常为整段步骤结论），截取核心部分
  const message = String(question.message || '').trim();
  const trimmedMessage = message.length > 500 ? `${message.slice(0, 500)}…（已截断，完整内容见运行详情）` : message;

  const lines: string[] = [
    `【PR 自修监控】需人工处理: ${question.title || '未命名事项'}`,
    '',
  ];

  // PR 自修工作流：先给门禁结论（用户最关心的"过没过 / 差在哪"）
  if (gate) {
    lines.push(
      '■ 门禁状态',
      `  ${gateStatusLine(gate)}`,
      `  ${gateChecklistLine(gate)}`,
    );
    const failure = gateFailureLines(gate);
    if (failure.length) {
      lines.push('', '■ 失败原因（最新一轮 CI）');
      for (const f of failure) lines.push(`  ${f}`);
    }
    lines.push('');
  }

  lines.push(
    '■ 待你决策',
    `  ${question.title || '(无标题)'}`,
  );
  if (question.suggestedNextState) lines.push(`  建议下一步: ${question.suggestedNextState}`);
  if (trimmedMessage) lines.push('', trimmedMessage);
  if (question.supervisorAdvice) {
    const advice = String(question.supervisorAdvice).trim();
    lines.push('', `Supervisor 建议: ${advice.length > 300 ? `${advice.slice(0, 300)}…` : advice}`);
  }

  lines.push(
    '',
    '■ 链接',
    prUrl ? `  PR: ${prUrl}` : '',
    question.runId ? `  运行详情: ${buildWorkbenchUrl(question.runId)}` : '',
    '',
    '此任务正在等待人工审查，请前往工作流运行面板处理。',
  );
  return lines.filter((l) => l !== '').join('\n');
}

export async function sendHumanReviewEmailNotification(question: HumanQuestion): Promise<{ ok: boolean; reason?: string }> {
  if (!question?.id) return { ok: false, reason: 'missing-question-id' };
  if (deliveredQuestionIds.has(question.id)) return { ok: true, reason: 'already-sent' };
  // 挂起是「等 CI 结果、webhook 唤醒后自动恢复」的自动等待，不是真需要人工处理——
  // 发"需人工处理"邮件会误导（CJ 案例：等 CI 期间收到人工审查邮件）。真正的人工确认状态照发。
  if (String(question.currentState || '').trim() === '挂起') {
    return { ok: false, reason: 'parked-auto-resume' };
  }

  const settings = await loadSystemSettings();
  const emailSettings = settings.emailNotifications;
  if (!emailSettings?.enabled) return { ok: false, reason: 'email-disabled' };
  if (!emailSettings.smtpHost || !emailSettings.smtpPort || !emailSettings.fromEmail) {
    return { ok: false, reason: 'email-config-incomplete' };
  }

  const runState = question.runId ? await loadRunState(question.runId).catch(() => null) : null;
  const owner = runState?.runOwnerId ? await getUserById(runState.runOwnerId).catch(() => undefined) : undefined;
  const to = owner?.email ? [owner.email] : [];
  const cc = splitEmailList(emailSettings.ccEmails);
  if (to.length === 0 && cc.length === 0) {
    return { ok: false, reason: 'no-recipients' };
  }

  // 与状态里程碑邮件共用线程键与稳定主题：同一 PR/run 的所有通知折叠成一个会话
  const prUrl = extractPrUrl(runState?.globalContext);
  const threadKey = resolveEmailThreadKey({ runId: question.runId, globalContext: runState?.globalContext });
  const thread = buildThreadHeaders(threadKey, emailSettings.smtpHost);

  await sendMailViaSmtp({
    host: emailSettings.smtpHost,
    port: emailSettings.smtpPort,
    secure: emailSettings.smtpSecure,
    tlsInsecure: emailSettings.smtpTlsInsecure,
    username: emailSettings.smtpUsername,
    password: emailSettings.smtpPassword,
    fromEmail: emailSettings.fromEmail,
    fromName: emailSettings.fromName,
    replyTo: emailSettings.replyTo,
  }, {
    to,
    cc,
    subject: buildWorkflowEmailSubject(emailSettings.subjectPrefix, { configFile: question.configFile, prUrl }),
    text: buildBody(question, prUrl),
    messageId: thread.messageId,
    inReplyTo: thread.inReplyTo,
    references: thread.references,
    threadIndex: thread.threadIndex,
  });

  deliveredQuestionIds.add(question.id);
  return { ok: true };
}
