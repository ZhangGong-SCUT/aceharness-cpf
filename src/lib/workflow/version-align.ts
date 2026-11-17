/**
 * Issue 对应 Flutter SDK 版本对齐。
 *
 * 本地 SDK 只是同系列仓库来源，不代表 Issue 版本。对齐优先使用精确 tag，
 * 其次使用采集器确认的历史 commit，最后才按 Issue 创建时间查分支历史。
 * 只读解析在共享 SDK 上进行；写操作只发生在 run 的独立 worktree 和 cache。
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/i;

export function extractPreciseVersionTag(text: string): string | null {
  const match = String(text || '').match(/(\d+\.\d+\.\d+-ohos-\d+\.\d+\.\d+(?:-[A-Za-z0-9]+)?)/);
  return match?.[1] || null;
}

export function majorTripleOfTag(tag: string): string | null {
  return String(tag || '').match(/^(\d+\.\d+\.\d+)-ohos-/)?.[1] || null;
}

/** 3.35.7 与 3.35.8 属于同一 3.35 SDK 系列，补丁号差异可用 tag/commit 对齐。 */
export function sdkSeriesOf(version: string | null | undefined): string | null {
  return String(version || '').match(/^(\d+\.\d+)\./)?.[1] || null;
}

export function normalizeIssueCreatedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** 仅接受采集器 JSON 中实际成功的回退，不能从报告、截图或评论猜 commit。 */
export function historicalCommitFromCollection(fields: Record<string, unknown>): string | null {
  if (String(fields.reset_status || '') !== 'success') return null;
  const commit = String(fields.reset_target_merge_commit || fields.commit || '').trim();
  return SHA.test(commit) ? commit : null;
}

export interface VersionAlignPlan {
  needed: boolean;
  targetTag: string | null;
  targetCommit: string | null;
  source: 'precise_tag' | 'collector_commit' | 'issue_created_at';
  currentTag: string | null;
  currentCommit: string | null;
  tagExists: boolean;
  sameMajor: boolean;
  reason: string;
}

