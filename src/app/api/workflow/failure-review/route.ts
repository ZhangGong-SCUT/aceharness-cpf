import { NextRequest, NextResponse } from 'next/server';
import { loadRunState } from '@/lib/run/state-persistence';
import { StateMachineWorkflowManager } from '@/lib/state-machine/workflow-manager';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const runId = typeof body?.runId === 'string' ? body.runId.trim() : '';
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!runId || !prompt || prompt.length > 16000) {
      return NextResponse.json({ error: '故障复核需要有效的 runId 和不超过 16000 字符的证据提示词' }, { status: 400 });
    }
    const run = await loadRunState(runId, { hydrateLargeOutputs: false });
    if (!run) return NextResponse.json({ error: '运行记录不存在' }, { status: 404 });
    const reviewer = new StateMachineWorkflowManager();
    const rawOutput = await reviewer.reviewFailureForRun(runId, prompt);
    return NextResponse.json({ success: true, rawOutput });
  } catch (error: any) {
    return NextResponse.json({ error: 'Supervisor 故障复核失败', message: error.message }, { status: 500 });
  }
}
