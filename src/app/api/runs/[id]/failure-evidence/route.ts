import { NextRequest, NextResponse } from 'next/server';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRunState } from '@/lib/run/state-persistence';
import { getWorkspaceRunsDir } from '@/lib/core/app-paths';

const MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;
const RELEVANT_EVENTS = new Set([
  'ohos.flutter.sdk', 'ohos.flutter.sdk.overlay',
  'ohos.flutter.sdk.overlay.revived', 'ohos.flutter.sdk.overlay.removed',
  'step.prompt', 'step.fail', 'run.fail',
]);

/** Bounded, read-only diagnostic events for failure triage; never starts or mutates a run. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const run = await loadRunState(id, { hydrateLargeOutputs: false });
    if (!run) return NextResponse.json({ error: '运行记录不存在' }, { status: 404 });
    const path = join(getWorkspaceRunsDir(), id, 'diagnostics.jsonl');
    const file = await open(path, 'r');
    let content = '';
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - MAX_DIAGNOSTIC_BYTES);
      const buffer = Buffer.alloc(Math.min(size, MAX_DIAGNOSTIC_BYTES));
      await file.read(buffer, 0, buffer.length, start);
      content = buffer.toString('utf8');
      if (start > 0) content = content.slice(content.indexOf('\n') + 1);
    } finally {
      await file.close();
    }
    const events = content.split('\n').filter(Boolean).flatMap(line => {
      try {
        const event = JSON.parse(line);
        if (!RELEVANT_EVENTS.has(event.event)) return [];
        // Deliberately select diagnostic fields rather than returning prompt/output contents.
        return [{
          timestamp: event.timestamp, event: event.event, state: event.state, step: event.step,
          matched: event.matched, pending: event.pending, branch: event.branch,
          sdkId: event.sdkId, sdkRoot: event.sdkRoot, flutterBin: event.flutterBin,
          reason: typeof event.reason === 'string' ? event.reason.slice(0, 1000) : undefined,
          error: typeof event.error === 'string' ? event.error.slice(0, 2000) : undefined,
        }];
      } catch { return []; }
    }).slice(-400);
    return NextResponse.json({ runId: id, events, truncated: events.length === 400 });
  } catch (error: any) {
    return NextResponse.json({ error: '运行诊断事件暂不可读', message: error.message }, { status: 500 });
  }
}
