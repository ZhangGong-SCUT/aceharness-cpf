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
  // 标签必须按"就近配对"处理：引文（如 grep 结果）里未闭合的 <step-conclusion>
  // 会让贪婪匹配从引文一路吞到真实结论的闭合标签，形成一个超大伪匹配，
  // 既被工具区过滤误杀、又超过保留上限——#1761 的真实结论因此丢失。
  const conclusion = findStepConclusionSpans(text)
    .filter((span) => !toolRanges.some(([start, end]) => span.start >= start && span.start < end))
    .at(-1);
  if (conclusion && conclusion.end > limit && (conclusion.end - conclusion.start) <= 8192) {
    const head = text.slice(0, Math.max(0, limit - (conclusion.end - conclusion.start)));
    return { output: `${head}\n\n[已截断中间内容，完整内容请查看步骤输出或实时流]\n${text.slice(conclusion.start, conclusion.end)}`,
      outputBytes, truncated: true };
  }
  return {
    output: `${text.slice(0, limit)}\n\n[已截断 ${text.length - limit} 字，完整内容请查看步骤输出或实时流]`,
    outputBytes,
    truncated: true,
  };
}

/**
 * 就近配对扫描 <step-conclusion>…</step-conclusion> 区间：
 * 每个闭合标签与"上一个闭合之后最近的一个未配对开标签"配对；
 * 引文里未闭合的开标签被后续开标签覆盖，不会吞并真实结论。
 */
export function findStepConclusionSpans(text: string): Array<{ start: number; end: number; content: string }> {
  const spans: Array<{ start: number; end: number; content: string }> = [];
  const tagRegex = /<\/?step-conclusion>/gi;
  let openIndex: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(text)) !== null) {
    if (match[0].startsWith('</')) {
      if (openIndex !== null) {
        const end = match.index + match[0].length;
        spans.push({ start: openIndex, end, content: text.slice(openIndex, end) });
        openIndex = null;
      }
    } else {
      openIndex = match.index;
    }
  }
  return spans;
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
