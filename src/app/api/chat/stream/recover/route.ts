import { NextRequest, NextResponse } from 'next/server';
import { processManager } from '@/lib/core/process-manager';
import { requireAuth } from '@/lib/auth/middleware';
import { getEngineStreamByBackendSessionId } from '@/lib/chat/stream-state';
import { loadRunState } from '@/lib/run/state-persistence';
import { getRunOwnerId } from '@/lib/workflow/run-access';

export const dynamic = 'force-dynamic';

/**
 * Recovery endpoint: GET /api/chat/stream/recover?sessionId=xxx
 * Returns accumulated streamContent for a given backend sessionId.
 * Used when SSE connection was lost and frontend needs the full result.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const sessionId = request.nextUrl.searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
  }

  const proc = processManager.getProcessBySessionId(sessionId);
  const engineState = getEngineStreamByBackendSessionId(sessionId);
  let runOwnerId: string | undefined;
  if (proc?.runId) {
    const runState = await loadRunState(proc.runId, { hydrateLargeOutputs: false }).catch(() => null);
    runOwnerId = getRunOwnerId(runState);
  }
  if (auth.role !== 'admin' && engineState?.ownerId !== auth.id && runOwnerId !== auth.id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (!proc) {
    // Session not found — tell frontend to start a new conversation
    return NextResponse.json({ content: '', status: 'not_found', startNew: true });
  }

  const fullContent = proc.output || proc.streamContent;
  return NextResponse.json({
    content: fullContent,
    status: proc.status,
  });
}
