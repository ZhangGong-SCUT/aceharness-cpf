import { describe, expect, it } from 'vitest';
import { checkReportConsistency, inspectHarBuildProfile } from '../src/lib/workflow/diagnosis-script-step';

// R6（run-1791779284762）修复验证步骤的真实句式：声称 Android 本轮未重装跑，
// 但归档里存在 android-logcat.txt（复现阶段已抓）——报告与证据矛盾
const R6_STYLE = '未执行：OHOS 真机安装/运行（无设备，不可抗）；Android 端本轮未重装跑（S3 测试+复现阶段 logcat 已覆盖，改动在 Android 路径外）';

describe('checkReportConsistency（F06）', () => {
  it('R6 型：声称 Android 未跑但归档有 logcat → 告警', () => {
    const warnings = checkReportConsistency({
      reportText: R6_STYLE,
      archiveNames: ['android-logcat.txt', 'fix.patch'],
      verificationStatus: 'needs_runtime_validation',
    });
    expect(warnings.map((w) => w.code)).toContain('android_evidence_contradiction');
  });

  it('无 Android 证据时不报该告警（避免冤枉诚实报告）', () => {
    const warnings = checkReportConsistency({
      reportText: R6_STYLE,
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
