import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rename, cp, realpath, rm, readdir, stat, lstat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { getInstallPath, getWorkspaceRoot } from '@/lib/core/app-paths';
import { buildConfiguredProcessEnv } from '@/lib/core/configured-env';
import { extractLooseStructuredResult, type LooseExtractionSource } from '@/lib/ai/result-channel';
import { createSdkOverlay } from '@/lib/workflow/sdk-overlay';
import { validateStepResultRecord } from '@/lib/workflow/step-result-record';
import { redactOfficialFixLeak } from '@/lib/workflow/official-fix-redact';
import { isUsableOhosFlutterSdk, listInventoryEntries, loadOhosFlutterSdkInventory, resolveOhosFlutterSdk } from '@/lib/workflow/ohos-flutter-sdk';

export type DiagnosisScript = 'preflight' | 'restore' | 'finish' | 'abort';
type Input = { operation: DiagnosisScript; workingDirectory: string; runDirectory: string;
  globalContext: string; userId?: string; signal?: AbortSignal };
const execute = promisify(execFile);
const field = (text: string, name: string) => new RegExp(`^${name}:\\s*([^\\n]*)`, 'm').exec(text)?.[1]?.trim() || '';
const optionalJson = async (file: string) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
const optionalText = async (file: string) => { try { return await readFile(file, 'utf8'); } catch { return ''; } };
const meaningful = (v: any): v is Record<string, any> => !!v && typeof v === 'object' &&
  ['verdict', 'issue_golden_flag', 'problem_ownership', 'root_cause_summary', 'reset_target_merge_commit'].some(k => k in v);

/**
 * F02：分层提取步骤结论。旧实现只认 <result> JSON，而真实步骤输出是
 * <step-conclusion>（JSON 或 Markdown）、fenced json、散文内联 key=value。
 * 返回值附带字段来源 provenance，缺失字段保持缺省（unknown），不伪造。
 */
export interface StepConclusion {
  fields: Record<string, any>;
  sources: Record<string, LooseExtractionSource>;
  text: string;
  conflicts: string[];
}
export function parseStepConclusion(text: string): StepConclusion {
  const loose = extractLooseStructuredResult(text || '');
  return { fields: loose.fields, sources: loose.sources, conflicts: loose.conflicts || [], text: String(text || '').slice(-8000) };
}

/** F01：git remote 识别与脱敏。支持 https、ssh://、scp 风格、本地路径；永不抛异常。 */
export type GitRemoteKind = 'https' | 'ssh' | 'local' | 'unknown';
export function sanitizeGitRemote(raw: string): { kind: GitRemoteKind; url: string } {
  const value = String(raw || '').trim();
  if (!value) return { kind: 'unknown', url: '' };
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      u.username = ''; u.password = ''; u.search = ''; u.hash = '';
      return { kind: 'https', url: u.toString() };
    } catch { return { kind: 'unknown', url: '[invalid-url]' }; }
  }
  if (/^ssh:\/\//i.test(value)) {
    try { const u = new URL(value); u.password = ''; return { kind: 'ssh', url: u.toString() }; }
    catch { return { kind: 'unknown', url: '[invalid-url]' }; }
  }
  // scp 风格：git@host:owner/repo.git（不细分用户，按需脱敏用户段之外没有凭据位）
  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:.+/.test(value)) return { kind: 'ssh', url: value };
  // 本地路径（POSIX 绝对/相对、~、Windows 盘符）
  if (value.startsWith('/') || value.startsWith('~') || value.startsWith('.') || /^[A-Za-z]:[\\/]/.test(value)) {
    return { kind: 'local', url: value };
  }
  return { kind: 'unknown', url: value };
}

/** F01：把脚本异常归类成稳定错误码，便于审计区分"可重试归档失败"与"环境问题" */
export function classifyDiagnosisScriptError(error: any): string {
  const message = String(error?.message || error || '');
  if (/Invalid URL/i.test(message)) return 'invalid_remote_url';
  if (error?.code === 'ENOENT') return 'io_missing';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'io_permission';
  if (error?.code === 'ENOSPC') return 'io_no_space';
  if (typeof error?.code === 'number' || error?.stdout !== undefined || error?.stderr !== undefined) return 'git_command_failed';
  if (/timed?\s*out|ETIMEDOUT/i.test(message)) return 'io_timeout';
  return 'script_error';
}

/**
 * 双写工作目录与运行归档目录。F01：逐目标容错，返回写入成功的根目录列表；
 * 仅当全部失败时才抛错（由调用方决定如何归类）。
 */
