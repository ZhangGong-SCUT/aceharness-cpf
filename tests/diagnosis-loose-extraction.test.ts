import { describe, expect, it } from 'vitest';
import {
  extractConditionalReason,
  extractInlineKeyValues,
  extractLooseStructuredResult,
  extractProseVerdict,
  flattenNestedContainers,
  getStepConclusionJson,
} from '../src/lib/ai/result-channel';

// 取自 R7（run-1791795431915-ia-d902a301）修复验证步骤的真实输出片段：
// Agent 在 <step-conclusion> 标签里写的是 Markdown 散文而非 JSON。
const R7_FIX_VERIFICATION_REAL = `
## 结果 / 裁决
- 修复验证 **pass**。独立重跑（pin SDK 3.44.9-ohos）：GOLDEN 回归测试 2/2 通过（修复前失败证据 outputs/real-code-test-output.txt，Actual='3.41.10-ohos-1.0.1' 即 bug 现象）；官方 upgrade_test.dart 38 passed / 6 skipped。issue_golden_flag_met=true，engine_aligned=true，bug_fixed=true。

## 下一步所需上下文
- 黄金标志（已达成，报告阶段直接引用）：flutter major.minor 相同时 +ohos 优先
`;

describe('getStepConclusionJson', () => {
  it('解析脚本步骤的 JSON step-conclusion', () => {
    const md = '<step-conclusion>{"verdict":"pass","summary":"归档完成"}</step-conclusion>';
    expect(getStepConclusionJson(md)).toEqual({ verdict: 'pass', summary: '归档完成' });
  });

  it('跳过 Agent 写的 Markdown 型 step-conclusion', () => {
    expect(getStepConclusionJson(`<step-conclusion>${R7_FIX_VERIFICATION_REAL}</step-conclusion>`)).toBeNull();
  });
});

describe('extractInlineKeyValues', () => {
  it('从真实 R7 散文提取布尔字段（中文逗号分隔）', () => {
    const fields = extractInlineKeyValues(R7_FIX_VERIFICATION_REAL);
    expect(fields.issue_golden_flag_met).toBe(true);
    expect(fields.engine_aligned).toBe(true);
    expect(fields.bug_fixed).toBe(true);
  });

  it('布尔白名单字段不接受非布尔值，字符串字段去 markdown 装饰', () => {
    const fields = extractInlineKeyValues('issue_golden_flag_met=大概吧，verdict=**pass**。');
    expect('issue_golden_flag_met' in fields).toBe(false);
    expect(fields.verdict).toBe('pass');
  });

  it('首次出现优先', () => {
    const fields = extractInlineKeyValues('verdict=fail。后续又说 verdict=pass');
    expect(fields.verdict).toBe('fail');
  });

  it('顿号并列的布尔字段各自入库，false 不被后面的 true 覆盖', () => {
    const line = 'engine_aligned=true、issue_golden_flag_met=true、bug_fixed=false、issue_resolved=yes。';
    const fields = extractInlineKeyValues(line);
    expect(fields.engine_aligned).toBe(true);
    expect(fields.issue_golden_flag_met).toBe(true);
    expect(fields.bug_fixed).toBe(false);
  });
});

describe('extractProseVerdict', () => {
  it('识别显式 verdict 标记', () => {
    expect(extractProseVerdict('{"verdict":"conditional_pass"}')).toBe('conditional_pass');
    expect(extractProseVerdict('verdict: pass')).toBe('pass');
  });

  it('识别「修复验证 **pass**」句式', () => {
    expect(extractProseVerdict(R7_FIX_VERIFICATION_REAL)).toBe('pass');
  });

  it('否定语境不取', () => {
    expect(extractProseVerdict('修复验证未能 pass 的草案被驳回')).toBeNull();
    expect(extractProseVerdict('修复验证： 不 pass 就回退')).toBeNull();
  });
});

describe('flattenNestedContainers', () => {
  it('顶层优先，容器回退', () => {
    const flat = flattenNestedContainers({
      verdict: 'pass',
      run_verification: { issue_golden_flag_met: true, engine_aligned: false },
      result: { bug_fixed: true },
    });
    expect(flat).toMatchObject({ verdict: 'pass', issue_golden_flag_met: true, engine_aligned: false, bug_fixed: true });
  });
});

