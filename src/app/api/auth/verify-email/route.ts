import { NextRequest, NextResponse } from 'next/server';
import { loadUsers } from '@/lib/core/user-store';
import { loadSystemSettings } from '@/lib/config/system-settings';
import { sendMailViaSmtp } from '@/lib/notify/smtp-client';

export const dynamic = 'force-dynamic';

/**
 * 注册邮箱验证码存储（内存级，重启清空）
 * key: email → { code, expiresAt, attempts, sentAt }
 */
const signupCodes = new Map<string, { code: string; expiresAt: number; attempts: number; sentAt: number; verified?: boolean }>();

const CODE_TTL_MS = 10 * 60 * 1000;
const SEND_COOLDOWN_MS = 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendSignupVerificationEmail(toEmail: string, code: string): Promise<void> {
  const settings = await loadSystemSettings();
  const emailSettings = settings.emailNotifications;
  if (!emailSettings?.enabled || !emailSettings.smtpHost || !emailSettings.fromEmail) {
    throw new Error('邮件通知未启用，请联系管理员在系统设置中开启');
  }

  const subject = '【CPF 监控平台】注册验证码';
  const text = [
    '您好，',
    '',
    '您正在注册 CPF 监控平台账号。',
    `验证码：${code}`,
    '',
    '有效期 10 分钟。如非本人操作请忽略此邮件。',
    '',
    '— CPF 监控平台',
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
 * POST /api/auth/verify-email
 *
 * Body: { email }                     → 发送验证码（检查邮箱未被注册）
 * Body: { email, code, action: 'verify' } → 校验验证码（返回 verified: true）
 */
export async function POST(request: NextRequest) {
  try {
    const { email, code, action } = await request.json();

    if (!email) {
      return NextResponse.json({ error: '请输入邮箱' }, { status: 400 });
    }

    // ── 发送验证码 ──
    if (!code && !action) {
      const users = await loadUsers();
      if (users.some((u) => u.email === email)) {
        return NextResponse.json({ error: '该邮箱已被注册' }, { status: 409 });
      }

      const existing = signupCodes.get(email);
      if (existing && Date.now() - existing.sentAt < SEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((SEND_COOLDOWN_MS - (Date.now() - existing.sentAt)) / 1000);
        return NextResponse.json({ error: `发送过于频繁，请 ${waitSec} 秒后重试` }, { status: 429 });
      }

      const verificationCode = generateCode();
      try {
        await sendSignupVerificationEmail(email, verificationCode);
      } catch (mailErr: any) {
        console.error('[verify-email] 邮件发送失败:', mailErr?.message);
        return NextResponse.json({ error: `验证码发送失败：${mailErr?.message || 'SMTP 异常'}` }, { status: 502 });
      }

      signupCodes.set(email, {
        code: verificationCode,
        expiresAt: Date.now() + CODE_TTL_MS,
        attempts: 0,
        sentAt: Date.now(),
      });

      console.log(`[verify-email] 注册验证码已发送: to=${email}`);
      return NextResponse.json({ success: true, message: '验证码已发送到您的邮箱' });
    }

    // ── 校验验证码 ──
    if (action === 'verify' && code) {
      const record = signupCodes.get(email);
      if (!record) {
        return NextResponse.json({ error: '请先获取验证码' }, { status: 400 });
      }
      if (Date.now() > record.expiresAt) {
        signupCodes.delete(email);
        return NextResponse.json({ error: '验证码已过期，请重新获取' }, { status: 410 });
      }
      if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
        signupCodes.delete(email);
        return NextResponse.json({ error: '验证次数超限，请重新获取' }, { status: 429 });
      }

      record.attempts++;
      if (code !== record.code) {
        const remaining = MAX_VERIFY_ATTEMPTS - record.attempts;
        return NextResponse.json(
          { error: remaining > 0 ? `验证码错误（剩 ${remaining} 次机会）` : '验证次数超限' },
          { status: 400 },
        );
      }

      // 验证通过——保留验证码记录供注册接口校验（注册成功后清除）
      record.verified = true;
      return NextResponse.json({ success: true, verified: true });
    }

    return NextResponse.json({ error: '未知操作' }, { status: 400 });
  } catch (error: any) {
    console.error('[verify-email] 错误:', error?.message);
    return NextResponse.json({ error: error?.message || '操作失败' }, { status: 500 });
  }
}

/** 供注册接口调用：校验邮箱是否已验证 */
export function isEmailVerified(email: string): boolean {
  const record = signupCodes.get(email);
  return Boolean(record?.verified && Date.now() <= record.expiresAt);
}

/** 供注册接口调用：清除验证记录 */
export function clearEmailVerification(email: string): void {
  signupCodes.delete(email);
}
