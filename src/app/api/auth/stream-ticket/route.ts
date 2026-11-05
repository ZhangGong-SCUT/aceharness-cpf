import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { issueStreamTicket, STREAM_TICKET_SCOPES, type StreamTicketScope } from '@/lib/auth/stream-ticket';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  if (!STREAM_TICKET_SCOPES.includes(body?.scope)) {
    return NextResponse.json({ error: '无效的 SSE 凭证范围' }, { status: 400 });
  }
  return NextResponse.json(issueStreamTicket(auth.id, body.scope as StreamTicketScope), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
