import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { getPrMonitorQueueStatus } from '@/lib/workflow/pr-monitor';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  if (auth.role !== 'admin') return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
  return NextResponse.json({ ...(await getPrMonitorQueueStatus()), reconcileIntervalMs: 30000, debounceMs: 1000 });
}
