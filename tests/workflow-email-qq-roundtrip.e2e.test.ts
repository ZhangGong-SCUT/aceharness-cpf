import { describe, expect, it } from 'vitest';
import tls from 'tls';
import { loadSystemSettings } from '@/lib/config/system-settings';
import { sendMailViaSmtp } from '@/lib/notify/smtp-client';
import { buildThreadHeaders, buildWorkflowEmailSubject } from '@/lib/notify/email-thread';

/**
 * QQ 回环深度诊断：把带完整线程头的邮件发到 QQ 邮箱自己，再用 POP3 拉回原始报文，
 * 对比「发出的」与「到达的」头部——查明 QQ SMTP 中继是否改写 Message-ID、
 * 是否保留 References / Thread-Index（Outlook 归组的决定因素）。
 *
 * ACE_EMAIL_E2E=1 npx vitest run tests/workflow-email-qq-roundtrip.e2e.test.ts
 */
describe.skipIf(!process.env.ACE_EMAIL_E2E)('QQ SMTP → POP3 roundtrip diagnostics', () => {
  it('发出两封同线程邮件并取回原始报文对比头部', async () => {
    const settings = await loadSystemSettings();
    const email = settings.emailNotifications!;
    expect(email.enabled).toBe(true);
    const to = email.smtpUsername!; // 发给自己，POP3 可取回

    const threadKey = `pr-diag-qq-roundtrip-${Date.now()}`;
    const subject = buildWorkflowEmailSubject('[ACE诊断]', { configFile: 'gitcode-pr-review.yaml', prUrl: 'https://gitcode.com/x/y/merge_requests/42' });
    const rootHeaders = buildThreadHeaders(threadKey, email.smtpHost);
    const childHeaders = buildThreadHeaders(threadKey, email.smtpHost);

    const mk = (thread: typeof rootHeaders, tag: string) => ({
      to: [to],
      subject,
      text: `QQ 回环诊断 ${tag}\n线程键: ${threadKey}\n发送时间: ${new Date().toISOString()}`,
      messageId: thread.messageId,
      inReplyTo: thread.inReplyTo,
      references: thread.references,
      threadIndex: thread.threadIndex,
    });

    const transport = {
      host: email.smtpHost!,
      port: Number(email.smtpPort),
      secure: Boolean(email.smtpSecure),
      username: email.smtpUsername,
      password: email.smtpPassword,
      fromEmail: email.fromEmail!,
      fromName: email.fromName,
    };

    // 发：根 + 子
    await sendMailViaSmtp(transport, mk(rootHeaders, 'ROOT'));
    await sendMailViaSmtp(transport, mk(childHeaders, 'CHILD'));

    // 等 QQ 内部投递（自发自收通常秒级，子邮件偶有延迟）
    await new Promise((r) => setTimeout(r, 25000));

    // POP3 拉回
    const messages = await pop3ListRecent(email.smtpUsername!, email.smtpPassword!, 10);
    const decodeBody = (raw: string): string => {
      const m = raw.match(/\r\n\r\n([\s\S]*)$/);
      if (!m) return '';
      try {
        return Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8');
      } catch {
        return m[1];
      }
    };
    const mine = messages.filter((raw) => decodeBody(raw).includes('QQ 回环诊断'));

    console.log(`\n[拉回 ${messages.length} 封]`);
    expect(mine.length).toBeGreaterThanOrEqual(1);

    console.log('\n========== 发出 → 到达 头部对比 ==========');
    console.log('【发出的根】');
    console.log(`  Message-ID:  ${rootHeaders.messageId}`);
    console.log(`  Thread-Index:${rootHeaders.threadIndex}`);
    console.log('【发出的子】');
    console.log(`  Message-ID:  ${childHeaders.messageId}`);
    console.log(`  In-Reply-To: ${childHeaders.inReplyTo}`);
    console.log(`  Thread-Index:${childHeaders.threadIndex}`);

    for (const raw of mine) {
      console.log('【到达的邮件】完整头部（线程相关）:');
      for (const line of raw.split('\r\n')) {
        if (/^(Message-ID|In-Reply-To|References|Thread-Index|Subject|X-Mailer|Received|DKIM|Authentication-Results|Return-Path|X-QQ|From|To):/i.test(line)) {
          console.log(`  ${line.trim().slice(0, 200)}`);
        }
      }
      console.log('---');
    }

    // 软断言：到达的邮件里 Thread-Index 是否幸存、Message-ID 是否被改写（打印结论，不硬失败）
    const arrivedTi = mine.filter((raw) => /^Thread-Index:/im.test(raw)).length;
    const arrivedMidRewritten = mine.filter((raw) => {
      const m = raw.match(/^Message-ID:\s*(.+)$/im);
      return m && ![rootHeaders.messageId, childHeaders.messageId].includes(m[1].trim());
    }).length;
    console.log(`\n结论: Thread-Index 幸存 ${arrivedTi}/${mine.length}；Message-ID 被改写 ${arrivedMidRewritten}/${mine.length}`);
  });
});

/** 极简 POP3 客户端：取最近 n 封的原始报文 */
async function pop3ListRecent(user: string, pass: string, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: 'pop.qq.com', port: 995, servername: 'pop.qq.com' }, () => {});
    let buffer = '';
    let stage: 'greeting' | 'user' | 'pass' | 'stat' | 'list' | 'retr' | 'quit' = 'greeting';
    let total = 0;
    const results: string[] = [];
    const wanted: number[] = [];
    let retrIdx = 0;

    const fail = (msg: string) => { try { socket.destroy(); } catch {} reject(new Error(msg)); };
    socket.on('error', fail);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (stage === 'retr') {
          // RETR 正文以单独的 "." 结束
          if (line === '.') {
            const start = `+OK`.length;
            results.push(retrBuffer.join('\r\n'));
            retrBuffer = [];
            nextRetr();
            continue;
          }
          retrBuffer.push(line);
          continue;
        }
        if (!line.startsWith('+OK')) {
          if (line.startsWith('-ERR')) fail(`POP3 ${stage}: ${line}`);
          continue;
        }
        if (stage === 'greeting') { socket.write(`USER ${user}\r\n`); stage = 'user'; }
        else if (stage === 'user') { socket.write(`PASS ${pass}\r\n`); stage = 'pass'; }
        else if (stage === 'pass') { socket.write('STAT\r\n'); stage = 'stat'; }
        else if (stage === 'stat') {
          total = Number(line.split(' ')[1] || 0);
          if (!total) { socket.write('QUIT\r\n'); stage = 'quit'; resolve(results); return; }
          socket.write(`LIST\r\n`); stage = 'list';
        } else if (stage === 'list') {
          const from = Math.max(1, total - count + 1);
          for (let i = total; i >= from; i--) wanted.push(i);
          nextRetr();
        } else if (stage === 'quit') { socket.end(); resolve(results); return; }
      }
    });

    let retrBuffer: string[] = [];
    function nextRetr() {
      if (retrIdx >= wanted.length) {
        socket.write('QUIT\r\n');
        stage = 'quit';
        return;
      }
      const n = wanted[retrIdx++];
      stage = 'retr';
      retrBuffer = [];
      socket.write(`RETR ${n}\r\n`);
    }

    socket.setTimeout(30000, () => fail('POP3 超时'));
  });
}
