import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ResolvedOhosFlutterSdk } from '@/lib/workflow/ohos-flutter-sdk';

export type IssueRevisionExpectation = {
  framework: string;
  engine: string;
  requirement: 'strict' | 'advisory';
  source: string;
};

/** 仅解析采集到的 Issue 环境信息，不把其他版本的旁证当成目标 revision。 */
export function extractIssueRevisionExpectation(text: string): IssueRevisionExpectation | null {
  const environment = String(text || '').match(/"environment_info"\s*:\s*\{([\s\S]*?)\}/)?.[1] || '';
  const fields = (name: string) => {
    const match = environment.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`, 'i'));
    return match?.[1] && match[1] !== 'missing' ? match[1] : '';
  };
  const explicitFramework = fields('framework_revision');
  const explicitEngine = fields('engine_revision');
  // 兼容旧采集结果：只取明确标为「异常」的 Framework revision，不猜正常版。
  const pairs = [...String(text || '').matchAll(/([0-9a-f]{7,40})(?:（|\s*\()(正常|异常)(?:）|\))/gi)];
  const abnormal = pairs.find(pair => pair[2] === '异常')?.[1]
    || String(text || '').match(/(?:异常|bug(?:gy)?|affected)[^\n]{0,100}?([0-9a-f]{7,40})/i)?.[1] || '';
  const engineVersion = fields('engine_version').match(/\b[0-9a-f]{7,40}\b/i)?.[0] || '';
  const framework = explicitFramework || abnormal || '';
  const engine = explicitEngine || engineVersion;
  const combined = String(text || '').match(
    /Flutter\s+([0-9][\w.-]*)\s*(?:&|和)\s*([0-9][\w.-]*)\s*\|\s*framework\s*([0-9a-f]{7,40})\s*\|\s*engine\s*([0-9a-f]{7,40})/i,
  );
  const expectedFramework = framework || combined?.[3] || '';
  const expectedEngine = engine || combined?.[4] || '';
  if (!expectedFramework && !expectedEngine) return null;
  // 同一行的 Flutter A & B 表示作者已枚举多个受影响版本，不能擅自选定其中一个。
  const requirement = explicitFramework || explicitEngine ? 'strict' : 'advisory';
  return { framework: expectedFramework, engine: expectedEngine, requirement, source: combined?.[0] || 'environment_info' };
}

export function readFlutterSdkRevisions(pin: Pick<ResolvedOhosFlutterSdk, 'sourceSdkRoot' | 'sdkRoot'>): { framework: string | null; engine: string | null } {
  const root = pin.sourceSdkRoot || pin.sdkRoot;
  if (!root || !existsSync(root)) return { framework: null, engine: null };
  let framework: string | null = null;
  let engine: string | null = null;
  try {
    framework = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { /* SDK 可以是非 Git 发布包。 */ }
  try {
    engine = readFileSync(join(root, 'bin', 'cache', 'engine.version'), 'utf8').trim() || null;
  } catch { /* 缺失时保留 unknown，不得猜测。 */ }
  return { framework, engine };
}

export function isRevisionMatch(actual: string | null | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = actual.trim().toLowerCase();
  const right = expected.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(right) || !/^[0-9a-f]{40}$/.test(left)) return false;
  // 短 SHA 只允许作为完整 40 位提交号的前缀，不能比较两个缩写猜一致。
  return left.startsWith(right);
}

export function buildRevisionEvidence(input: {
  expected: IssueRevisionExpectation | null;
  actual: { framework: string | null; engine: string | null };
  verification?: { framework?: unknown; engine?: unknown };
}) {
  if (!input.expected) return { status: 'not_required', mismatches: [] as string[], expected: null, actual: input.actual, verification: null };
  const mismatches: string[] = [];
  const unknown: string[] = [];
  if (input.expected.framework) {
    if (!input.actual.framework) unknown.push('sdk_framework_revision');
    else if (!isRevisionMatch(input.actual.framework, input.expected.framework)) mismatches.push('sdk_framework_revision');
  }
  if (input.expected.engine) {
    if (!input.actual.engine) unknown.push('sdk_engine_revision');
    else if (!isRevisionMatch(input.actual.engine, input.expected.engine)) mismatches.push('sdk_engine_revision');
  }
  const verification = {
    framework: typeof input.verification?.framework === 'string' ? input.verification.framework : null,
    engine: typeof input.verification?.engine === 'string' ? input.verification.engine : null,
  };
  const declaredMismatches: string[] = [];
  if (input.expected.framework && !isRevisionMatch(verification.framework, input.expected.framework)) declaredMismatches.push('verification_framework_revision');
  if (input.expected.engine && !isRevisionMatch(verification.engine, input.expected.engine)) declaredMismatches.push('verification_engine_revision');
  return { status: mismatches.length ? 'mismatch' : unknown.length ? 'unknown' : 'matched', mismatches, unknown, declaredMismatches, expected: input.expected, actual: input.actual, verification };
}

export function revisionEvidenceText(root: string): string {
  const pinFile = join(root, 'outputs', 'ohos-flutter-sdk.json');
  if (!existsSync(pinFile)) return '';
  try {
    const pin = JSON.parse(readFileSync(pinFile, 'utf8'));
    const source = pin.sourceSdkRoot || pin.sdkRoot;
    if (!source) return '';
    return `\n# Issue 指定版本 SDK（机器只读核对，不等于运行环境已对齐）\nsource_sdk_root: ${resolve(source)}\nsdk_revision_evidence: ${JSON.stringify(readFlutterSdkRevisions(pin))}\n不要把理论复现、替代 API/设备/版本的结果写成原始 Issue 已复现或修复已验证。`;
  } catch { return ''; }
}
