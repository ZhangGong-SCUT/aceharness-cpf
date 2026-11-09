#!/usr/bin/env node
/**
 * 拉取并分析门禁日志，输出 outputs/gate-log-analysis.json。
 *
 * 用法：
 *   node fetch-gate-logs.mjs --build-log-url <CI评论里的 build.log 链接> \
 *        [--report-url <ecoTest report.zip 链接>] --out outputs
 *
 * 行为：
 * - 构建日志：build.log（指针文件）→ 跟随到 build.log.zip（实为 tar）→ 解出成员 → 归因。
 *   **本机实测可下载**，是"编译/构建阶段"的可靠证据。
 * - 跑测报告：评论里的主机 `download.ci.openharmony.cn` 本机不可解析，但同一路径在
 *   `cidownload.openharmony.cn` 可达 → 自动改写镜像域名后下载 zip，读 report_data.json 等做归因。
 *   实测可判定"跑测环境准备失败（用例未执行到断言）"。仍取不到才降级为 available:false。
 *
 * 该脚本永不因网络失败而抛错退出：降级路径写进 JSON 的 reasons/available 字段。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDirectRun } from './script-path.mjs';
import {
  analyzeTestReport,
  classifyGateLogRootCause,
  mirrorGateArtifactUrl,
  parseBuildJobLog,
  pickBuildLogMember,
  readTarMembers,
  resolveArtifactPointer,
} from './gate-log-analysis.mjs';

const MAX_ARTIFACT_BYTES = 80 * 1024 * 1024;
const MAX_REPORT_BYTES = 160 * 1024 * 1024;
const REPORT_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** 报告里真正需要的文件（hilog/截图/前端静态资源忽略）。 */
const REPORT_FILE_RE = /(?:^|\/)(?:report_data\.json|summary\.ini|summary_report\.xml|task_info\.record|result\/[^/]+\.xml|log\/task_log\.log|log\/[^/]+\/module_run\.log)$/i;

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

