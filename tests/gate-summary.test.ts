import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import {
  stripHtml, extractFailureItems, classifyFailure, gateStatusLine, gateChecklistLine, gateNextStepLines, loadGateSummary,
} from '@/lib/notify/gate-summary';

/**
 * 真实数据回归：engine #1531 的 run（门禁 3 绿 + submit + 审批 → 09:03:48 合入成功）。
 * 该 run 曾触发"已合入 PR 却收到失败措辞邮件"的问题（⚠️ unknown + 失败原因），
 * 此处锁定 merged 分支的渲染行为。
 */
const real = JSON.parse(readFileSync('/home/flutter/.aceharness/runs/run-1789432038017-pr1531-4c4c787d/outputs/gate-check.json', 'utf8'));

describe('gate-summary（真实数据回归：已合入的 engine #1531）', () => {
  it('loadGateSummary 解析 merged/closed，状态行为成功终点', () => {
    const gate = loadGateSummary('run-1789432038017-pr1531-4c4c787d')!;
    expect(gate.merged).toBe(true);
    expect(gate.closed).toBe(true);
    expect(gateStatusLine(gate)).toContain('PR 已合入');
    expect(gateStatusLine(gate)).not.toContain('unknown');
  });

  it('五环节清单反映最终 3 绿（engine 无冒烟项）', () => {
    const gate = loadGateSummary('run-1789432038017-pr1531-4c4c787d')!;
    const line = gateChecklistLine(gate);
    expect(line).toContain('DCO ✓');
    expect(line).toContain('静态 ✓');
    expect(line).toContain('编译 ✓');
  });

  it('已合入的下一步 = 无需任何操作', () => {
    const gate = loadGateSummary('run-1789432038017-pr1531-4c4c787d')!;
    const next = gateNextStepLines(gate);
    expect(next.join('')).toContain('无需任何操作');
  });

  it('合入评论（代码门禁通过）中无失败项', () => {
    const items = extractFailureItems(stripHtml(real.latest_ci_comment));
    expect(items.length).toBe(0);
  });
});

describe('gate-summary（合成场景）', () => {
  it('纯超时分类为平台抖动', () => {
    const items = extractFailureItems('1 oh-dev_flutter failed(IGNORE)(ecotest timeout) NA >>>');
    expect(classifyFailure(items).kind).toBe('timeout');
  });

  it('含空格原因（compile failed）完整提取', () => {
    const items = extractFailureItems('1 flutter_3.35.7-test_flutter failed(compile failed) NA >>>');
    expect(items[0]).toEqual({ stage: 'flutter_3.35.7-test_flutter', cause: 'compile failed' });
    expect(classifyFailure(items).kind).toBe('compile');
  });

  it('未合入的 closed：状态行与下一步', () => {
    const gate = { ...real, merged: false, closed: true, phase: 'unknown' } as any;
    expect(gateStatusLine(gate)).toContain('PR 已关闭（未合入）');
    expect(gateNextStepLines(gate).join('')).toContain('重新打开');
  });
});