export async function planVersionAlign(input: {
  sdkRoot: string;
  preciseTag: string | null;
  branch?: string | null;
  issueCreatedAt?: string | null;
  collectorCommit?: string | null;
  exec?: typeof execFileAsync;
}): Promise<VersionAlignPlan> {
  const exec = input.exec || execFileAsync;
  const createdAt = normalizeIssueCreatedAt(input.issueCreatedAt);
  if (!input.preciseTag && !input.collectorCommit && !createdAt) {
    return { needed: false, targetTag: null, targetCommit: null, source: 'issue_created_at',
      currentTag: null, currentCommit: null, tagExists: false, sameMajor: false,
      reason: 'Issue 未声明精确 tag、已确认历史 commit 或创建时间，保持共享 SDK 基线' };
  }
  const base: VersionAlignPlan = {
    needed: false, targetTag: input.preciseTag, targetCommit: null,
    source: input.preciseTag ? 'precise_tag' : input.collectorCommit ? 'collector_commit' : 'issue_created_at',
    currentTag: null, currentCommit: null, tagExists: false, sameMajor: false, reason: '',
  };
  const git = async (...args: string[]) => (await exec('git', ['-C', input.sdkRoot, ...args], {
    timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })).stdout.trim();
  try { base.currentCommit = await git('rev-parse', 'HEAD'); } catch { /* 非 Git 发布包不能提供历史版本 */ }
  try { base.currentTag = await git('describe', '--tags'); } catch { /* detached/shallow 仓可能没有 tag */ }

  if (input.preciseTag) {
    const targetMajor = majorTripleOfTag(input.preciseTag);
    if (!targetMajor) return { ...base, reason: `tag 格式无法解析: ${input.preciseTag}` };
    if (base.currentTag && (base.currentTag === input.preciseTag || base.currentTag.startsWith(`${input.preciseTag}-`))) {
      return { ...base, targetCommit: base.currentCommit, reason: `本地 SDK 已处于 ${input.preciseTag}，无需派生源码副本` };
    }
    try {
      base.targetCommit = await git('rev-parse', '--verify', `refs/tags/${input.preciseTag}^{commit}`);
      base.tagExists = SHA.test(base.targetCommit);
    } catch { /* 缺少 tag 不得退回当前 HEAD */ }
    const currentMajor = base.currentTag ? majorTripleOfTag(base.currentTag) : null;
    base.sameMajor = !!targetMajor && !!currentMajor && sdkSeriesOf(targetMajor) === sdkSeriesOf(currentMajor);
    if (!base.tagExists) return { ...base, targetCommit: null, reason: `本地仓不存在 tag ${input.preciseTag}，需先 fetch；禁止使用当前 HEAD 替代` };
    if (!base.sameMajor) return { ...base, targetCommit: null, reason: `目标 ${input.preciseTag} 与本地 SDK（${base.currentTag || '未知'}）不属于同一 Flutter 系列，不对齐` };
    if (base.targetCommit === base.currentCommit) return { ...base, reason: `本地 SDK 已处于 ${input.preciseTag}，无需派生源码副本` };
    return { ...base, needed: true, reason: `按精确 tag ${input.preciseTag} 对齐到 ${base.targetCommit}` };
  }

  if (!base.currentCommit) return { ...base, reason: '共享 SDK 不是可读 Git 仓，无法解析 Issue 历史版本' };
  let commit: string;
  if (input.collectorCommit) {
    if (!SHA.test(input.collectorCommit)) return { ...base, reason: '采集器历史 commit 格式无效' };
    commit = input.collectorCommit;
  } else {
    if (!createdAt) return { ...base, reason: 'Issue 未声明精确 tag、已确认历史 commit 或创建时间，保持共享 SDK 基线' };
    const branch = input.branch?.trim();
    if (!branch || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) {
      return { ...base, reason: 'Issue 分支无效，无法按创建时间解析历史 SDK' };
    }
    let ref = `refs/remotes/origin/${branch}`;
    try { await git('rev-parse', '--verify', `${ref}^{commit}`); } catch { ref = `refs/heads/${branch}`; }
    try { commit = await git('rev-list', '-1', '--first-parent', `--before=${createdAt}`, ref); } catch { commit = ''; }
    if (!commit) return { ...base, reason: `分支 ${branch} 没有 ${createdAt} 之前的完整历史，需先补全历史；禁止用当前 HEAD 替代` };
  }
  try { commit = await git('rev-parse', '--verify', `${commit}^{commit}`); } catch {
    return { ...base, reason: '采集器确认的 commit 不在 SDK 仓中，禁止用当前 HEAD 替代' };
  }
  if (createdAt) {
    const timestamp = await git('show', '-s', '--format=%cI', commit).catch(() => '');
    const commitTime = new Date(timestamp).getTime();
    if (!Number.isFinite(commitTime) || commitTime >= new Date(createdAt).getTime()) {
      return { ...base, reason: `历史 commit ${commit} 的提交时间不在 Issue 创建时间 ${createdAt} 之前` };
    }
  }
  if (commit === base.currentCommit) return { ...base, targetCommit: commit, reason: `SDK 已处于 Issue 历史 commit ${commit}` };
  return { ...base, needed: true, targetCommit: commit, reason: `按 ${base.source === 'collector_commit' ? '采集器确认的 Issue 基线' : `Issue 创建时间 ${createdAt}`} 对齐到 ${commit}` };
}

export interface VersionAlignResult {
  aligned: boolean;
  alignedSdkRoot: string | null;
  targetTag: string | null;
  targetCommit: string | null;
  precacheOk: boolean;
  artifactVerified: boolean;
  expectedEngine: string | null;
  expectedOhosEngine: string | null;
  actualEngine: string | null;
  actualOhosEngine: string | null;
  reason: string;
  error?: string;
}

async function readStamp(root: string, name: string): Promise<string | null> {
  try { return (await readFile(join(root, 'bin', 'cache', name), 'utf8')).trim() || null; } catch { return null; }
}

