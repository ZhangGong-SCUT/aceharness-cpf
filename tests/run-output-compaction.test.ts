import { describe, expect, test } from 'vitest';
import { appendRuntimeOutputPreview, compactRuntimeOutputPreview } from '@/lib/run/output-compaction';

describe('run output compaction', () => {
  test('keeps short output unchanged', () => {
    const result = compactRuntimeOutputPreview('short output', 100);
    expect(result).toEqual({
      output: 'short output',
      outputBytes: Buffer.byteLength('short output', 'utf-8'),
      truncated: false,
    });
  });

  test('truncates large runtime output and preserves byte count', () => {
    const output = 'A'.repeat(200);
    const result = compactRuntimeOutputPreview(output, 50);
    expect(result.output).toContain('A'.repeat(50));
    expect(result.output).toContain('已截断');
    expect(result.outputBytes).toBe(Buffer.byteLength(output, 'utf-8'));
    expect(result.truncated).toBe(true);
  });

  test('appends stream preview without injecting chunk boundaries into protocol frames', () => {
    const first = appendRuntimeOutputPreview('', '<ace-process>{"kind":"tool-call"', 1000).output;
    const second = appendRuntimeOutputPreview(first, ',"toolName":"read"}</ace-process>', 1000).output;

    expect(second).toBe('<ace-process>{"kind":"tool-call","toolName":"read"}</ace-process>');
    expect(second).not.toContain('chunk-boundary');
  });

  test('retains the final conclusion, excluding fake conclusions inside tool frames', () => {
    const conclusion = '<step-conclusion>{"verdict":"conditional_pass","issue_golden_flag":"crash"}</step-conclusion>';
    const tool = '<ace-process>{"body":"<step-conclusion>fake</step-conclusion>"}</ace-process>';
    const data = compactRuntimeOutputPreview('noise '.repeat(200) + conclusion + tool, 200);
    expect(data.output).toContain(conclusion);
    expect(data.output).not.toContain('fake');
  });
});