/** 网络错误 → 稳定的原因码，便于上层判断"是拿不到还是内容坏"。 */
export function normalizeFetchError(error) {
  const code = String(error?.cause?.code || error?.code || '');
  const name = String(error?.name || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_unresolved';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ETIMEDOUT' || name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  if (code) return code.toLowerCase();
  return 'network_error';
}

export async function httpGet(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 30000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    // 先用 Content-Length 拒绝超大产物，避免无谓下载（大报告可达 69MB+）
    const declared = Number(response.headers.get('content-length') || 0);
    if (options.maxBytes && declared > options.maxBytes) {
      return { ok: false, status: response.status, buffer: Buffer.alloc(0), error: 'too_large' };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (options.maxBytes && buffer.length > options.maxBytes) {
      return { ok: false, status: response.status, buffer: Buffer.alloc(0), error: 'too_large' };
    }
    return { ok: response.ok, status: response.status, buffer, error: '' };
  } catch (error) {
    return { ok: false, status: 0, buffer: Buffer.alloc(0), error: normalizeFetchError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function failureReason(result) {
  if (!result) return 'no_response';
  if (result.error) return result.error;
  if (result.status) return `http_${result.status}`;
  return 'unknown';
}

function decodeMembers(buffer) {
  let members = [];
  try {
    members = readTarMembers(buffer);
  } catch {
    members = [];
  }
  if (members.length > 0) return members;
  const text = buffer.toString('utf8');
  const looksLikeLog = /Finished:\s*(?:SUCCESS|FAILURE)|\bINFO\b|\[PRE_ENV:/.test(text);
  return looksLikeLog ? [{ name: 'build.log', size: buffer.length, text }] : [];
}

/** 下载并解析构建日志；任何一步失败都返回 { available:false, reason }。 */
export async function loadBuildLog(buildLogUrl, deps = {}) {
  const get = deps.get || ((url) => httpGet(url, { timeoutMs: deps.timeoutMs || 45000 }));
  const url = String(buildLogUrl || '');
  if (!url) return { available: false, reason: 'no_build_log_url', url: '' };

  const entry = await get(url);
  if (!entry.ok) return { available: false, reason: failureReason(entry), url };

  if (entry.buffer.length > MAX_ARTIFACT_BYTES) {
    return { available: false, reason: 'artifact_too_large', url, bytes: entry.buffer.length };
  }

  // build.log 实测是指针文件（105B，正文就是一个 .zip URL）→ 跟随下载真实产物
  const pointer = resolveArtifactPointer(entry.buffer.toString('utf8'), url);
  let artifact = entry;
  if (pointer && pointer !== url) {
    artifact = await get(pointer);
    if (!artifact.ok) return { available: false, reason: failureReason(artifact), url, resolved_url: pointer };
  }

  const members = decodeMembers(artifact.buffer);
  if (members.length === 0) {
    return { available: false, reason: 'no_member_decoded', url, resolved_url: pointer || url, bytes: artifact.buffer.length };
  }

  const member = pickBuildLogMember(members);
  const parsed = parseBuildJobLog(member.text, { memberName: member.name });
  return {
    ...parsed,
    url,
    resolved_url: pointer || url,
    bytes: artifact.buffer.length,
  };
}

/** 从 zip 里只挑分析需要的文本文件（report_data.json / summary.ini / result/*.xml / module_run.log …）。 */
async function readReportZip(buffer) {
  let directory;
  try {
    const { default: unzipper } = await import('unzipper');
    directory = await unzipper.Open.buffer(buffer);
  } catch {
    return [];
  }
  const files = [];
  for (const file of directory.files) {
    if (file.type !== 'File') continue;
    if (!REPORT_FILE_RE.test(file.path)) continue;
    if (Number(file.uncompressedSize || 0) > REPORT_FILE_MAX_BYTES) continue;
    try {
      files.push({ name: file.path, text: (await file.buffer()).toString('utf8') });
    } catch { /* 跳过坏成员 */ }
  }
  return files;
}

/** zip 按魔数判别，否则按 tar/gzip 处理。 */
async function decodeArtifact(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return readReportZip(buffer);
  return decodeMembers(buffer);
}

/**
 * 下载并解析跑测报告。
 * `download.ci.openharmony.cn` 是内网别名（本机不可解析），会先改写成可达镜像 `cidownload.openharmony.cn`；
 * 仍取不到时返回 { available:false, reason }，绝不据此声称抖动。
 */
export async function loadTestReport(reportUrl, deps = {}) {
  const get = deps.get || ((url) => httpGet(url, { timeoutMs: deps.timeoutMs || 60000, maxBytes: MAX_REPORT_BYTES }));
  const requested = String(reportUrl || '');
  if (!requested) return { available: false, reason: 'no_report_url', url: '' };

  const url = mirrorGateArtifactUrl(requested);
  const entry = await get(url);
  if (!entry.ok) return { available: false, reason: failureReason(entry), url, requested_url: requested };

  const files = await decodeArtifact(entry.buffer);
  if (files.length === 0) {
    return { available: false, reason: 'no_member_decoded', url, requested_url: requested, bytes: entry.buffer.length };
  }

  const analysis = analyzeTestReport(files);
  return {
    ...analysis,
    url,
    requested_url: requested,
    mirrored: url !== requested,
    bytes: entry.buffer.length,
    files: files.map((file) => file.name),
  };
}

/** 全流程：拿到结论对象（不写盘）。 */
export async function analyzeGateLogs(options = {}) {
  const deps = { get: options.get, timeoutMs: options.timeoutMs };
  const [build, test] = await Promise.all([
    loadBuildLog(options.buildLogUrl, deps),
    loadTestReport(options.reportUrl, deps),
  ]);
  const root = classifyGateLogRootCause({ build, test });
  return {
    ok: Boolean(build.available || test.available),
    analyzed_at: new Date().toISOString(),
    build_log_url: String(options.buildLogUrl || ''),
    report_url: String(options.reportUrl || ''),
    build,
    test,
    verdict: root.verdict,
    root_cause_verified: root.root_cause_verified,
    failure_cause: root.failure_cause,
    reasons: root.reasons,
    evidence: root.evidence,
  };
}

async function main() {
  const outDir = resolve(arg('--out', 'outputs'));
  const result = await analyzeGateLogs({
    buildLogUrl: arg('--build-log-url'),
    reportUrl: arg('--report-url'),
    timeoutMs: Number(arg('--timeout-ms', '0')) || undefined,
  });
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'gate-log-analysis.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}
