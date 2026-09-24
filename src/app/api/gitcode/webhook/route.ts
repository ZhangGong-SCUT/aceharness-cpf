import { NextRequest, NextResponse } from 'next/server';
import {
  extractGitcodeWebhookSecret,
  resolveGitcodeWebhookSecret,
  secretsMatch,
} from '@/lib/workflow/gitcode-webhook';
import { enqueuePrWebhook, startPrMonitorWorker } from '@/lib/workflow/pr-monitor';

export const dynamic = 'force-dynamic';

async function readWebhookPayload(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get('content-type') || '';
  const raw = await request.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    if (contentType.includes('form') || raw.includes('=')) {
      const params = new URLSearchParams(raw);
      const nested = params.get('payload') || params.get('data') || '';
      if (nested) {
        try {
          return JSON.parse(nested);
        } catch {
          return Object.fromEntries(params);
        }
      }
      return Object.fromEntries(params);
    }
    return {};
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'gitcode-pr-review',
    usage: '将项目仓库 Webhook 指到 POST /api/gitcode/webhook，开启 Merge Request 和 Note。只处理 ACE_GITCODE_PR_AUTHOR 白名单作者的 PR。同一条 PR 已有自修时唤醒等待中的 run，不新开。',
  });
}

export async function POST(request: NextRequest) {
  try {
    const expected = await resolveGitcodeWebhookSecret();
    if (!expected) {
      return NextResponse.json(
        { error: '未配置 ACE_GITCODE_WEBHOOK_SECRET，拒绝接收 GitCode Webhook' },
        { status: 503 },
      );
    }

    const payload = await readWebhookPayload(request);
    const provided = extractGitcodeWebhookSecret({
      query: Object.fromEntries(request.nextUrl.searchParams.entries()),
      headers: request.headers,
      body: payload,
    });
    if (!secretsMatch(provided, expected)) {
      return NextResponse.json({ error: 'Webhook 密钥不匹配' }, { status: 401 });
    }

    const result = await enqueuePrWebhook(payload);
    startPrMonitorWorker();
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    console.log(
      `[gitcode-webhook] accepted=${result.accepted} reason=${result.reason} action=${result.action} event=${result.event} author=${result.author || ''} pr=${result.prUrl || ''} keys=${Object.keys(body).slice(0, 12).join(',')}`,
    );
    return NextResponse.json(result, { status: result.status });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || '处理 GitCode Webhook 失败' },
      { status: 500 },
    );
  }
}
