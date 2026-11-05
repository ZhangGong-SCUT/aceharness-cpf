import { describe, expect, it } from 'vitest';
import {
  assessLocaleGoldenLog, claimedOkMultiplier, checkReportConsistency, classifyEvidencePresence,
  deviceSnapshotTransition, goldenFlagDeviation, isPatchExpected, resolveRootCauseSummary,
} from '../src/lib/workflow/diagnosis-script-step';

const FIX_HILOG = [
  'expected MaterialApp locale from native list: null',
  'L1 OK: dispatcher.locales length (5) matches native preferred language list length (0)',
  'L2 OK: MaterialApp resolved en_US',
  'expected MaterialApp locale from native list: en_US',
  'L1 OK: dispatcher.locales length (5) matches native preferred language list length (5)',
  'L2 OK: MaterialApp resolved en_US',
].join('\n');

describe('locale 判定计数', () => {
  it('native 长度为 0 的 OK 与 expected=null 的 L2 OK 不计入有效通过', () => {
    const result = assessLocaleGoldenLog(FIX_HILOG);
    expect(result.false_ok).toEqual({ L1: 1, L2: 1 });
    expect(result.valid_ok).toEqual({ L1: 1, L2: 1 });
    expect(result.executed_native_count).toBe(5);
  });

  it('显式 INDETERMINATE 与长度为 1 的相等 OK 分开计数', () => {
    const result = assessLocaleGoldenLog([
      'L1 INDETERMINATE: native list not ready',
      'L1 OK: dispatcher.locales length (1) matches native preferred language list length (1)',
      'L1 BUG REPRODUCED: native has 5 preferred languages but PlatformDispatcher.locales length == 1',
    ].join('\n'));
    expect(result.indeterminate.L1).toBe(1);
    expect(result.precondition_not_met.L1).toBe(1);
    expect(result.valid_bug.L1).toBe(1);
    expect(result.valid_ok.L1).toBe(0);
    expect(result.executed_native_count).toBe(5);
  });

  it('正文里的 L1 OK×N 取数字', () => {
    expect(claimedOkMultiplier('hilog 里 L1 OK×2 / L2 OK×2', 'L1')).toBe(2);
    expect(claimedOkMultiplier('没有倍数', 'L1')).toBeNull();
  });
});

describe('黄金标志 deviation 与继承摘要', () => {
  it('冻结串写 2、实测为 5，且通过条件是同长时只记录 deviation', () => {
    const frozen = 'native has 2 preferred languages（修复后判据：与 native 列表同长）';
    expect(goldenFlagDeviation(frozen, 5)).toMatchObject({
      frozen_count: 2, executed_count: 5, compatible_with_pass_rule: true, approved_by: null,
    });
    expect(goldenFlagDeviation(frozen, 2)).toBeNull();
  });

  it('回退到父 run 摘要时加上来源头', () => {
    const resolved = resolveRootCauseSummary('', '未动 repo/ 与 repo-engine/（两仓干净）', 'run-parent', '');
    expect(resolved.provenance).toEqual({ source_run_id: 'run-parent', inherited: true });
    expect(resolved.text.startsWith('[继承自 run run-parent，证据路径以该 run 归档为准]')).toBe(true);
    expect(resolved.text).toContain('两仓干净');
  });

  it('本轮自己的摘要不打继承头', () => {
    const resolved = resolveRootCauseSummary('本轮新根因', '父轮旧文', 'run-parent', '');
    expect(resolved).toEqual({ text: '本轮新根因', provenance: { source_run_id: null, inherited: false } });
  });
});

describe('patch 是否必须存在', () => {
  it('只改引擎仓时，空的 fix.patch 不适用', () => {
    expect(isPatchExpected('fix.patch', 'framework_library', false, true)).toBe(false);
    expect(isPatchExpected('fix-engine.patch', 'framework_library', false, true)).toBe(true);
  });

  it('框架归属且两边都没有 diff 时，仍要求 fix.patch', () => {
    expect(isPatchExpected('fix.patch', 'framework_library', false, false)).toBe(true);
    expect(isPatchExpected('fix-engine.patch', 'framework_library', false, false)).toBe(false);
  });

  it('business_code 两边都不要求 patch', () => {
    expect(isPatchExpected('fix.patch', 'business_code', false, false)).toBe(false);
    expect(isPatchExpected('fix-engine.patch', 'business_code', true, true)).toBe(false);
  });
});

describe('证据位置与设备状态转变', () => {
  it('工作区没有、父 run 有，算继承；两边都没有算 broken', () => {
    expect(classifyEvidencePresence({ work: false, archive: false, parent: true })).toBe('inherited');
    expect(classifyEvidencePresence({ work: false, archive: true, parent: true })).toBe('archive_only');
    expect(classifyEvidencePresence({ work: false, archive: false, parent: false })).toBe('broken');
  });

  it('预检无设备且结论写实测、又没有快照时告警', () => {
    const warnings = checkReportConsistency({
      reportText: '真机实测 confirmed',
      archiveNames: [],
      verificationStatus: 'verified',
      preflightBlocked: true,
      environmentTransitions: [],
    });
    expect(warnings.map((warning) => warning.code)).toContain('env_transition_unexplained');
  });

  it('device-snapshot 说明后来接入了设备时不告警', () => {
    const environment = deviceSnapshotTransition(
      { runtime_validation: 'blocked_environment', ohos_device_count: 0, android_device_count: 0 },
      { checked_at: '2026-10-26T11:54:00.000Z', hdc_targets: ['6HK0125B07000225'], adb_devices: [] },
    );
    const warnings = checkReportConsistency({
      reportText: '真机实测 confirmed',
      archiveNames: [],
      verificationStatus: 'verified',
      preflightBlocked: environment.blocked,
      environmentTransitions: environment.transitions,
    });
    expect(environment.transitions).toHaveLength(1);
    expect(warnings.map((warning) => warning.code)).not.toContain('env_transition_unexplained');
  });

  it('「未实测」不触发状态转变告警', () => {
    const warnings = checkReportConsistency({
      reportText: '本轮未实测，只做了静态分析',
      archiveNames: [],
      verificationStatus: 'needs_runtime_validation',
      preflightBlocked: true,
    });
    expect(warnings.map((warning) => warning.code)).not.toContain('env_transition_unexplained');
  });
});