async function save(input: Input, name: string, value: unknown): Promise<string[]> {
  const saved: string[] = [];
  let lastError: any = null;
  for (const root of new Set([input.workingDirectory, input.runDirectory])) {
    try {
      const out = join(root, 'outputs');
      try { if ((await lstat(out)).isSymbolicLink()) throw new Error('outputs 根目录不能是符号链接'); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(out, { recursive: true });
      const file = join(out, name), temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
      saved.push(root);
    } catch (error) { lastError = error; }
  }
  if (!saved.length && lastError) throw lastError;
  return saved;
}

export function issueApiAddress(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Issue 地址必须使用受支持平台的 HTTPS 地址');
  const parts = /^\/([^/]+)\/([^/]+)\/issues\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  const bases: Record<string, string> = { 'gitcode.com': 'https://gitcode.com/api/v5',
    'github.com': 'https://api.github.com', 'gitee.com': 'https://gitee.com/api/v5' };
  if (!parts || !bases[url.hostname]) throw new Error('Issue 地址格式或平台不受支持');
  const [, owner, repo, number] = parts;
  if (![owner, repo].every(v => /^[A-Za-z0-9_.-]+$/.test(v) && v !== '.' && v !== '..')) throw new Error('仓库地址格式无效');
  return { source: `${url.origin}${url.pathname}`, platform: url.hostname.split('.')[0], owner, repo, number,
    api: `${bases[url.hostname]}/repos/${owner}/${repo}/issues/${number}` };
}

/**
 * F03：受控快照目录（CPF 写入、引擎读取的交接目录）。
 * 路径必须落在该目录内且以内容哈希命名，防止借 globalContext 任意读文件。
 */
export function evalInputsDir(): string {
  return join(homedir(), '.aceharness', 'eval-inputs');
}

export async function readIssueSnapshot(rawPath: string, expectedSha256: string): Promise<{
  title: string; body: string; sha256: string;
}> {
  const resolved = resolve(String(rawPath || ''));
  if (dirname(resolved) !== evalInputsDir() || !/^[a-f0-9]{64}\.md$/.test(basename(resolved))) {
    throw new Error('快照路径无效：必须位于受控输入目录内并以内容哈希命名');
  }
  let body: string;
  try { body = await readFile(resolved, 'utf8'); }
  catch { throw new Error('快照文件不存在或不可读'); }
  if (Buffer.byteLength(body) > 262144) throw new Error('快照内容超出 256KB 上限');
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (expectedSha256 && expectedSha256 !== sha256) throw new Error('快照哈希与登记值不一致，拒绝使用');
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || '快照输入';
  return { title, body, sha256 };
}

async function collectIssue(input: Input, env: NodeJS.ProcessEnv) {
  if (field(input.globalContext, 'evaluation-mode') === 'blind_eval') {
    throw new Error('blind_eval 暂不可用：当前执行器未隔离答案文件、未来 Git 历史和网络；请使用 guided_replay，不能作为独立盲测评分');
  }
  const rawUrl = field(input.globalContext, 'issue-url') || input.globalContext.match(/https:\/\/[^\s<>"']+\/issues\/[A-Za-z0-9]+/)?.[0];
  if (!rawUrl) return { input_source: 'freeform_text', body: input.globalContext.replace(/^access-token:.*$/gm, ''),
    title: '文本问题', comments: [], issue_comments_count: 0, issue_content_complete: !!input.globalContext.trim(), checked_at: new Date().toISOString() };
  const target = issueApiAddress(rawUrl);
  // F03：盲测/受控回放通道。登记了快照路径时，正文以快照（逐字节、哈希校验）为准，
  // 不访问线上 API；issue-url 仅承担仓库身份（platform/owner/repo/number）。
  const snapshotPath = field(input.globalContext, 'issue-snapshot-path');
  if (snapshotPath) {
    const snapshot = await readIssueSnapshot(snapshotPath, field(input.globalContext, 'issue-snapshot-sha256'));
    return {
      input_source: 'provided_snapshot',
      source_url: target.source, platform: target.platform, owner: target.owner, repo: target.repo, number: target.number,
      title: snapshot.title, body: snapshot.body, issue_created_at: null,
      comments: [], issue_comments_count: 0, issue_content_complete: true,
      comments_complete: false, comments_error: '快照输入不含评论，评论证据缺失需在报告中说明',
      missing_evidence: ['评论未包含在快照输入中'],
      snapshot_sha256: snapshot.sha256,
      evaluation_mode: field(input.globalContext, 'evaluation-mode') || 'guided_replay',
      checked_at: new Date().toISOString() };
  }
  const cached = await optionalJson(join(input.runDirectory, 'outputs/diagnosis-input.json'));
  if (cached?.source_url === target.source && cached.issue_content_complete) return cached;
  const token = field(input.globalContext, 'access-token') || env[`${target.platform.toUpperCase()}_TOKEN`] || '';
  const deadline = Date.now() + 20000;
  const get = async (url: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (input.signal?.aborted) throw new Error('诊断已停止');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Issue 采集超时');
      try {
        const signal = AbortSignal.any([AbortSignal.timeout(Math.min(8000, remaining)), ...(input.signal ? [input.signal] : [])]);
        const response = await fetch(url, { signal, redirect: 'error', headers: {
          Accept: 'application/json', 'User-Agent': 'ACEHarness-Diagnosis', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
        if (!response.ok) {
          const error = Object.assign(new Error(`Issue API HTTP ${response.status}`), { status: response.status });
          if (response.status >= 500 && attempt === 0) continue;
          throw error;
        }
        const raw = await response.text();
        if (raw.length > 2_000_000) throw new Error('Issue API 内容超出采集上限');
        return JSON.parse(raw);
      } catch (error: any) {
        if (input.signal?.aborted || error.status || attempt === 1) throw new Error(error.status ? `Issue API HTTP ${error.status}` : 'Issue 采集暂不可用或响应无效');
      }
    }
  };
  const issue = await get(target.api);
  if (typeof issue?.title !== 'string' || typeof issue?.body !== 'string') throw new Error('Issue 正文缺失，无法开始诊断');
  const comments: any[] = []; let complete = false; let commentError: string | null = null;
  try {
    for (let page = 1; page <= 3; page++) {
      const items = await get(`${target.api}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error('评论响应无效');
      comments.push(...items.map(c => ({ body: redactOfficialFixLeak(String(c.body || '')).text,
        created_at: c.created_at || null, author: c.user?.login || '' })));
      if (items.length < 100) { complete = true; break; }
    }
  } catch { if (input.signal?.aborted) throw new Error('诊断已停止'); commentError = '评论采集不完整，正文仍可分析'; }
  return { input_source: 'issue_url', source_url: target.source, title: redactOfficialFixLeak(issue.title).text,
    body: redactOfficialFixLeak(issue.body).text, issue_created_at: issue.created_at || null,
    comments, issue_comments_count: comments.length, issue_content_complete: true,
    comments_complete: complete, comments_error: commentError,
    missing_evidence: complete ? [] : ['评论未完整读取，请在报告中说明'], checked_at: new Date().toISOString() };
}

async function environment(input: Input, env: NodeJS.ProcessEnv) {
  const probe = async (command: string, args: string[]) => {
    try { return { ok: true, output: (await execute(command, args, { env, signal: input.signal, timeout: 4000, maxBuffer: 65536 })).stdout.trim() }; }
    catch (error: any) { if (input.signal?.aborted) throw new Error('诊断已停止'); return { ok: false, output: '', reason: error.code === 'ENOENT' ? '未安装或不在 PATH 中' : '命令失败或超时' }; }
  };
  const [git, hdc, adb] = await Promise.all([probe('git', ['--version']), probe('hdc', ['list', 'targets']), probe('adb', ['devices'])]);
  const sdks = listInventoryEntries(loadOhosFlutterSdkInventory()).filter(s => isUsableOhosFlutterSdk(s.path)).map(s => ({ id: s.id, version: s.version }));
  const ohosDevices = hdc.ok ? hdc.output.split(/\r?\n/).filter(s => s.trim() && !/empty|no devices|list of/i.test(s)) : [];
  const androidDevices = adb.ok ? adb.output.split(/\r?\n/).filter(s => /\sdevice$/.test(s)) : [];
  return { checked_at: new Date().toISOString(), git_available: git.ok, ohos_sdk_inventory: sdks,
    ohos_device_count: ohosDevices.length, android_device_count: androidDevices.length,
    hdc_available: hdc.ok, adb_available: adb.ok,
    runtime_validation: ohosDevices.length && sdks.length ? 'needs_sdk_alignment' : 'blocked_environment',
    missing_evidence: [...(!sdks.length ? ['缺少可用 OHOS Flutter SDK'] : []), ...(!ohosDevices.length ? ['当前无可用 OHOS 设备'] : [])] };
}

// ─── F11：运行级 SDK 隔离与共享缓存完整性 ────────────────────────────────────

/** 每 run 可写隔离区（路径天然含 runId），Agent 的 HAR 盖入/测试副本一律落这里 */
export function runSdkOverlayDir(runDirectory: string): string {
  return join(runDirectory, 'sdk-overlay');
}

/** 枚举共享 SDK 缓存中的 HAR（flutter_embedding/flutter，debug/release/profile） */
export async function listSharedSdkHars(sdkRoot: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const engineDir = join(sdkRoot, 'bin', 'cache', 'artifacts', 'engine');
  const out: string[] = [];
  let targets: string[] = [];
  try { targets = await readdir(engineDir); } catch { return out; }
  for (const target of targets) {
    if (!/^ohos-/.test(target)) continue;
    const dir = join(engineDir, target);
    let files: string[] = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) if (/\.har$/i.test(f)) out.push(join(dir, f));
  }
  return out.sort();
}

/** 共享 SDK HAR 指纹清单（preflight 记录、finish 复核） */
export async function fingerprintSharedSdkHars(): Promise<Array<{ path: string; sha256: string | null }>> {
  const sdks = listInventoryEntries(loadOhosFlutterSdkInventory()).filter((s) => isUsableOhosFlutterSdk(s.path));
  const out: Array<{ path: string; sha256: string | null }> = [];
  for (const sdk of sdks) {
    for (const har of await listSharedSdkHars(sdk.path)) {
      out.push({ path: har, sha256: await sha256File(har) });
    }
  }
  return out;
}

/** F11：比对前后指纹，返回被改动/新增/消失的 HAR 路径 */
export function diffSharedSdkFingerprints(
  before: Array<{ path: string; sha256: string | null }>,
  after: Array<{ path: string; sha256: string | null }>,
): { modified: string[]; added: string[]; removed: string[] } {
  const bMap = new Map(before.map((e) => [e.path, e.sha256]));
  const aMap = new Map(after.map((e) => [e.path, e.sha256]));
  const modified = before.filter((e) => aMap.has(e.path) && aMap.get(e.path) !== e.sha256).map((e) => e.path);
  const added = after.filter((e) => !bMap.has(e.path)).map((e) => e.path);
  const removed = before.filter((e) => !aMap.has(e.path)).map((e) => e.path);
  return { modified, added, removed };
}

async function stepResult(archive: string, work: string, name: string, state: any): Promise<StepConclusion> {
  const text = await stepResultText(archive, work, [name], state);
  const latest = [...(state.stepLogs || [])].reverse().find((log: any) => log.stepName === name);
  if (latest?.resultRef) {
    const ref = resolve(archive, latest.resultRef);
    const record = ref.startsWith(resolve(archive) + sep) ? await optionalJson(ref) : null;
    if (!validateStepResultRecord(record, basename(archive), latest.id, text)) {
      return { fields: {}, sources: {}, conflicts: ['步骤结果记录与原始输出/尝试 ID 不匹配'], text };
    }
    return { fields: record.fields, sources: record.sources, conflicts: record.conflicts, text };
  }
  return parseStepConclusion(text);
}

/** stepLogs 里的完整输出：outputRef（相对 run 目录）优先，output 兜底 */
async function stepLogText(archive: string, name: string, state: any): Promise<string> {
  const log = [...(state.stepLogs || [])].reverse().find((s: any) => s.stepName === name);
  if (!log) return '';
  if (log.outputRef) {
    const refPath = isAbsolute(log.outputRef) ? log.outputRef : join(archive, log.outputRef);
    const fromRef = await optionalText(refPath);
    if (fromRef) return fromRef;
  }
  return log.output || '';
}

/** 按归档 md → 工作区 md → stepLogs(outputRef 优先、output 兜底) 的顺序取步骤完整文本 */
async function stepResultText(archive: string, work: string, names: string[], state: any): Promise<string> {
  for (const name of names) {
    const full = await stepLogText(archive, name, state);
    if (full) return full;
    const archived = await optionalText(join(archive, 'outputs', name + '.md'));
    if (archived) return archived;
    const working = await optionalText(join(work, 'outputs', name + '.md'));
    if (working) return working;
  }
  for (const name of names) {
    const text = await stepLogText(archive, name, state);
    if (text) return text;
  }
  return '';
}

async function sha256File(file: string): Promise<string | null> {
  try { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); } catch { return null; }
}

/** F12：从 HAR 内 package/BuildProfile.ets 读取构建模式（release/debug），读取失败返回 null */
export async function inspectHarBuildProfile(file: string): Promise<{
  build_mode: string | null; debug: boolean | null; target: string | null;
} | null> {
  try {
    const { stdout } = await execute('tar', ['-xzOf', file, 'package/BuildProfile.ets'], { timeout: 8000 });
    const mode = /BUILD_MODE_NAME\s*=\s*'([^']+)'/.exec(stdout)?.[1] || null;
    const debugRaw = /DEBUG\s*=\s*(true|false)/.exec(stdout)?.[1];
    const target = /TARGET_NAME\s*=\s*'([^']+)'/.exec(stdout)?.[1] || null;
    return { build_mode: mode, debug: debugRaw == null ? null : debugRaw === 'true', target };
  } catch { return null; }
}

/** F06：报告与归档证据的矛盾检测（不阻断，产出告警供审计与评分参考） */
export interface ConsistencyWarning { code: string; detail: string; }
export function checkReportConsistency(input: {
  reportText: string;
  archiveNames: string[];
  verificationStatus: string;
}): ConsistencyWarning[] {
  const warnings: ConsistencyWarning[] = [];
  const { reportText, archiveNames, verificationStatus } = input;
  if (!reportText.trim()) return warnings;
  // R03：只把"绝对性否认 Android 证据/执行"的句子判为矛盾。
  // 「本轮未重跑（复现阶段已覆盖）」这类带范围或复用限定的诚实表述不算矛盾——
  // 真实反例 #1941："未执行 Android/iOS 对照构建"（无限定），而归档存在 i1941_android_* 证据。
  const ABSOLUTE_CLAIM = /(未执行|未进行|未运行|未实施|未做|没有执行|没有进行|没有运行|未覆盖|无[^。!?\n]{0,12}(?:证据|日志|记录)|缺少[^。!?\n]{0,12}(?:证据|日志))/i;
  const ANDROID_NEAR = /android|安卓|logcat/i;
  const SCOPE_QUALIFIER = /(已覆盖|已留存|已有|复现阶段|复用|此前|先前|上一轮|仅复核|旧证据|历史日志|本轮)/;
  const androidEvidence = archiveNames.some((n) => /logcat|android/i.test(n));
  if (androidEvidence) {
    const sentences = reportText.split(/(?<=[。！？!?])|[\r\n]+/);
    const contradicted = sentences.some((sentence) =>
      ANDROID_NEAR.test(sentence) && ABSOLUTE_CLAIM.test(sentence) && !SCOPE_QUALIFIER.test(sentence));
    if (contradicted) {
      warnings.push({ code: 'android_evidence_contradiction',
        detail: '报告绝对性地声称 Android 对照/证据未执行，但归档中存在 Android 证据文件（logcat 等），二者矛盾' });
    }
  }
  // 报告声称 verified，但运行级验证状态不支持
  const claimsVerified = /"verification_status"\s*:\s*"verified"/.test(reportText)
    || /验证状态\s*[:：]?\s*已验证/.test(reportText);
  if (claimsVerified && verificationStatus !== 'verified') {
    warnings.push({ code: 'verification_status_contradiction',
      detail: `报告声称已验证（verified），但运行级验证状态为 ${verificationStatus}` });
  }
  return warnings;
}

interface ArchiveEntry {
  name: string; role: string; source_path: string | null;
  archived_to: string | null;
  /** R04：not_applicable 用于"本就不需要该产物"的正当情形（如 business_code 分流不产生框架 patch） */
  status: 'archived' | 'already_present' | 'missing' | 'failed' | 'not_applicable';
  bytes: number | null; sha256: string | null; error?: string;
  /** F12：HAR 构建模式校验结果（仅 .har 条目，读不出为 null） */
  har_build_mode?: string | null;
  har_debug?: boolean | null;
}

async function captureContext(input: Input, env: NodeJS.ProcessEnv, persist = true) {
  const state = parse(await optionalText(join(input.runDirectory, 'state.yaml'))) || {};
  const read = async (name: string) => (await stepResult(input.runDirectory, input.workingDirectory, name, state));
  const [collectC, reproductionC, rootC, verificationC, inherited] = await Promise.all([
    read('信息采集-Issue信息采集'), read('问题复现-问题复现'), read('根因分析-根因定位'),
    read('修复验证-修复方案对抗验证'), optionalJson(join(input.workingDirectory, 'outputs/diagnosis-inherited.json'))]);
  // F02：字段全部来自宽松提取；sources 记录每个字段来源，unknown 不伪造
  const collect = collectC.fields, reproduction = reproductionC.fields, root = rootC.fields, verification = verificationC.fields;
  const extractionProvenance = {
    collect: collectC.sources, reproduction: reproductionC.sources,
    root_cause: rootC.sources, fix_verification: verificationC.sources,
  };
  const archiveEntries: ArchiveEntry[] = [];
  const recordEntry = (entry: ArchiveEntry) => { archiveEntries.push(entry); };

  const repositories: any[] = [];
  for (const name of ['repo', 'repo-engine']) {
    if (!existsSync(join(input.workingDirectory, name, '.git'))) continue;
    const repoDir = join(input.workingDirectory, name);
    const git = async (args: string[]) => (await execute('git', ['-C', repoDir, ...args], { env, timeout: 5000, signal: input.signal })).stdout.trim();
    const patchName = name === 'repo' ? 'fix.patch' : 'fix-engine.patch';
    // F01/F05：单仓库失败不拖垮整个收尾；逐项记录状态
    const repoEntry: any = { name, baseline_confirmed: false };
    try {
      const inheritedRepo = inherited?.repositories?.find((r: any) => r.name === name);
      const pinned = name === 'repo' ? collect.reset_target_merge_commit || collect.commit : collect.engine_commit;
      const commit = /^[a-f0-9]{40}$/i.test(pinned || '') ? pinned : inheritedRepo?.commit || await git(['rev-parse', 'HEAD']);
      const rawUrl = await git(['remote', 'get-url', 'origin']);
      // F01：local/https/ssh 分类，只对网络 URL 脱敏，绝不对本地路径调 new URL()
      const remote = sanitizeGitRemote(rawUrl);
      let canonicalUrl: string | null = null;
      if (remote.kind === 'local') {
        // 本地镜像本身可能记录了 canonical 远端（bare 镜像用 --git-dir 读配置）
        try {
          const upstream = (await execute('git', ['--git-dir', remote.url, 'config', '--get', 'remote.origin.url'],
            { env, timeout: 5000, signal: input.signal })).stdout.trim();
          if (upstream) canonicalUrl = sanitizeGitRemote(upstream).url;
        } catch { canonicalUrl = null; }
      }
      Object.assign(repoEntry, {
        commit,
        url: remote.url, remote_kind: remote.kind,
        canonical_url: remote.kind === 'local' ? canonicalUrl : remote.url,
        baseline_confirmed: /^[a-f0-9]{40}$/i.test(pinned || '') || (!!inheritedRepo?.commit && inheritedRepo.baseline_confirmed !== false),
        branch: inheritedRepo?.branch || collect.branch || await git(['branch', '--show-current']),
      });
      // Save the actual diff before any future workspace cleanup.
      const patch = await optionalText(join(input.workingDirectory, 'outputs', patchName))
        || (await execute('git', ['-C', repoDir, 'diff', commit, '--'], { env, timeout: 10000, signal: input.signal, maxBuffer: 8 * 1024 * 1024 })).stdout;
      if (persist && patch) {
        for (const rootDir of [input.workingDirectory, input.runDirectory]) {
          await mkdir(join(rootDir, 'outputs'), { recursive: true });
          await writeFile(join(rootDir, 'outputs', patchName), patch);
        }
      }
      const patchPath = join(input.runDirectory, 'outputs', patchName);
      // R04：无 patch 不一律是缺失——business_code 分流本就不改框架/引擎仓；
      // framework_library 问题不要求引擎仓改动。归属未知时保持 missing（保守、不粉饰）。
      const ownership = String(root.problem_ownership || inherited?.problem_ownership || '');
      const patchExpected = ownership === 'business_code'
        ? false
        : name === 'repo-engine' ? ownership === 'mixed' : ownership !== '';
      recordEntry({
        name: patchName, role: name === 'repo' ? 'fix_patch' : 'fix_engine_patch',
        source_path: patch ? 'git-diff|workdir-outputs' : null,
        archived_to: persist && patch && existsSync(patchPath) ? patchPath : null,
        status: patch ? (persist && existsSync(patchPath) ? 'archived' : 'missing') : (patchExpected ? 'missing' : 'not_applicable'),
        bytes: patch ? Buffer.byteLength(patch) : null,
        sha256: patch ? createHash('sha256').update(patch).digest('hex') : null,
      });
    } catch (error: any) {
      repoEntry.error = String(error?.message || error).slice(0, 200);
      repoEntry.baseline_confirmed = false;
      recordEntry({ name: patchName, role: 'fix_patch', source_path: null, archived_to: null,
        status: 'failed', bytes: null, sha256: null, error: repoEntry.error });
    }
    repositories.push(repoEntry);
  }
  const demoCandidate = reproduction.demo_path || inherited?.demo_path || join(input.workingDirectory, 'demo');
  const demoPath = resolve(input.workingDirectory, demoCandidate);
  const within = demoPath.startsWith(resolve(input.workingDirectory) + sep);
  const golden = inherited?.issue_golden_flag || reproduction.issue_golden_flag;

  // F02：unknown 与 false 分开。全部字段齐备且为真 → verified；
  // 有显式 false 或裁决非 pass → needs_runtime_validation；字段缺失 → evidence_incomplete。
  const tri = (v: any): 'true' | 'false' | 'unknown' => (v === true ? 'true' : v === false ? 'false' : 'unknown');
  const verificationFlags = {
    issue_golden_flag_met: tri(verification.issue_golden_flag_met),
    engine_aligned: tri(verification.engine_aligned),
    bug_fixed: tri(verification.bug_fixed),
  };
  const flagValues = Object.values(verificationFlags);
  const verificationStatus =
    verificationC.conflicts.length ? 'evidence_conflict' :
    verification.verdict === 'pass' && flagValues.every((f) => f === 'true') ? 'verified'
    : flagValues.includes('false') || ['fail', 'conditional_pass'].includes(String(verification.verdict)) ? 'needs_runtime_validation'
    : 'evidence_incomplete';

  // F06 报告正文提前计算：R04 引用驱动归档与 R03 一致性检查都要用它。
  // 归档 md 可能只是摘要 stub，完整报告在 step-logs(outputRef)；对两者取并集。
  const reportParts: string[] = [];
  for (const reportName of ['报告沉淀-生成诊断报告', '报告沉淀', 'generate-report']) {
    const md = await optionalText(join(input.runDirectory, 'outputs', reportName + '.md'))
      || await optionalText(join(input.workingDirectory, 'outputs', reportName + '.md'));
    const logText = await stepLogText(input.runDirectory, reportName, state);
    if (md) reportParts.push(md);
    if (logText && logText !== md) reportParts.push(logText);
    if (reportParts.length) break;
  }
  const reportText = reportParts.join('\n');

  // Archive the complete outputs tree, with no extension whitelist. Explicit refs are required.
  if (persist) {
    const workOutputs = join(input.workingDirectory, 'outputs');
    const archiveOutputs = join(input.runDirectory, 'outputs');
    const generated = new Set(['diagnosis-context.json', 'diagnosis-archive-manifest.json']);
    const safeName = (name: string) => !!name && !isAbsolute(name) && !name.includes('\\')
      && !name.split('/').some(part => part === '..' || part === '.' || !part);
    const withinRoot = async (root: string, file: string) => {
      const actualRoot = await realpath(root);
      const actual = await realpath(file);
      if (!actual.startsWith(actualRoot + sep)) throw new Error('证据路径越出 outputs 目录');
    };
    const archiveFile = async (name: string, role: string) => {
      if (archiveEntries.some(e => e.name === name)) return;
      const src = join(workOutputs, name), dst = join(archiveOutputs, name);
      try {
        if (!safeName(name) || generated.has(name)) throw new Error('非法或自引用证据路径');
        const source = existsSync(src) ? src : dst;
        await withinRoot(source === src ? workOutputs : archiveOutputs, source);
        const info = await stat(source);
        if (!info.isFile()) throw new Error('证据引用必须指向普通文件');
        const digest = await sha256File(source);
        if (!digest) throw new Error('证据 hash 读取失败');
        let parent = archiveOutputs;
        for (const component of name.split('/').slice(0, -1)) {
          parent = join(parent, component);
          try { if ((await lstat(parent)).isSymbolicLink()) throw new Error('归档目标包含符号链接'); }
          catch (error: any) { if (error.code !== 'ENOENT') throw error; await mkdir(parent); }
        }
        try { if ((await lstat(dst)).isSymbolicLink()) throw new Error('归档文件不能是符号链接'); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        // Reject existing destination links before any overwrite, including parent links.
        const actualArchive = await realpath(archiveOutputs);
        const actualParent = await realpath(dirname(dst));
        if (actualParent !== actualArchive && !actualParent.startsWith(actualArchive + sep)) throw new Error('归档目标越界');
        if (existsSync(dst)) await withinRoot(archiveOutputs, dst);
        const already = existsSync(dst) && (await sha256File(dst)) === digest;
        if (!already) await cp(source, dst);
        if (await sha256File(dst) !== digest) throw new Error('归档文件 hash 不匹配');
        const harInfo = /\.har$/i.test(name) ? await inspectHarBuildProfile(dst) : null;
        recordEntry({ name, role, source_path: source, archived_to: dst,
          status: already ? 'already_present' : 'archived', bytes: info.size, sha256: digest,
          ...(harInfo ? { har_build_mode: harInfo.build_mode, har_debug: harInfo.debug } : {}) });
      } catch (error: any) {
        recordEntry({ name, role, source_path: src, archived_to: null,
          status: error?.code === 'ENOENT' ? 'missing' : 'failed', bytes: null, sha256: null,
          error: String(error?.message || error).slice(0, 200) });
      }
    };
    try {
      for (const root of [workOutputs, archiveOutputs]) {
        try { if ((await lstat(root)).isSymbolicLink()) throw new Error('outputs 根目录不能是符号链接'); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      }
      await mkdir(archiveOutputs, { recursive: true });
      const walk = async (prefix = ''): Promise<void> => {
        for (const entry of await readdir(join(workOutputs, prefix), { withFileTypes: true })) {
          const name = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (generated.has(name)) continue;
          // Never follow directory symlinks recursively (cycles / escaping trees).
          if (entry.isDirectory()) await walk(name);
          else await archiveFile(name, 'evidence');
        }
      };
      if (existsSync(workOutputs)) await walk();
      const referencedNames = new Set<string>();
      for (const log of state.stepLogs || []) {
        for (const ref of [log.outputRef, log.resultRef, log.rawOutputRef]) {
          if (typeof ref !== 'string') continue;
          referencedNames.add(ref.startsWith(archiveOutputs + sep) ? ref.slice(archiveOutputs.length + 1) : ref.replace(/^outputs\//, ''));
        }
      }
      for (const conclusion of [collectC, reproductionC, rootC, verificationC]) {
        const refs = conclusion.fields.evidenceRefs;
        if (Array.isArray(refs)) for (const ref of refs) {
          const path = typeof ref === 'string' ? ref : ref?.path;
          if (typeof path === 'string') referencedNames.add(path.replace(/^outputs\//, ''));
        }
      }
      // Legacy textual references supplement structured refs; preserve nested paths and any suffix.
      for (const text of [reportText, verificationC.text]) {
        for (const match of text.matchAll(/outputs\/([^\s`<>"'，；。！？、()（）\[\]{}]+\.[A-Za-z0-9_-]+)/g)) referencedNames.add(match[1]);
      }
      for (const name of referencedNames) await archiveFile(name, 'referenced');
    } catch (error: any) {
      recordEntry({ name: 'outputs/', role: 'archive_scan', source_path: workOutputs, archived_to: null,
        status: 'failed', bytes: null, sha256: null, error: String(error?.message || error).slice(0, 200) });
    }
  }
  // F06：报告与证据的一致性交叉检查（非阻断，记录告警）
  const consistencyWarnings = [...checkReportConsistency({
    reportText,
    archiveNames: archiveEntries.filter((e) => e.status !== 'missing').map((e) => e.name),
    verificationStatus,
  })];

  // F11：共享 SDK HAR 指纹复核——发现共享缓存被本流程改动则如实告警（检测，不掩盖）
  const preflightData = await optionalJson(join(input.runDirectory, 'outputs', 'diagnosis-preflight.json'))
    || await optionalJson(join(input.workingDirectory, 'outputs', 'diagnosis-preflight.json'));
  let sharedSdkIntegrity: any = { checked: false };
  if (Array.isArray(preflightData?.shared_sdk_fingerprints)) {
    const diff = diffSharedSdkFingerprints(preflightData.shared_sdk_fingerprints, await fingerprintSharedSdkHars());
    const clean = !diff.modified.length && !diff.added.length && !diff.removed.length;
    sharedSdkIntegrity = {
      checked: true, clean,
      modified: diff.modified, added: diff.added, removed: diff.removed,
      overlay_dir: preflightData.sdk_overlay || null,
    };
    if (!clean) {
      consistencyWarnings.push({ code: 'shared_sdk_modified',
        detail: `共享 SDK 缓存在运行期间被改动（modified=${diff.modified.length}, added=${diff.added.length}, removed=${diff.removed.length}）：${[...diff.modified, ...diff.added, ...diff.removed].slice(0, 3).join('；')}` });
    }
  }

  const context = { version: 2, run_id: basename(input.runDirectory), working_directory: input.workingDirectory,
    checked_at: new Date().toISOString(), repositories, issue_golden_flag: golden || null,
    demo_path: within && existsSync(demoPath) ? demoPath : null,
    context_completeness: golden && within && existsSync(demoPath) && repositories.length
      && repositories.every((r) => r.baseline_confirmed) ? 'complete' : 'partial',
    root_cause_summary: root.root_cause_summary || root.summary || inherited?.root_cause_summary || rootC.text,
    problem_ownership: root.problem_ownership || inherited?.problem_ownership || null,
    verification_status: verificationStatus,
    verification_flags: verificationFlags,
    verification_conflicts: verificationC.conflicts,
    evaluation_mode: field(input.globalContext, 'evaluation-mode') || 'guided_replay',
    evaluation_integrity: 'not_independent',
    consistency_warnings: consistencyWarnings,
    shared_sdk_integrity: sharedSdkIntegrity,
    extraction: extractionProvenance };

  let artifactOverall: 'complete' | 'partial' | 'failed' = archiveEntries.some((e) => e.status === 'failed') ? 'failed'
    : archiveEntries.some((e) => e.status === 'missing') ? 'partial'
    : 'complete';
  (context as any).artifact_status = {
    overall: artifactOverall,
    error_code: artifactOverall === 'complete' ? null : artifactOverall === 'failed' ? 'archive_entry_failed' : 'archive_partial',
    entries: archiveEntries.length,
    failed: archiveEntries.filter((e) => e.status === 'failed').map((e) => e.name),
    manifest: 'outputs/diagnosis-archive-manifest.json',
  };
  if (persist) {
    // F01：归档写入本身失败也必须可见——按目标目录分别判定，写不进归档目录即 failed
    const persistAll = async (): Promise<boolean> => {
      const [manifestRoots, contextRoots] = await Promise.all([
        save(input, 'diagnosis-archive-manifest.json', {
          version: 1, run_id: context.run_id, generated_at: context.checked_at,
          working_directory: input.workingDirectory, entries: archiveEntries,
        }).catch(() => [] as string[]),
        save(input, 'diagnosis-context.json', context).catch(() => [] as string[]),
      ]);
      return manifestRoots.includes(input.runDirectory) && contextRoots.includes(input.runDirectory);
    };
    const archived = await persistAll();
    if (!archived) {
      artifactOverall = 'failed';
      (context as any).artifact_status.overall = 'failed';
      (context as any).artifact_status.error_code = 'archive_persist_failed';
      (context as any).artifact_status.error = '运行归档目录写入失败';
      await persistAll().catch(() => { /* 已尽力，状态以返回值为准 */ });
    }
  }
  return context;
}

async function restore(input: Input, env: NodeJS.ProcessEnv) {
  const parentId = field(input.globalContext, 'parent-run-id');
  if (!/^run-[A-Za-z0-9_-]{4,80}$/.test(parentId)) throw new Error('原运行 ID 无效');
  const archive = join(getWorkspaceRoot(), 'runs', parentId);
  const state = parse(await readFile(join(archive, 'state.yaml'), 'utf8')) || {};
  const owner = state.createdBy || state.runOwnerId;
  if (owner && owner !== input.userId) throw new Error('原任务与当前执行用户不匹配');
  const work = state.workingDirectory || join(dirname(input.workingDirectory), parentId);
  if (basename(work) !== parentId) throw new Error('原任务工作目录不匹配');
  let context = await optionalJson(join(archive, 'outputs/diagnosis-context.json'));
  if (!context) {
    try { context = await captureContext({ ...input, runDirectory: archive, workingDirectory: work }, env, false); }
    catch { if (input.signal?.aborted) throw new Error('诊断已停止'); }
  }
  if (!context) return { verdict: 'conditional_pass', fallback_to_agent: true,
    summary: '旧任务上下文需按原始记录核对，转入兼容恢复步骤；不得猜测验收判据或提交' };
  if (context.run_id !== parentId) throw new Error('原任务上下文归属不匹配');
  if (!context.issue_golden_flag || !context.demo_path || !context.repositories?.length
    || context.repositories.some((r: any) => r.baseline_confirmed === false)) {
    return { verdict: 'conditional_pass', fallback_to_agent: true,
      summary: '旧任务缺少结构化继承清单，转入原有上下文恢复步骤核对；不得猜测验收判据或提交' };
  }
  const sourceDemo = await realpath(context.demo_path);
  if (!sourceDemo.startsWith(await realpath(work) + sep)) throw new Error('原 Demo 不在任务工作目录内');
  if (!context.repositories?.length) throw new Error('原任务缺少仓库基线，无法恢复到相同提交');
  const repositories = [];
  for (const repo of context.repositories) {
    if (!['repo', 'repo-engine'].includes(repo.name) || !/^[a-f0-9]{40}$/i.test(repo.commit || '')) throw new Error('原任务仓库基线无效');
    // R05：origin 可能是本地路径/SSH（F01 起 remote_kind 已分类，canonical_url 保存规范 https 地址）；
    // URL 校验与镜像缓存只针对规范地址，本地来源走本地克隆路径
    const remoteUrl = String(repo.canonical_url || repo.url || '');
    const remoteIsLocal = repo.remote_kind === 'local' || !/^https?:\/\//i.test(remoteUrl);
    let url: URL | null = null;
    if (!remoteIsLocal) {
      url = new URL(remoteUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !['gitcode.com', 'github.com', 'gitee.com'].includes(url.hostname)
        || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname)) throw new Error('原仓库地址无效');
    }
    const dest = join(input.workingDirectory, repo.name);
    const git = async (args: string[]) => (await execute('git', args, { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, signal: input.signal, timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
    if (!existsSync(join(dest, '.git'))) {
      if (existsSync(dest)) throw new Error('恢复目录已存在且不是 Git 仓库，已保留，请检查后继续');
      const local = join(work, repo.name);
      const mirror = url ? join(getWorkspaceRoot(), 'repo-cache', url.hostname, url.pathname.slice(1).replace(/\.git$/, '') + '.git') : null;
      const source = [local, ...(mirror ? [mirror] : [])].find(p => existsSync(p));
      const staging = await mkdtemp(join(input.workingDirectory, '.diagnosis-repo-'));
      const clone = join(staging, repo.name);
      try {
        if (source) {
          await git(['clone', '--no-checkout', '--', source, clone]);
          await git(['-C', clone, 'remote', 'set-url', 'origin', remoteUrl]);
        } else if (url) {
          await execute(process.execPath, [getInstallPath('skills/cpf-ohos-issue-analysis/scripts/repo-cache.mjs'), 'clone', '--repo', remoteUrl, '--dest', clone],
            { env, signal: input.signal, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
        } else {
          throw new Error('原仓库为本地来源且无可用本地副本，无法恢复');
        }
        // An unpopulated --no-checkout clone legitimately reports deleted files.
        await git(['-C', clone, 'checkout', '--detach', repo.commit, '--']);
        await rename(clone, dest);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    } else {
      if (await git(['-C', dest, 'status', '--porcelain'])) throw new Error('恢复目录已有修改，已保留，请检查后继续');
      // Exact baseline only. Falling back to today's branch head would invalidate comparison.
      await git(['-C', dest, 'checkout', '--detach', repo.commit, '--']);
    }
    repositories.push({ ...repo, path: dest });
  }
  const demo = join(input.workingDirectory, 'demo');
  const marker = '.ace-diagnosis-restore.json';
  if (existsSync(demo)) {
    if ((await optionalJson(join(demo, marker)))?.parent_run_id !== parentId) throw new Error('Demo 目录已存在但恢复未确认，已保留，请检查后继续');
  } else {
    const staging = await mkdtemp(join(input.workingDirectory, '.diagnosis-demo-'));
    try {
      await cp(sourceDemo, join(staging, 'demo'), { recursive: true, dereference: true,
        filter: async p => {
          if (['build', '.dart_tool', '.gradle', 'oh_modules', 'node_modules', marker].includes(basename(p))) return false;
          if (input.signal?.aborted) throw new Error('诊断已停止');
          const actual = await realpath(p);
          if (actual !== sourceDemo && !actual.startsWith(sourceDemo + sep)) throw new Error('原 Demo 包含指向工作目录外的文件，请先整理复现工程');
          return true;
        } });
      await writeFile(join(staging, 'demo', marker), JSON.stringify({ parent_run_id: parentId }), { mode: 0o600 });
      await rename(join(staging, 'demo'), demo);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  let pin = resolveOhosFlutterSdk({ branch: repositories.find(r => r.name === 'repo')?.branch || repositories[0].branch });
  if (pin.matched && pin.sdkRoot) {
    const overlay = createSdkOverlay(pin.sdkRoot, runSdkOverlayDir(input.runDirectory));
    if (!overlay.flutterBin) throw new Error('恢复 SDK 隔离失败');
    pin = { ...pin, sdkRoot: overlay.sdkLink, flutterBin: overlay.flutterBin };
  }
  await save(input, 'ohos-flutter-sdk.json', pin);
  const result = { ...context, run_id: basename(input.runDirectory), parent_run_id: parentId, repositories,
    demo_path: demo, repo_commit: repositories[0].commit, verdict: 'pass', context_completeness: 'complete',
    summary: '已按原提交恢复仓库、独立 Demo 和冻结验收判据', verification_status: 'needs_runtime_validation' };
  await save(input, 'diagnosis-inherited.json', result);
  return result;
}

/** Deterministic I/O steps. Semantic diagnosis and independent review stay with the agents. */
export async function executeDiagnosisScript(input: Input): Promise<string> {
  const env = await buildConfiguredProcessEnv(undefined, process.env, { userId: input.userId });
  let result: any;
  try {
    if (input.operation === 'preflight') {
      const [issue, checks] = await Promise.all([collectIssue(input, env), environment(input, env)]);
      // F11：建立 run 级隔离区（路径含 runId），并记录共享 SDK HAR 指纹基线
      const overlayDir = runSdkOverlayDir(input.runDirectory);
      await mkdir(join(overlayDir, 'har-cache'), { recursive: true });
      await mkdir(join(overlayDir, 'package-config'), { recursive: true });
      await mkdir(join(overlayDir, 'test-workspace'), { recursive: true });
      const sharedSdkFingerprints = await fingerprintSharedSdkHars();
      await save(input, 'diagnosis-input.json', issue);
      await save(input, 'diagnosis-preflight.json', { ...checks,
        sdk_overlay: overlayDir, shared_sdk_fingerprints: sharedSdkFingerprints });
      result = { verdict: issue.issue_content_complete && checks.git_available ? 'pass' : 'fail',
        summary: '问题正文和环境预检已归档；缺设备时先做静态分析并保留待运行验证标记',
        input_source: issue.input_source, issue_comments_count: issue.issue_comments_count,
        evaluation_mode: issue.evaluation_mode || null, snapshot_sha256: issue.snapshot_sha256 || null,
        sdk_overlay: overlayDir,
        artifact_path: 'outputs/diagnosis-input.json', environment: checks };
    } else if (input.operation === 'restore') result = await restore(input, env);
    else if (input.operation === 'finish') {
      const context = await captureContext(input, env);
      // F01/F04：归档状态必须显式进入结果，不能再出现"收尾脚本失败但 run 显示全部成功"。
      // R06：步骤级 verdict 只用统一三值枚举；归档完整度走 artifact_status 字段单独呈现。
      // 缺失必需证据或存在结论冲突均不能标通过。
      const artifactStatus = (context as any).artifact_status?.overall || 'complete';
      result = { verdict: artifactStatus !== 'complete' || context.verification_status === 'evidence_conflict' ? 'fail' : 'pass',
        summary: artifactStatus === 'complete'
          ? '诊断产物和可确认的继承信息已归档；缺失项保留待核对'
          : `产物归档不完整（artifact_status=${artifactStatus}），详见 outputs/diagnosis-archive-manifest.json`,
        artifact_path: 'outputs/diagnosis-context.json', context_completeness: context.context_completeness,
        verification_status: context.verification_status, verification_conflicts: context.verification_conflicts, verification_flags: (context as any).verification_flags,
        artifact_status: artifactStatus,
        error_code: artifactStatus === 'complete' ? undefined : ((context as any).artifact_status?.error_code || 'archive_incomplete'),
        artifact_failures: (context as any).artifact_status?.failed || [],
        consistency_warnings: (context as any).consistency_warnings || [],
        evaluation_mode: (context as any).evaluation_mode || null };
    } else result = { verdict: 'fail', summary: '诊断已终止，已保留阶段产物和错误记录，可查看预检及步骤详情' };
  } catch (error: any) {
    if (input.signal?.aborted) throw new Error('诊断已停止');
    // Child process diagnostics may contain credentials; expose only bounded first-party errors.
    const message = error.stdout !== undefined || error.stderr !== undefined ? '仓库恢复命令失败，请核对原始提交及网络后重试'
      : String(error.message || '诊断脚本失败').replace(/https?:\/\/[^\s]+/g, '[地址]').slice(0, 300);
    // F01：结构化错误类别；脚本步无模型调用，引擎重试该步即"只重试归档"
    result = { verdict: 'fail', summary: message, operation: input.operation,
      error_code: classifyDiagnosisScriptError(error), artifact_status: 'failed', retriable: true };
  }
  try {
    await save(input, `diagnosis-${input.operation}-result.json`, result);
  } catch {
    // F01：结果文件连工作目录都写不进去时，仍把结论经 stdout 交还状态机，不静默崩溃
    result.result_persist_failed = true;
  }
  return `<step-conclusion>${JSON.stringify(result)}</step-conclusion>`;
}
