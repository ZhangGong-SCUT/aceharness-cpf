import { describe, expect, it } from 'vitest';
import { checkReportConsistency, inspectHarBuildProfile } from '../src/lib/workflow/diagnosis-script-step';

// run-1791779284762（#1919）修复验证的真实句式：明确说"本轮未重跑、复现阶段已覆盖"——
// 这是对旧证据的诚实复用说明，与归档中的 logcat 不矛盾（复核报告 R03 纠正的误报样本）
const HONEST_REUSE = '未执行：OHOS 真机安装/运行（无设备，不可抗）；Android 端本轮未重装跑（S3 测试+复现阶段 logcat 已覆盖，改动在 Android 路径外）';
// run-1791788111811（#1941）报告步骤完整输出里的真实矛盾句：绝对性声称未执行，
// 但归档存在 i1941_android_build.log 等 Android 证据（F06 最初发现的事实错误）
const F1941_CLAIM = '- **跨平台对照**： 未执行 Android/iOS 对照构建；推测为 OHOS 独有——"ohos" 目标值仅 OHOS 工具链 fork 产出，pub.dev 枚举含 ios/android/linux，无此断裂';

describe('checkReportConsistency（F06）', () => {
  it('#1941 真实矛盾：绝对性声称未执行 Android 对照但归档有证据 → 告警', () => {
    const warnings = checkReportConsistency({
      reportText: F1941_CLAIM,
      archiveNames: ['i1941_android_build.log', 'fix.patch'],
      verificationStatus: 'needs_runtime_validation',
    });
    expect(warnings.map((w) => w.code)).toContain('android_evidence_contradiction');
  });

  it('带"本轮/复现阶段已覆盖"限定的诚实复用陈述不报矛盾（#1919 句式）', () => {
    const warnings = checkReportConsistency({
      reportText: HONEST_REUSE,
      archiveNames: ['android-logcat.txt', 'fix.patch'],
      verificationStatus: 'needs_runtime_validation',
    });
    expect(warnings.map((w) => w.code)).not.toContain('android_evidence_contradiction');
  });

  it('无 Android 证据时不报该告警（避免冤枉诚实报告）', () => {
    const warnings = checkReportConsistency({
      reportText: F1941_CLAIM,
      archiveNames: ['fix.patch'],
      verificationStatus: 'needs_runtime_validation',
    });
    expect(warnings.map((w) => w.code)).not.toContain('android_evidence_contradiction');
  });

  it('已执行 Android 对照的诚实陈述不误报', () => {
    const warnings = checkReportConsistency({
      reportText: 'Android 对照已执行，logcat 未见异常。修复验证 pass。',
      archiveNames: ['android-logcat.txt'],
      verificationStatus: 'verified',
    });
    expect(warnings).toHaveLength(0);
  });

  it('报告声称 verified 但运行级状态不支持 → 告警', () => {
    const warnings = checkReportConsistency({
      reportText: '结论略。{"verdict":"pass","verification_status":"verified"}',
      archiveNames: [],
      verificationStatus: 'evidence_incomplete',
    });
    expect(warnings.map((w) => w.code)).toContain('verification_status_contradiction');
  });

  it('空报告不产生告警', () => {
    expect(checkReportConsistency({ reportText: '', archiveNames: ['android-logcat.txt'], verificationStatus: 'verified' })).toHaveLength(0);
  });
});

describe('inspectHarBuildProfile（F12）', () => {
  it('读取真实 release HAR 的构建模式', async () => {
    const har = '/home/flutter/.aceharness/runs/run-1789560381651-101538ea/outputs/flutter_embedding_release.har';
    const info = await inspectHarBuildProfile(har);
    // 文件可能随清理消失；存在时必须读出 release
    if (info) {
      expect(info.build_mode).toBe('release');
      expect(info.debug).toBe(false);
    }
  });
  it('不存在的文件返回 null 而不是抛异常', async () => {
    expect(await inspectHarBuildProfile('/no/such/file.har')).toBeNull();
  });
});
