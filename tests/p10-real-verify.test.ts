import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { checkReportConsistency } from '../src/lib/workflow/diagnosis-script-step';

// 用 #3071 真实归档报告做端到端验证：P10 修复后不再报 android_evidence_contradiction。
describe('P10 真实数据验证（#3071 归档报告）', () => {
  it('真实 #3071 报告 + 真实归档文件清单 → 不报 android_evidence_contradiction', () => {
    const d = join(homedir(), '.aceharness/runs/run-1794719184021-ia-be27e091/outputs');
    if (!existsSync(d)) { console.log('skip: 归档目录不存在'); return; }
    const reportFile = readdirSync(d).find((f) => /2026-.*报告沉淀.*\.md$/.test(f) && !f.endsWith('.raw'));
    if (!reportFile) { console.log('skip: 未找到报告'); return; }
    const reportText = readFileSync(join(d, reportFile), 'utf8');
    const archiveNames = readdirSync(d);
    const warnings = checkReportConsistency({
      reportText,
      archiveNames,
      verificationStatus: 'needs_runtime_validation',
    });
    console.log('真实报告:', reportFile);
    console.log('归档 android 证据:', archiveNames.filter((n) => /logcat|android/i.test(n)));
    console.log('全部告警:', JSON.stringify(warnings.map((w) => w.code)));
    expect(archiveNames.some((n) => /logcat|android/i.test(n))).toBe(true); // 确保前提成立
    expect(warnings.map((w) => w.code)).not.toContain('android_evidence_contradiction');
  });
});