export async function readExpectedEngineRevisions(sdkRoot: string): Promise<{ engine: string | null; ohosEngine: string | null }> {
  const read = async (name: string) => {
    try { return (await readFile(join(sdkRoot, 'bin', 'internal', name), 'utf8')).trim() || null; } catch { return null; }
  };
  return { engine: await read('engine.version'), ohosEngine: await read('engine.ohos.version') };
}

/** 不只检查退出码：precache 成功但残留共享 SDK 的二进制也算未对齐。 */
export async function verifyAlignedArtifacts(sdkRoot: string): Promise<Pick<VersionAlignResult,
  'artifactVerified' | 'expectedEngine' | 'expectedOhosEngine' | 'actualEngine' | 'actualOhosEngine' | 'reason'>> {
  const expected = await readExpectedEngineRevisions(sdkRoot);
  const actualEngine = await readStamp(sdkRoot, 'engine.stamp');
  const actualOhosEngine = await readStamp(sdkRoot, 'engine.ohos.stamp');
  const releaseHar = join(sdkRoot, 'bin', 'cache', 'artifacts', 'engine', 'ohos-arm64-release', 'arm64_v8a_release.har');
  const hasEngine = existsSync(join(sdkRoot, 'bin', 'cache', 'artifacts', 'engine', 'ohos-arm64', 'libflutter.so'))
    || (existsSync(releaseHar) && (() => {
      try { return execFileSync('tar', ['-tzf', releaseHar], { encoding: 'utf8', timeout: 10000 })
        .split(/\r?\n/).some(entry => /(?:^|\/)libflutter\.so$/.test(entry)); }
      catch { return false; }
    })());
  const mismatches = [
    expected.engine && actualEngine !== expected.engine ? `engine.stamp=${actualEngine || 'missing'}，预期 ${expected.engine}` : '',
    expected.ohosEngine && actualOhosEngine !== expected.ohosEngine ? `engine.ohos.stamp=${actualOhosEngine || 'missing'}，预期 ${expected.ohosEngine}` : '',
    !hasEngine ? '缺少 OHOS 引擎产物（libflutter.so 或包含它的 HAR）' : '',
  ].filter(Boolean);
  return { artifactVerified: mismatches.length === 0, expectedEngine: expected.engine,
    expectedOhosEngine: expected.ohosEngine, actualEngine, actualOhosEngine,
    reason: mismatches.length ? mismatches.join('；') : 'Framework 与 OHOS 引擎版本戳一致' };
}

