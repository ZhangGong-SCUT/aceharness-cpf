import { describe, expect, test } from 'vitest';
import { appendRuntimeOutputPreview, compactRuntimeOutputPreview, findStepConclusionSpans } from '@/lib/run/output-compaction';

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

  // #1761 真实事故：修复验证输出里 grep 结果引用了他文的 <step-conclusion> 开标签（未闭合），
  // 贪婪匹配会从引文开标签一路吞到真实结论的闭合标签，伪匹配起点在工具区内被过滤，
  // 导致 32KB 输出按头截断、真实 conditional_pass 结论（含原因）丢失。
  test('retains real conclusion when tool output quotes an unclosed opening tag (#1761 regression)', () => {
    const quoted = '<ace-process>{"toolName":"grep","output":"Line 5: <step-conclusion>\\n6: - verdict: pass（他文引用）"}</ace-process>';
    const real = '<step-conclusion>{"verdict":"conditional_pass","summary":"无 OHOS 设备，运行时黄金标志待真机"}</step-conclusion>';
    const text = 'noise '.repeat(3000) + quoted + 'middle '.repeat(400) + real;
    const data = compactRuntimeOutputPreview(text, 4000);
    expect(data.truncated).toBe(true);
    expect(data.output).toContain(real);
    expect(data.output).toContain('conditional_pass');
  });

  test('unclosed opening tag does not swallow the real conclusion span', () => {
    const text = '<step-conclusion>orphan quote without close\n更多引用内容\n'
      + '<step-conclusion>{"verdict":"pass"}</step-conclusion>';
    const spans = findStepConclusionSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].content).toBe('<step-conclusion>{"verdict":"pass"}</step-conclusion>');
  });
});
