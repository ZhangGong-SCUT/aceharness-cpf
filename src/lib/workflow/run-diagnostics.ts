import { appendFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { getWorkspaceRunsDir } from '@/lib/core/app-paths';
import { classifyDiagnosisInput } from '@/lib/workflow/diagnosis-input';
import { classifyPrReviewInput } from '@/lib/workflow/pr-review-input';

export interface RunDiagnosticEvent {
  event: string;
  level?: 'info' | 'warn' | 'error';
  details?: Record<string, unknown>;
}

function previewText(value: string | null | undefined, max = 240): string {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function summarizeGlobalContext(value: string | null | undefined): {
  length: number;
  preview: string;
  hasIssueUrl: boolean;
  hasPrUrl: boolean;
  inputMode: 'issue' | 'pr' | 'event' | 'freeform' | 'empty';
} {
  const text = String(value || '');
  const pr = classifyPrReviewInput(text);
  if (pr.mode === 'pr' || pr.mode === 'event') {
    return {
      length: text.length,
      preview: previewText(text),
      hasIssueUrl: false,
      hasPrUrl: true,
      inputMode: pr.mode,
    };
  }
  const classified = classifyDiagnosisInput(text);
  return {
    length: text.length,
    preview: previewText(text),
    hasIssueUrl: classified.mode === 'issue',
    hasPrUrl: false,
    inputMode: classified.mode,
  };
}

export function getRunDiagnosticsPaths(runId: string, runsDir = getWorkspaceRunsDir()) {
  const dir = resolve(runsDir, runId);
  return {
    dir,
    jsonl: resolve(dir, 'diagnostics.jsonl'),
    log: resolve(dir, 'diagnostics.log'),
  };
}

export async function appendRunDiagnostic(
  runId: string | null | undefined,
  input: RunDiagnosticEvent,
  runsDir = getWorkspaceRunsDir(),
): Promise<void> {
  const id = String(runId || '').trim();
  if (!id) return;

  const timestamp = new Date().toISOString();
  const level = input.level || 'info';
  const record = {
    timestamp,
    runId: id,
    event: input.event,
    level,
    ...(input.details || {}),
  };
  const line = JSON.stringify(record);
  const summaryBits = Object.entries(input.details || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 8)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  const textLine = `[${timestamp}] [${level}] ${input.event}${summaryBits.length ? ` ${summaryBits.join(' ')}` : ''}`;

  try {
    const paths = getRunDiagnosticsPaths(id, runsDir);
    await mkdir(paths.dir, { recursive: true });
    await Promise.all([
      appendFile(paths.jsonl, `${line}\n`, 'utf-8'),
      appendFile(paths.log, `${textLine}\n`, 'utf-8'),
    ]);
  } catch (error) {
    console.warn(`[run-diagnostics] write failed for ${id}:`, error);
  }
}