describe('extractConditionalReason（F04，用 R5 真实散文）', () => {
  it('识别"conditional_pass 的唯一原因：无 OHOS 设备（hdc 为空）"', () => {
    const r5 = '修复验证 verdict=conditional_pass：6 处修改全部落位且针对根因；独立重跑 demo 测试 2/2 通过。conditional_pass 的唯一原因：无 OHOS 设备（hdc 为空）。';
    expect(extractConditionalReason(r5)).toBe('无 OHOS 设备（hdc 为空）');
  });
  it('结构化 conditional_reason 与缺省情况', () => {
    expect(extractConditionalReason('{"verdict":"conditional_pass","conditional_reason":"缺 Android 模拟器"}')).toBe('缺 Android 模拟器');
    expect(extractConditionalReason('verdict=pass')).toBeNull();
    expect(extractConditionalReason('')).toBeNull();
  });

  it('原因后面用顿号接另一个字段时，不把后一个字段算进原因', () => {
    expect(extractConditionalReason('conditional_reason=缺设备、bug_fixed=false')).toBe('缺设备');
    expect(extractConditionalReason('conditional_pass 的唯一原因：无 OHOS 设备、bug_fixed=true。')).toBe('无 OHOS 设备');
  });
});

describe('extractLooseStructuredResult 综合', () => {
  it('真实 R7 输出：verdict 与三个布尔标志全部迁移', () => {
    const { fields, sources } = extractLooseStructuredResult(R7_FIX_VERIFICATION_REAL);
    expect(fields.verdict).toBe('pass');
    expect(fields.issue_golden_flag_met).toBe(true);
    expect(fields.engine_aligned).toBe(true);
    expect(fields.bug_fixed).toBe(true);
    expect(sources.issue_golden_flag_met).toBe('inline-fields');
    expect(sources.verdict).toBe('prose-verdict');
  });

  it('script JSON 优先于散文；缺失字段不伪造', () => {
    const md = '<step-conclusion>{"verdict":"fail","error_code":"io_error"}</step-conclusion>\n散文 verdict=pass。';
    const { fields, sources } = extractLooseStructuredResult(md);
    expect(fields.verdict).toBe('fail');
    expect(sources.verdict).toBe('step-conclusion-json');
    expect('bug_fixed' in fields).toBe(false);
  });

  it('围栏 JSON 没有 bug_fixed 时，顿号并列的后文仍补上三个标志', () => {
    const md = [
      '```json',
      '{"verdict":"pass","remaining_issues":0,"summary":"修复后真机黄金标志通过"}',
      '```',
      'engine_aligned=true、issue_golden_flag_met=true、bug_fixed=true、issue_resolved=yes、root_cause_coverage=covered、regression_risk=低。',
    ].join('\n');
    const { fields, sources } = extractLooseStructuredResult(md);
    expect(fields.verdict).toBe('pass');
    expect(fields.engine_aligned).toBe(true);
    expect(fields.issue_golden_flag_met).toBe(true);
    expect(fields.bug_fixed).toBe(true);
    expect(sources.bug_fixed).toBe('inline-fields');
  });

  it('正文只写黄金标志通过时，补上 issue_golden_flag_met', () => {
    const md = [
      '**verdict: pass**',
      '- **黄金标志**（沿用复现阶段锁定，未修订）：L1==L2(≥2) 且逐项有序一致 → OK。',
      '```json',
      '{"verdict":"pass","summary":"修复后真机实测黄金标志通过"}',
      '```',
    ].join('\n');
    const { fields, sources } = extractLooseStructuredResult(md);
    expect(fields.issue_golden_flag_met).toBe(true);
    expect(sources.issue_golden_flag_met).toBe('inline-fields');
  });

  it('嵌套容器字段可被顶层读取', () => {
    const md = '<result>{"verdict":"pass","run_verification":{"issue_golden_flag_met":true}}</result>';
    const { fields } = extractLooseStructuredResult(md);
    expect(fields.issue_golden_flag_met).toBe(true);
  });
});
