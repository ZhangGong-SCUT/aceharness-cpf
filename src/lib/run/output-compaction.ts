import { getAceProcessRanges } from '@/lib/chat/ai-process-blocks';

const DEFAULT_RUNTIME_OUTPUT_PREVIEW_LIMIT = 12000;

export function compactRuntimeOutputPreview(
  output: string,
  limit = DEFAULT_RUNTIME_OUTPUT_PREVIEW_LIMIT
): { output: string; outputBytes: number; truncated: boolean } {
  const text = typeof output === 'string' ? output : '';
  const outputBytes = Buffer.byteLength(text, 'utf-8');
  if (text.length <= limit) {
    return { output: text, outputBytes, truncated: false };
  }
  // State routing and feedback recovery need the final structured conclusion,
  // even when verbose tool logs fill the beginning of the preview.
  const toolRanges = getAceProcessRanges(text);
  const conclusion = [...text.matchAll(/<step-conclusion>[\s\S]*?<\/step-conclusion>/gi)]
    .filter(match => !toolRanges.some(([start, end]) => match.index! >= start && match.index! < end))
    .at(-1);
  if (conclusion && conclusion.index! + conclusion[0].length > limit && conclusion[0].length <= 8192) {
    const head = text.slice(0, Math.max(0, limit - conclusion[0].length));
    return { output: `${head}\n\n[已截断中间内容，完整内容请查看步骤输出或实时流]\n${conclusion[0]}`,
      outputBytes, truncated: true };
  }
  return {
    output: `${text.slice(0, limit)}\n\n[已截断 ${text.length - limit} 字，完整内容请查看步骤输出或实时流]`,
    outputBytes,
    truncated: true,
  };
}

export function appendRuntimeOutputPreview(
  currentPreview: string,
  delta: string,
  limit = DEFAULT_RUNTIME_OUTPUT_PREVIEW_LIMIT
): { output: string; outputBytes: number; truncated: boolean } {
  const current = typeof currentPreview === 'string' ? currentPreview : '';
  const nextDelta = typeof delta === 'string' ? delta : '';
  return compactRuntimeOutputPreview(`${current}${nextDelta}`, limit);
}
