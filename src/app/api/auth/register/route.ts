import { NextRequest, NextResponse } from 'next/server';
import { isSetup, registerUser } from '@/lib/core/user-store';
import { isEmailVerified, clearEmailVerification } from '@/app/api/auth/verify-email/route';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const setup = await isSetup();
    if (!setup) {
      return NextResponse.json({ error: '系统尚未初始化，请先完成管理员设置' }, { status: 409 });
    }

    const { username, email, password, question, answer, personalDir, avatar, emailVerifyCode } = await request.json();

    if (!username || !email || !password || !question || !answer) {
      return NextResponse.json({ error: '所有字段都不能为空' }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ error: '密码至少6个字符' }, { status: 400 });
    }

    // ── 邮箱验证码校验（防无效邮箱注册） ──
    if (!emailVerifyCode) {
      return NextResponse.json({ error: '请先获取邮箱验证码' }, { status: 400 });
    }
    if (!isEmailVerified(email)) {
      return NextResponse.json(
        { error: '邮箱验证码未通过或已过期，请重新获取验证码' },
        { status: 400 },
      );
    }

    const user = await registerUser({
      username,
      email,
      password,
      question,
      answer,
      personalDir,
      avatar,
    });

    // 注册成功后清除验证记录（一次性）
    clearEmailVerification(email);

    return NextResponse.json({ user, message: '注册申请已提交，请等待管理员审核' });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || '注册失败' }, { status: 400 });
  }
}
