import { getUserById } from '@/lib/core/user-store';
import { loadRunState } from '@/lib/run/state-persistence';
import { loadSystemSettings } from '@/lib/config/system-settings';
import { sendMailViaSmtp } from '@/lib/notify/smtp-client';
import { buildThreadHeaders, buildWorkflowEmailSubject, resolveEmailThreadKey } from '@/lib/notify/email-thread';
import {
  buildWorkbenchUrl,
  gateChecklistLine,
  gateFailureLines,
  gateNextStepLines,
  gateStatusLine,
  loadGateSummary,
  type GateSummary,
} from '@/lib/notify/gate-summary';

const deliveredStateKeys = new Set<string>();

/** 默认发邮件的状态：需要人行动的终点（就绪=门禁全绿等人评审；完成/终止=run 结束）。
 *  人工确认/挂起不发这里——requireHumanApproval 状态走 human-approval-required 已有邮件。 */
export const DEFAULT_EMAIL_NOTIFY_STATES = ['就绪', '完成', '终止'];

export function parseEmailNotifyStates(raw?: string): string[] {
  const list = String(raw || '')
    .split(/[,，、;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_EMAIL_NOTIFY_STATES];
}

function splitEmailList(raw?: string): string[] {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface WorkflowStateEmailPayload {
  state?: string;
  message?: string;
  runId?: string;
  __configFile?: string;
  configFile?: string;
  currentConfigFile?: string;
}

export interface WorkflowStateEmailResult {
  ok: boolean;
  reason?: string;
}

function extractPrUrl(globalContext?: string): string {
  const match = String(globalContext || '').match(/pr_url:\s*(\S+)/);
  return match?.[1] || '';
}

function buildBody(input: {
  state: string;
  message: string;
  configFile: string;
  runId: string;
  prUrl: string;
  ownerEmail: string;
  gate: GateSummary | null;
}): string {
  // PR 自修工作流：结构化邮件（门禁结论 / 失败原因 / 下一步 / 链接）
  if (input.gate) {
    const gate = input.gate;
    const prMatch = input.prUrl.match(/([^/\s]+)\/(?:pulls?|merge_requests)\/(\d+)/i);
    const title = prMatch ? `${prMatch[1]} #${prMatch[2]}` : (input.configFile || '工作流');
    const lines: string[] = [
      `【${title} · PR 自修监控】${input.state}`,
      '',
      '■ 门禁状态',
      `  ${gateStatusLine(gate)}`,
      `  ${gateChecklistLine(gate)}`,
    ];

    if (gate.merged || gate.closed) {
      // PR 已合入/已关闭：监控自然终点，不渲染"失败原因"（成功合入是圆满结局，不是失败）
      lines.push(
        '',
        '■ 结果',
        gate.merged
          ? '  PR 已成功合入，监控正常结束，无需任何操作。'
          : '  PR 已关闭（未合入），监控结束。若在 GitCode 重新打开后可再开启监控。',
      );
    } else if (gate.phase === 'green' || input.state === '就绪') {
      lines.push(
        '',
        '■ 还差什么（即可合入）',
        '  1. 评审人在 GitCode PR 页完成审批',
        '  2. 测试人完成审批',
        '  3. 你本人在 PR 评论框输入 submit',
        '  说明: 工作流不会自动 submit / 合入',
      );
    } else {
      const failure = gateFailureLines(gate);
      if (failure.length) {
        lines.push('', '■ 失败原因（最新一轮 CI）');
        for (const f of failure) lines.push(`  ${f}`);
      }
      const next = gateNextStepLines(gate);
      if (next.length) {
        lines.push('', '■ 下一步');
        for (const n of next) lines.push(`  ${n}`);
      }
    }

    lines.push(
      '',
      '■ 链接',
      input.prUrl ? `  PR: ${input.prUrl}` : '',
      `  运行详情: ${buildWorkbenchUrl(input.runId)}`,
      '',
      `── run ${input.runId} · ${input.configFile} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    );
    return lines.filter((l) => l !== '').join('\n');
  }

  // 其他工作流（无 gate-check 产物）：保持原有简洁文案
  return [
    'ACEHarness 工作流进入了需要关注的状态。',
    '',
    `状态: ${input.state}`,
    `消息: ${input.message || '(无)'}`,
    `工作流配置: ${input.configFile || '未知'}`,
    `运行 ID: ${input.runId || '未知'}`,
    input.prUrl ? `关联 PR: ${input.prUrl}` : '',
    '',
    input.state === '就绪'
      ? '门禁已全绿：请前往评审，确认后自行评论 submit 合入（工作流不会自动 submit）。'
      : '请前往 ACEHarness 工作流运行面板查看详情。',
    '',
    `收件人: ${input.ownerEmail}`,
  ].filter(Boolean).join('\n');
}

/**
 * state-change 事件的邮件通知：进入 notifyStates 里的状态时发给 run 所属人 + cc。
 * 与 human-review-email（人工审查问题）互补，覆盖「就绪/完成/终止」这类里程碑。
 * 去重键 = run+状态：同一 run 重复进入同一状态只发一次（内存级，重启后重置）。
 */
export async function sendWorkflowStateEmailNotification(
  payload: WorkflowStateEmailPayload,
): Promise<WorkflowStateEmailResult> {
  const state = String(payload?.state || '').trim();
  if (!state) return { ok: false, reason: 'missing-state' };

  const settings = await loadSystemSettings();
  const emailSettings = settings.emailNotifications;
  if (!emailSettings?.enabled) return { ok: false, reason: 'email-disabled' };
  if (!emailSettings.smtpHost || !emailSettings.smtpPort || !emailSettings.fromEmail) {
    return { ok: false, reason: 'email-config-incomplete' };
  }

  const notifyStates = parseEmailNotifyStates(emailSettings.notifyStates);
  if (!notifyStates.includes(state)) return { ok: false, reason: 'state-not-notified' };

  const runId = String(payload?.runId || '').trim();
  const configFile = String(
    payload?.__configFile || payload?.configFile || payload?.currentConfigFile || '',
  ).trim();
  const dedupeKey = `${runId || configFile}:${state}`;
  if (deliveredStateKeys.has(dedupeKey)) return { ok: true, reason: 'already-sent' };

  const runState = runId ? await loadRunState(runId).catch(() => null) : null;
  const ownerId = String(runState?.runOwnerId || runState?.createdBy || '').trim();
  const owner = ownerId ? await getUserById(ownerId).catch(() => undefined) : undefined;
  const ownerEmail = String(owner?.email || '').trim();
  const cc = splitEmailList(emailSettings.ccEmails);
  if (!ownerEmail && cc.length === 0) {
    return { ok: false, reason: 'no-recipients' };
  }

  const prUrl = extractPrUrl(runState?.globalContext);
  const gate = /gitcode-pr-review/i.test(configFile) && runId ? loadGateSummary(runId) : null;
  // 同一线程（PR/run）的所有邮件共用稳定主题 + 根 Message-ID → 客户端折叠成一个会话
  const subject = buildWorkflowEmailSubject(emailSettings.subjectPrefix, { configFile, prUrl });
  const threadKey = resolveEmailThreadKey({ runId, globalContext: runState?.globalContext });
  const thread = buildThreadHeaders(threadKey, emailSettings.smtpHost);
  const text = buildBody({
    state,
    message: String(payload?.message || ''),
    configFile,
    runId,
    prUrl,
    ownerEmail: ownerEmail || '(仅抄送)',
    gate,
  });

  try {
    await sendMailViaSmtp(
      {
        host: emailSettings.smtpHost,
        port: Number(emailSettings.smtpPort),
        secure: Boolean(emailSettings.smtpSecure),
        tlsInsecure: Boolean(emailSettings.smtpTlsInsecure),
        username: emailSettings.smtpUsername,
        password: emailSettings.smtpPassword,
        fromEmail: emailSettings.fromEmail,
        fromName: emailSettings.fromName,
        replyTo: emailSettings.replyTo,
      },
      {
        to: ownerEmail ? [ownerEmail] : [],
        cc: cc.length ? cc : undefined,
        subject,
        text,
        messageId: thread.messageId,
        inReplyTo: thread.inReplyTo,
        references: thread.references,
        threadIndex: thread.threadIndex,
      },
    );
  } catch (err: any) {
    // 投递审计：失败原因落日志（此前静默上抛被 delivery 层吞掉，"没收到邮件"无从排查）
    console.error(`[email] 状态邮件投递失败: to=${ownerEmail || '-'} cc=${cc.join(',') || '-'} subject="${subject}" error=${err?.message || err}`);
    throw err;
  }
  console.log(`[email] 状态邮件已投递: to=${ownerEmail || '-'}${cc.length ? ` cc=${cc.join(',')}` : ''} subject="${subject}" state=${state}`);

  deliveredStateKeys.add(dedupeKey);
  return { ok: true };
}
