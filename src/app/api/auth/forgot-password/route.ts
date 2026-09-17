import { NextRequest, NextResponse } from 'next/server';
import { loadUsers, resetPasswordByEmail } from '@/lib/core/user-store';
import { loadSystemSettings } from '@/lib/config/system-settings';
import { sendMailViaSmtp } from '@/lib/notify/smtp-client';

export const dynamic = 'force-dynamic';

/**
 * 邮箱验证码存储（内存级，重启清空）
 * key: email → { code, expiresAt, attempts, sentAt }
 */
const resetCodes = new Map<string, { code: string; expiresAt: number; attempts: number; sentAt: number }>();

const CODE_TTL_MS = 10 * 60 * 1000;      // 验证码有效期 10 分钟
const SEND_COOLDOWN_MS = 60 * 1000;       // 发送冷却 60 秒
const MAX_VERIFY_ATTEMPTS = 5;            // 最多验证 5 次

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendVerificationEmail(toEmail: string, code: string, username: string): Promise<void> {
  const settings = await loadSystemSettings();
  const emailSettings = settings.emailNotifications;
  if (!emailSettings?.enabled || !emailSettings.smtpHost || !emailSettings.fromEmail) {
    throw new Error('邮件通知未启用或未配置，请联系管理员在系统设置中开启');
  }

  const subject = '【CPF 监控平台】密码重置验证码';
  const text = [
    `您好 ${username}，`,
    '',
    `您正在重置 CPF 监控平台密码。`,
    `验证码：${code}`,
    '',
    `有效期 10 分钟。如非本人操作请忽略此邮件。`,
    '',
    `— CPF 监控平台`,
  ].join('\n');

  await sendMailViaSmtp(
    {
      host: emailSettings.smtpHost,
      port: Number(emailSettings.smtpPort || 465),
      secure: Boolean(emailSettings.smtpSecure),
      tlsInsecure: Boolean(emailSettings.smtpTlsInsecure),
      username: emailSettings.smtpUsername,
      password: emailSettings.smtpPassword,
      fromEmail: emailSettings.fromEmail,
      fromName: emailSettings.fromName || 'CPF 监控平台',
    },
    { to: [toEmail], subject, text },
  );
}

/**
 * POST /api/auth/forgot-password
 *
 * Body: { step: 'send-code', email }
 *   → 发送验证码到邮箱
 *
 * Body: { step: 'verify-and-reset', email, code, newPassword }
 *   → 验证码校验 + 重置密码
 */
export async function POST(request: NextRequest) {
  try {
    const { step, email, code, newPassword } = await request.json();

    if (!email) {
      return NextResponse.json({ error: '请输入邮箱' }, { status: 400 });
    }

    // ── Step 1: 发送验证码 ──
    if (step === 'send-code') {
      const users = await loadUsers();
      const user = users.find((u) => u.email === email);
      if (!user) {
        return NextResponse.json({ error: '该邮箱未注册' }, { status: 404 });
      }
      if (user.status !== 'active') {
        return NextResponse.json({ error: '账号未激活' }, { status: 403 });
      }

      // 冷却检查（60 秒内不重复发）
      const existing = resetCodes.get(email);
      if (existing && Date.now() - existing.sentAt < SEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((SEND_COOLDOWN_MS - (Date.now() - existing.sentAt)) / 1000);
        return NextResponse.json({ error: `发送过于频繁，请 ${waitSec} 秒后重试` }, { status: 429 });
      }

      // 生成并发送
      const verificationCode = generateCode();
      try {
        await sendVerificationEmail(email, verificationCode, user.username);
      } catch (mailErr: any) {
        console.error('[forgot-password] 邮件发送失败:', mailErr?.message);
        return NextResponse.json({ error: `验证码发送失败：${mailErr?.message || 'SMTP 异常'}` }, { status: 502 });
      }

      resetCodes.set(email, {
        code: verificationCode,
        expiresAt: Date.now() + CODE_TTL_MS,
        attempts: 0,
        sentAt: Date.now(),
      });

      console.log(`[forgot-password] 验证码已发送: to=${email} username=${user.username}`);
      return NextResponse.json({ success: true, message: '验证码已发送到您的邮箱' });
    }

    // ── Step 2: 验证码 + 重置密码 ──
    if (step === 'verify-and-reset') {
      if (!code || !newPassword) {
        return NextResponse.json({ error: '验证码和新密码不能为空' }, { status: 400 });
      }
      if (newPassword.length < 6) {
        return NextResponse.json({ error: '新密码至少 6 个字符' }, { status: 400 });
      }

      const record = resetCodes.get(email);
      if (!record) {
        return NextResponse.json({ error: '请先获取验证码' }, { status: 400 });
      }
      if (Date.now() > record.expiresAt) {
        resetCodes.delete(email);
        return NextResponse.json({ error: '验证码已过期，请重新获取' }, { status: 410 });
      }
      if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
        resetCodes.delete(email);
        return NextResponse.json({ error: '验证次数超限，请重新获取验证码' }, { status: 429 });
      }

      // 校验验证码
      record.attempts++;
      if (code !== record.code) {
        const remaining = MAX_VERIFY_ATTEMPTS - record.attempts;
        return NextResponse.json(
          { error: remaining > 0 ? `验证码错误（剩 ${remaining} 次机会）` : '验证次数超限，请重新获取' },
          { status: 400 },
        );
      }

      // 验证通过 → 重置密码
      await resetPasswordByEmail(email, newPassword);

      // 清除验证码（一次性）
      resetCodes.delete(email);
      console.log(`[forgot-password] 密码重置成功: email=${email}`);
      return NextResponse.json({ success: true, message: '密码重置成功，请使用新密码登录' });
    }

    return NextResponse.json({ error: '未知操作步骤' }, { status: 400 });
  } catch (error: any) {
    console.error('[forgot-password] 错误:', error?.message);
    return NextResponse.json({ error: error?.message || '操作失败' }, { status: 500 });
  }
}
