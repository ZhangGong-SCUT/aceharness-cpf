import { describe, expect, it } from 'vitest';
import { checkReportConsistency, inspectHarBuildProfile } from '../src/lib/workflow/diagnosis-script-step';

// run-1791779284762（#1919）修复验证的真实句式：明确说"本轮未重跑、复现阶段已覆盖"——
// 这是对旧证据的诚实复用说明，与归档中的 logcat 不矛盾（复核报告 R03 纠正的误报样本）
const HONEST_REUSE = '未执行：OHOS 真机安装/运行（无设备，不可抗）；Android 端本轮未重装跑（S3 测试+复现阶段 logcat 已覆盖，改动在 Android 路径外）';
// run-1791788111811（#1941）报告步骤完整输出里的真实矛盾句：绝对性声称未执行，
// 但归档存在 i1941_android_build.log 等 Android 证据（F06 最初发现的事实错误）
const F1941_CLAIM = '- **跨平台对照**： 未执行 Android/iOS 对照构建；推测为 OHOS 独有——"ohos" 目标值仅 OHOS 工具链 fork 产出，pub.dev 枚举含 ios/android/linux，无此断裂';

describe('checkReportConsistency（F06）', () => {
  it('P10：#1941 无限定对照构建在引入模式豁免后仍判为矛盾', () => {
    // 确认 BUILD_MODE_QUALIFIER 不会误放 #1941（无 AOT/JIT/release/profile/debug 限定）。
    expect(/(AOT|JIT|release|profile|debug)/i.test(F1941_CLAIM)).toBe(false);
    const warnings = checkReportConsistency({
      reportText: F1941_CLAIM,
      archiveNames: ['i1941_android_build.log'],
      verificationStatus: 'needs_runtime_validation',
    });
    expect(warnings.map((w) => w.code)).toContain('android_evidence_contradiction');
  });


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

  // P10：run-1794719184021（#3071）报告 missing_evidence 的真实披露句——
  // 「未做」的宾语是带 AOT 模式限定的特定对照动作，与归档里的 android 运行日志不矛盾。
  const P3071_DISCLOSURE = '- 未做：原始毒 dill 直接对照（不可复得）、android/ios AOT 实测、Issue 分支对齐 SDK 验证。';
  it('P10：missing_evidence 披露「未做 android AOT 实测」（带模式限定）不报矛盾（#3071 句式）', () => {
    const warnings = checkReportConsistency({
      reportText: P3071_DISCLOSURE,
      archiveNames: ['android-logcat.txt', 'android-after.png', 'fix.patch'],
      verificationStatus: 'needs_runtime_validation',
    });
    expect(warnings.map((w) => w.code)).not.toContain('android_evidence_contradiction');
  });

  it('P10：无限定的「未做 Android 实测」仍判为矛盾（不过度放行）', () => {
    const warnings = checkReportConsistency({
      reportText: '未做 Android 实测。',
      archiveNames: ['android-logcat.txt'],
      verificationStatus: 'needs_runtime_validation',
    });
    expect(warnings.map((w) => w.code)).toContain('android_evidence_contradiction');
  });

  it('P10：#2925 缺失的是关闭 Impeller 的特定对照，不否认已有 Android 证据', () => {
    const warnings = checkReportConsistency({
      reportText: '- **跨平台对照**: Android 关闭 Impeller 对照未覆盖，OHOS 独有性结论待补',
      archiveNames: ['android-logcat.txt', 'android-after.png'],
      verificationStatus: 'needs_runtime_validation',
    });
    expect(warnings.map((w) => w.code)).not.toContain('android_evidence_contradiction');
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
