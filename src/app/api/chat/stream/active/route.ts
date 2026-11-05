import { NextRequest, NextResponse } from 'next/server';
import { processManager } from '@/lib/core/process-manager';
import { requireAuth } from '@/lib/auth/middleware';
import { getEngineStreamByFrontendSessionId } from '@/lib/chat/stream-state';
import { loadRunState } from '@/lib/run/state-persistence';
import { getRunOwnerId } from '@/lib/workflow/run-access';

export const dynamic = 'force-dynamic';

/**
 * Check if there's an active stream for a given frontend session ID.
 * GET /api/chat/stream/active?frontendSessionId=xxx
 * Returns chatId if found, 404 otherwise.
 * Used by frontend to detect and reconnect to interrupted streams after page refresh.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const frontendSessionId = request.nextUrl.searchParams.get('frontendSessionId');
  if (!frontendSessionId) {
    return NextResponse.json({ error: 'Missing frontendSessionId' }, { status: 400 });
  }

  const chatId = processManager.getActiveStreamChatId(frontendSessionId);
  if (!chatId) {
    return NextResponse.json({ active: false }, { status: 404 });
  }

  const proc = processManager.getProcess(chatId);
  if (!proc) {
    return NextResponse.json({ active: false }, { status: 404 });
  }

  const engineState = getEngineStreamByFrontendSessionId(frontendSessionId);
  let runOwnerId: string | undefined;
  if (proc.runId) {
    const runState = await loadRunState(proc.runId, { hydrateLargeOutputs: false }).catch(() => null);
    runOwnerId = getRunOwnerId(runState);
  }
  if (auth.role !== 'admin' && engineState?.ownerId !== auth.id && runOwnerId !== auth.id) {
    return NextResponse.json({ error: 'Stream not found' }, { status: 404 });
  }

  return NextResponse.json({
    active: true,
    chatId,
    status: proc.status,
    streamContent: proc.status === 'running' ? proc.streamContent : undefined,
  });
}
