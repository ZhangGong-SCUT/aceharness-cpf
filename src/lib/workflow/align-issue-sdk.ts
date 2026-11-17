/** 首次诊断与迭代恢复共用的 Issue SDK 隔离入口。 */
import { createSdkOverlay } from '@/lib/workflow/sdk-overlay';
import { alignVersionToTag, normalizeIssueCreatedAt, planVersionAlign } from '@/lib/workflow/version-align';
import type { ResolvedOhosFlutterSdk } from '@/lib/workflow/ohos-flutter-sdk';

export interface IssueSdkAlignmentTarget {
  preciseTag?: string | null;
  collectorCommit?: string | null;
  issueCreatedAt?: string | null;
  branch?: string | null;
}

/** 失败必须显式阻断；函数不会用共享 SDK HEAD 代替解析失败的历史版本。 */
export async function prepareIssueSdkOverlay(input: {
  resolved: ResolvedOhosFlutterSdk;
  overlayDir: string;
  target: IssueSdkAlignmentTarget;
}): Promise<ResolvedOhosFlutterSdk> {
  const { resolved, overlayDir, target } = input;
  if (!resolved.matched || !resolved.sdkRoot) return resolved;
  const plan = await planVersionAlign({ sdkRoot: resolved.sdkRoot, ...target, preciseTag: target.preciseTag || null });
  const issueCreatedAt = normalizeIssueCreatedAt(target.issueCreatedAt);
  const historyRequired = !!(target.preciseTag || target.collectorCommit || issueCreatedAt);
  let source = resolved.sdkRoot;
  let meta: NonNullable<ResolvedOhosFlutterSdk['versionAlign']> = {
    targetTag: plan.targetTag, targetCommit: plan.targetCommit, source: plan.source,
    issueCreatedAt, historyRequired, aligned: plan.targetCommit === plan.currentCommit && !!plan.targetCommit,
    precacheOk: false, artifactVerified: false, alignedSdkRoot: null, reason: plan.reason,
  };
  if (plan.needed && plan.targetCommit) {
    const result = await alignVersionToTag({ sdkRoot: resolved.sdkRoot, targetTag: plan.targetTag,
      targetCommit: plan.targetCommit, overlayDir, precache: true });
    meta = {
      ...meta, targetCommit: result.targetCommit || plan.targetCommit, repositoryRoot: resolved.sdkRoot,
      aligned: result.aligned, precacheOk: result.precacheOk, artifactVerified: result.artifactVerified,
      expectedEngine: result.expectedEngine, expectedOhosEngine: result.expectedOhosEngine,
      actualEngine: result.actualEngine, actualOhosEngine: result.actualOhosEngine,
      alignedSdkRoot: result.aligned ? result.alignedSdkRoot : null,
    reason: result.error ? `${result.reason}：${result.error}` : result.reason,
  };
  if (result.aligned && result.alignedSdkRoot) source = result.alignedSdkRoot;
  } else if (historyRequired && plan.targetCommit && plan.targetCommit === plan.currentCommit) {
    // 当前 HEAD 与目标相同，也可能残留其他版本的 cache。不能仅凭 tag/commit 宣称引擎已对齐。
    meta.repositoryRoot = resolved.sdkRoot;
    const result = await alignVersionToTag({ sdkRoot: resolved.sdkRoot,
      targetTag: plan.targetTag, targetCommit: plan.targetCommit, overlayDir, precache: true });
    meta = {
      ...meta, repositoryRoot: resolved.sdkRoot,
      aligned: result.aligned, precacheOk: result.precacheOk, artifactVerified: result.artifactVerified,
      expectedEngine: result.expectedEngine, expectedOhosEngine: result.expectedOhosEngine,
      actualEngine: result.actualEngine, actualOhosEngine: result.actualOhosEngine,
      alignedSdkRoot: result.aligned ? result.alignedSdkRoot : null,
      reason: result.error ? `${result.reason}：${result.error}` : result.reason,
    };
    if (result.aligned && result.alignedSdkRoot) source = result.alignedSdkRoot;
  } else if (historyRequired) {
    throw new Error(`Issue 历史 SDK 无法解析，禁止以共享 SDK 当前 HEAD 复现：${plan.reason}`);
  }
  if (historyRequired && (!meta.aligned || !meta.artifactVerified)) {
    throw new Error(`Issue 历史 SDK 引擎未对齐，禁止以共享 SDK 产物复现：${meta.reason}`);
  }
  const overlay = createSdkOverlay(source, overlayDir);
  if (!overlay.flutterBin) throw new Error('SDK 副本缺少 Flutter 入口');
  return { ...resolved, versionAlign: meta, sdkRoot: overlay.sdkLink, flutterBin: overlay.flutterBin,
    sourceSdkRoot: source,
    reason: `${resolved.reason}（本 run 使用独立 SDK 副本，源路径：${source}）` };
}

/** 从旧 pin 恢复相同历史版本；不把 pin.alignedSdkRoot 当共享仓库使用。 */
export async function restoreIssueSdkOverlay(input: {
  resolved: ResolvedOhosFlutterSdk;
  overlayDir: string;
  originalPin: ResolvedOhosFlutterSdk | null;
  branch: string;
}): Promise<ResolvedOhosFlutterSdk> {
  const previous = input.originalPin?.versionAlign;
  const sharedRoot = previous?.repositoryRoot || input.resolved.sdkRoot || undefined;
  const targetCommit = previous?.targetCommit;
  if (sharedRoot && targetCommit && previous?.historyRequired) {
    // 不重新按时间选，续跑必须严格使用首次保存的固定 commit。
    const result = await alignVersionToTag({ sdkRoot: sharedRoot, targetCommit,
      overlayDir: input.overlayDir, precache: true });
    if (!result.aligned || !result.alignedSdkRoot || !result.artifactVerified) {
      throw new Error(`续跑无法恢复原 Issue SDK：${result.reason} ${result.error || ''}`);
    }
    const overlay = createSdkOverlay(result.alignedSdkRoot, input.overlayDir);
    if (!overlay.flutterBin) throw new Error('续跑 SDK 副本缺少 Flutter 入口');
    return { ...input.resolved, sdkRoot: overlay.sdkLink, flutterBin: overlay.flutterBin,
      sourceSdkRoot: result.alignedSdkRoot,
      versionAlign: { ...previous, repositoryRoot: sharedRoot, targetCommit: result.targetCommit || targetCommit,
        aligned: true, precacheOk: true, artifactVerified: true,
        expectedEngine: result.expectedEngine, expectedOhosEngine: result.expectedOhosEngine,
        actualEngine: result.actualEngine, actualOhosEngine: result.actualOhosEngine,
        alignedSdkRoot: result.alignedSdkRoot, reason: result.reason },
      reason: `${input.resolved.reason}（已恢复 Issue 历史 SDK 独立副本）` };
  }
  return prepareIssueSdkOverlay({ resolved: input.resolved, overlayDir: input.overlayDir,
    target: { collectorCommit: targetCommit || undefined, branch: input.branch } });
}