/** 在 run 内派生 detached worktree，不 checkout/reset 共享 SDK 的工作树。 */
export async function alignVersionToTag(input: {
  sdkRoot: string;
  targetTag?: string | null;
  targetCommit?: string | null;
  overlayDir: string;
  precache?: boolean;
  exec?: typeof execFileAsync;
  flutterBin?: string;
  env?: NodeJS.ProcessEnv;
  checkArtifacts?: typeof verifyAlignedArtifacts;
}): Promise<VersionAlignResult> {
  const exec = input.exec || execFileAsync;
  const target = input.targetCommit || input.targetTag || '';
  const base: VersionAlignResult = {
    aligned: false, alignedSdkRoot: null, targetTag: input.targetTag || null,
    targetCommit: input.targetCommit || null, precacheOk: false, artifactVerified: false,
    expectedEngine: null, expectedOhosEngine: null, actualEngine: null, actualOhosEngine: null, reason: '',
  };
  if (!target) return { ...base, reason: '没有可对齐的 tag 或 commit' };
  const worktreeDir = resolve(join(input.overlayDir, 'aligned-sdk'));
  if (existsSync(join(worktreeDir, 'bin', 'flutter'))) {
    try {
      const { stdout } = await exec('git', ['-C', worktreeDir, 'rev-parse', 'HEAD'], { timeout: 10000 });
      const head = stdout.trim();
      if (head === target || (input.targetTag && (await exec('git', ['-C', worktreeDir, 'describe', '--tags'], { timeout: 10000 })).stdout.trim() === input.targetTag)) {
        const artifacts = await (input.checkArtifacts || verifyAlignedArtifacts)(worktreeDir);
        return { ...base, aligned: true, alignedSdkRoot: worktreeDir, targetCommit: head,
          precacheOk: artifacts.artifactVerified, ...artifacts,
          reason: artifacts.artifactVerified ? `复用历史副本 ${head}，${artifacts.reason}` : `历史副本引擎未对齐：${artifacts.reason}` };
      }
    } catch { /* 残留副本由 worktree remove 清理 */ }
  }
  try {
    await exec('git', ['-C', input.sdkRoot, 'worktree', 'remove', '--force', worktreeDir], { timeout: 15000 }).catch(() => {});
    await exec('git', ['-C', input.sdkRoot, 'worktree', 'prune'], { timeout: 15000 }).catch(() => {});
    await exec('git', ['-C', input.sdkRoot, 'worktree', 'add', '--detach', worktreeDir, target], { timeout: 120000 });
  } catch (error: any) {
    return { ...base, reason: 'git worktree 派生失败', error: String(error?.stderr || error?.message || error).slice(0, 300) };
  }
  try {
    const { stdout } = await exec('git', ['-C', worktreeDir, 'rev-parse', 'HEAD'], { timeout: 10000 });
    base.targetCommit = stdout.trim();
    if (input.targetCommit && base.targetCommit !== input.targetCommit) throw new Error(`HEAD ${base.targetCommit} != ${input.targetCommit}`);
  } catch (error: any) {
    return { ...base, reason: '历史 worktree HEAD 校验失败', error: String(error?.message || error).slice(0, 300) };
  }
  if (!(input.precache ?? true)) return { ...base, aligned: true, alignedSdkRoot: worktreeDir,
    reason: '仅 checkout 源码，未 precache（引擎二进制未对齐）' };
  try {
    await exec(input.flutterBin || join(worktreeDir, 'bin', 'flutter'), ['precache', '--ohos'], {
      cwd: worktreeDir,
      timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...input.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const artifacts = await (input.checkArtifacts || verifyAlignedArtifacts)(worktreeDir);
    return { ...base, aligned: true, alignedSdkRoot: worktreeDir,
      precacheOk: artifacts.artifactVerified, ...artifacts,
      reason: artifacts.artifactVerified ? `已对齐 ${base.targetCommit} 并完成 OHOS 引擎校验` : `precache 后仍未对齐：${artifacts.reason}` };
  } catch (error: any) {
    return { ...base, aligned: true, alignedSdkRoot: worktreeDir,
      reason: 'checkout 成功但 precache 失败，禁止使用共享 SDK 的引擎产物',
      error: String(error?.stderr || error?.message || error).slice(0, 300) };
  }
}

/** 迭代恢复后工作树可能已清理：用保存的共享源 + 固定 commit 重建，而不是删掉对齐元数据。 */
export async function restoreAlignedSdk(input: {
  sdkRoot: string;
  alignedSdkRoot: string;
  targetCommit: string;
  overlayDir: string;
}): Promise<{ aligned: boolean; reason: string }> {
  const result = await alignVersionToTag({ sdkRoot: input.sdkRoot, targetCommit: input.targetCommit,
    overlayDir: input.overlayDir, precache: false });
  if (!result.aligned || resolve(result.alignedSdkRoot || '') !== resolve(input.alignedSdkRoot)) {
    return { aligned: false, reason: result.error || result.reason };
  }
  const evidence = await verifyAlignedArtifacts(input.alignedSdkRoot);
  return { aligned: evidence.artifactVerified, reason: evidence.reason };
}

export async function readAlignedEngineOhosVersion(alignedSdkRoot: string): Promise<string | null> {
  return (await readExpectedEngineRevisions(alignedSdkRoot)).ohosEngine;
}

/** 给确定性集成测试/运维脚本使用，避免直接读取 engine 层私有方法。 */
export async function writeAlignmentEvidence(overlayDir: string, evidence: unknown): Promise<string> {
  const file = join(overlayDir, 'alignment-evidence.json');
  await mkdir(overlayDir, { recursive: true });
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return file;
}
