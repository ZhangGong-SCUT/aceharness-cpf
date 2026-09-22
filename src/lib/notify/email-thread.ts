import { createHash, randomUUID } from 'crypto';

/**
 * 邮件会话线程：同一个线程键（PR 身份，缺省 runId）的所有邮件共用一个根 Message-ID，
 * 后续邮件通过 In-Reply-To / References 挂到根上，邮件客户端（Outlook/Gmail）会把它们
 * 折叠成一个会话——「一个 run（PR）一个会话」，不再满邮箱散件。
 *
 * 根 ID 由线程键确定性生成：服务重启后内存集合清空，新邮件仍会引用同一个根 ID，
 * 客户端照旧归入原会话（线程不因重启断裂）。
 */

const sentThreadRoots = new Set<string>();

/** 从 run 的 globalContext 提取 PR 身份（owner/repo#number），提取不到返回空串。 */
export function extractPrIdentityFromContext(globalContext?: string | null): string {
  const urlMatch = String(globalContext || '').match(/pr_url:\s*(\S+)/);
  const url = urlMatch?.[1] || '';
  const prMatch = url.match(/([^/\s]+)\/([^/\s]+)\/(?:pulls?|merge_requests)\/(\d+)/i);
  if (!prMatch) return '';
  return `${prMatch[1]}/${prMatch[2]}#${prMatch[3]}`.toLowerCase();
}

/**
 * 线程键优先级：PR 身份 > runId > 空。
 * 用 PR 身份意味着同一 PR 的多波 run（webhook 重新拉起）也进同一会话；
 * 提取不到 PR 的普通工作流按 runId 各自成线程；两者都没有则不加线程头（独立邮件）。
 */
export function resolveEmailThreadKey(input: { runId?: string | null; globalContext?: string | null }): string {
  const prIdentity = extractPrIdentityFromContext(input.globalContext);
  if (prIdentity) return `pr-${prIdentity}`;
  const runId = String(input.runId || '').trim();
  return runId ? `run-${runId}` : '';
}

/**
 * 稳定主题：同一线程的所有邮件（人工审查邮件、状态里程碑邮件）主题完全一致，
 * 客户端按 References 线程化之外再按主题兜底，确保归到一起。
 */
export function buildWorkflowEmailSubject(
  prefix: string | undefined,
  info: { configFile?: string | null; prUrl?: string | null },
): string {
  const prMatch = String(info.prUrl || '').match(/([^/\s]+)\/([^/\s]+)\/(?:pulls?|merge_requests)\/(\d+)/i);
  const configBase = String(info.configFile || '').replace(/\.ya?ml$/i, '') || '工作流';
  const core = prMatch ? `${prMatch[2]}#${prMatch[3]} · ${configBase}` : configBase;
  const trimmed = String(prefix || '').trim();
  return trimmed ? `${trimmed} 工作流 · ${core}` : `工作流 · ${core}`;
}

function sanitizeMsgIdLocalPart(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 120);
}

export interface EmailThreadHeaders {
  messageId: string;
  inReplyTo?: string;
  references?: string;
  threadRootId: string;
  /** Outlook/Exchange 原生会话头（Thread-Index）：经典桌面版归组只认它，不认 References */
  threadIndex?: string;
}

/**
 * Thread-Index 根（22 字节 = 6 字节 FILETIME 毫秒级时间戳 + 16 字节 GUID）。
 * 全部从线程键哈希确定性生成：服务重启、多进程发送都得到同一根 → 会话不断链。
 * 时间戳取 2026-01-01 加哈希偏移（一年内），避免哈希直出的时间戳越过 FILETIME 合理区间。
 */
function buildThreadIndexRoot(threadKey: string): { bytes: Buffer; units: bigint } {
  const digest = createHash('sha256').update(`ace-thread:${threadKey}`).digest();
  const baseMs = Date.UTC(2026, 0, 1);
  const offsetMs = digest.readUInt32BE(0) % (365 * 24 * 60 * 60 * 1000);
  const units = (BigInt(baseMs + offsetMs) + 11644473600000n) * 10000n >> 16n;
  const ts8 = Buffer.alloc(8);
  ts8.writeBigUInt64BE(units);
  return { bytes: Buffer.concat([ts8.subarray(2), digest.subarray(0, 16)]), units };
}

/** Thread-Index 编码：根 = base64(22B)；子 = base64(22B 根 + 5B 相对根的时间增量)。 */
function encodeThreadIndex(root: { bytes: Buffer; units: bigint }, withDelta: boolean): string {
  if (!withDelta) return root.bytes.toString('base64');
  const nowUnits = (BigInt(Date.now()) + 11644473600000n) * 10000n >> 16n;
  let delta = nowUnits - root.units;
  if (delta <= 0n) delta = 1n;
  if (delta > 0xffffffffffn) delta = 0xffffffffffn;
  const delta8 = Buffer.alloc(8);
  delta8.writeBigUInt64BE(delta);
  return Buffer.concat([root.bytes, delta8.subarray(3)]).toString('base64');
}

/**
 * 线程的首封邮件：Message-ID 即根 ID；后续邮件：独立 Message-ID + 挂回根。
 *
 * QQ 等中继会改写 Message-ID（实测 QQ SMTP 100% 改写为 tencent_*，但 References 原样保留），
 * 因此首封也带 References=根ID（自指）：中继改写后，线程内所有邮件仍共享同一个 References
 * 值，按 References 归组的客户端（OWA/Gmail/新 Outlook）照样折叠。
 */
export function buildThreadHeaders(threadKey: string, host?: string | null): EmailThreadHeaders {
  const domain = String(host || '').trim() || 'aceharness.local';
  if (!threadKey) {
    return { messageId: `<${randomUUID()}@${domain}>`, threadRootId: '' };
  }
  const root = `<ace-${sanitizeMsgIdLocalPart(threadKey)}@${domain}>`;
  const threadIndexRoot = buildThreadIndexRoot(threadKey);
  if (!sentThreadRoots.has(threadKey)) {
    sentThreadRoots.add(threadKey);
    return {
      messageId: root,
      threadRootId: root,
      references: root,
      threadIndex: encodeThreadIndex(threadIndexRoot, false),
    };
  }
  return {
    messageId: `<ace-${sanitizeMsgIdLocalPart(threadKey)}-${Date.now()}-${randomUUID().slice(0, 8)}@${domain}>`,
    inReplyTo: root,
    references: root,
    threadRootId: root,
    threadIndex: encodeThreadIndex(threadIndexRoot, true),
  };
}
