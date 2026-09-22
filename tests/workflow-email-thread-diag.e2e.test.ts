import { describe, expect, it } from 'vitest';

/**
 * 深度诊断：抓取 buildMessage 生成的原始邮件头（真实格式），逐项检查
 * Message-ID / In-Reply-To / References / Subject 的会话线程字段。
 * 输出完整 MIME 源给人工检查，并断言 RFC 合规性。
 */
describe.skipIf(!process.env.ACE_EMAIL_E2E)('email thread deep diagnostics', () => {
  it('打印 4 封演示邮件的完整 RFC 头部并验证线程字段', async () => {
    // 直接拿私有函数不行，用真实发送路径 + 网络层拦截：起一个本地假 SMTP 服务器
    const net = await import('net');

    const captured: string[] = [];
    let authStep = 0;
    const server = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      let dataLines: string[] = [];
      const reply = (code: string, msg: string) => socket.write(`${code} ${msg}\r\n`);
      reply('220', 'local-smtp-test');
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (inData) {
            if (line === '.') {
              captured.push(dataLines.join('\r\n'));
              dataLines = [];
              inData = false;
              reply('250', 'OK queued');
            } else {
              dataLines.push(line.startsWith('..') ? line.slice(1) : line);
            }
            continue;
          }
          const cmd = line.split(/[\s:]/)[0].toUpperCase();
          if (authStep > 0) {
            // AUTH LOGIN 的用户名/密码两步 base64
            authStep -= 1;
            reply(authStep === 0 ? '235' : '334', authStep === 0 ? 'ok' : 'UGFzc3dvcmQ6');
            continue;
          }
          if (cmd === 'EHLO' || cmd === 'HELO') reply('250', 'local ok');
          else if (cmd === 'MAIL' || cmd === 'RCPT') reply('250', 'ok');
          else if (cmd === 'DATA') { inData = true; reply('354', 'go'); }
          else if (cmd === 'QUIT') { reply('221', 'bye'); socket.end(); }
          else if (cmd === 'STARTTLS') reply('454', 'not available');
          else if (cmd === 'AUTH') { authStep = 2; reply('334', 'VXNlcm5hbWU6'); }
          else if (line === '') continue;
          else reply('250', 'ok');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    try {
      // 临时覆盖设置指向本地假服务器（通过模块级 mock 不方便，直接改 settings 加载结果）
      const { saveSystemSettings, loadSystemSettings } = await import('@/lib/config/system-settings');
      const original = await loadSystemSettings();
      await saveSystemSettings({
        ...original,
        emailNotifications: {
          ...(original.emailNotifications || {}),
          enabled: true,
          smtpHost: '127.0.0.1',
          smtpPort: port,
          smtpSecure: false,
          fromEmail: 'diagnostic@aceharness.local',
          fromName: '诊断',
          subjectPrefix: '[诊断]',
        },
      } as any);

      const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
      const { sendHumanReviewEmailNotification } = await import('@/lib/notify/human-review-email');

      // 注意：设置模块有缓存吗？saveSystemSettings 直接写文件，loadSystemSettings 每次读文件。
      const ZHANGGONG = 'f7798c97-4ddf-48bf-ab73-199c4618fe82';
      const runId = `run-diag-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('fs/promises');
      const { getWorkspaceRunsDir } = await import('@/lib/core/app-paths');
      const { join } = await import('path');
      const runDir = join(getWorkspaceRunsDir(), runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, 'state.yaml'), [
        `runId: ${runId}`,
        'status: running',
        `runOwnerId: ${ZHANGGONG}`,
        'configFile: gitcode-pr-review.yaml',
        `globalContext: |`,
        '  pr_url: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1999',
        '',
      ].join('\n'), 'utf-8');

      try {
        // 按生命周期顺序发 4 封（同一 PR）
        await sendHumanReviewEmailNotification({
          id: `diag-hq-1-${Date.now()}`, runId, configFile: 'gitcode-pr-review.yaml',
          currentState: '__human_approval__', title: '等待人工审查', message: '挂起 #1',
          status: 'unanswered', kind: 'approval', createdAt: new Date().toISOString(),
          answerSchema: { type: 'text', required: true }, source: { type: 'human-approval' },
        } as any);
        await sendHumanReviewEmailNotification({
          id: `diag-hq-2-${Date.now()}`, runId, configFile: 'gitcode-pr-review.yaml',
          currentState: '__human_approval__', title: '等待人工审查', message: '挂起 #2（再次挂起）',
          status: 'unanswered', kind: 'approval', createdAt: new Date().toISOString(),
          answerSchema: { type: 'text', required: true }, source: { type: 'human-approval' },
        } as any);
        await sendWorkflowStateEmailNotification({ state: '就绪', message: '门禁全绿', runId, __configFile: 'gitcode-pr-review.yaml' });
        await sendWorkflowStateEmailNotification({ state: '完成', message: 'run 结束', runId, __configFile: 'gitcode-pr-review.yaml' });

        expect(captured.length).toBe(4);

        const parse = (raw: string) => {
          const headers: Record<string, string> = {};
          for (const line of raw.split('\r\n')) {
            const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
            if (m) headers[m[1].toLowerCase()] = m[2];
          }
          return headers;
        };
        const headers = captured.map(parse);
        console.log('\n========= 4 封邮件的线程相关头部 =========');
        headers.forEach((h, i) => {
          console.log(`--- 邮件 ${i + 1} ---`);
          console.log(`Subject:     ${h['subject']}`);
          console.log(`Message-ID:  ${h['message-id']}`);
          console.log(`In-Reply-To: ${h['in-reply-to'] || '(无)'}`);
          console.log(`References:  ${h['references'] || '(无)'}`);
          console.log(`Thread-Index:${h['thread-index'] || '(无)'}`);
        });

        // ── RFC 5322 线程断言 ──
        const root = headers[0]['message-id'];
        expect(root).toMatch(/^<ace-pr-cpf-flutter.flutter_flutter-1999@127\.0\.0\.1>$/);
        for (let i = 1; i < 4; i++) {
          expect(headers[i]['in-reply-to']).toBe(root);
          expect(headers[i]['references']).toBe(root);
        }
        // ── Thread-Index（Outlook 原生归组）断言：根 22B，子 27B 共享前 22B ──
        const ti0 = Buffer.from(headers[0]['thread-index'], 'base64');
        expect(ti0.length).toBe(22);
        for (let i = 1; i < 4; i++) {
          const ti = Buffer.from(headers[i]['thread-index'], 'base64');
          expect(ti.length).toBe(27);
          expect(ti.subarray(0, 22).equals(ti0)).toBe(true);
        }
        // 主题稳定一致
        const subjects = new Set(headers.map((h) => h['subject']));
        expect(subjects.size).toBe(1);
        console.log('\n断言全部通过：References 链 + Thread-Index 链（Outlook 原生归组）均完整');
      } finally {
        await rm(runDir, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      server.close();
      // 恢复原设置
      const { saveSystemSettings: save, loadSystemSettings: load } = await import('@/lib/config/system-settings');
      const cur = await load();
      // diag 值还在（刚 capture 的 4 封），恢复为真实 QQ 设置
      // 凭证不硬编码：改由环境变量注入真实值（本地 .env / CI secret），避免密码进仓库
      const user = process.env.ACE_EMAIL_E2E_USER || '';
      const pass = process.env.ACE_EMAIL_E2E_PASS || '';
      await save({
        ...cur,
        emailNotifications: {
          enabled: true,
          smtpHost: 'smtp.qq.com',
          smtpPort: 465,
          smtpSecure: true,
          smtpUsername: user,
          smtpPassword: pass,
          fromEmail: user,
          fromName: 'ACEHarness',
          subjectPrefix: '[ACE]',
          notifyStates: '就绪, 完成, 终止',
        },
      } as any);
    }
  });
});
