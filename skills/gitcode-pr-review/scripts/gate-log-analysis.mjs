/**
 * 门禁日志分析：从真实 CI 产物里读证据，区分「确定性问题（代码）」与「基础设施/平台问题」，
 * 避免只靠 CI 评论字符串匹配就断言"平台抖动"。
 *
 * 证据来源（均为实抓样本，非推测）：
 * 1. 构建日志：CI 评论里的 `.../log/build.log` 其实是指针文件（105B），正文指向
 *    `.../log/build.log.zip`；后者实测是 **未压缩的 tar**（file 判定 "POSIX tar archive"，
 *    只是扩展名叫 .zip），内含单个成员：
 *      - 成功：`ditribute_job_client`
 *      - 失败：`ditribute_job_client_failed`
 *    真实样本：tests/fixtures/gate-logs/pr2084-build-success.log（成功）、
 *    pr2106-build-script-failed.log（脚本失败）、pr1533-build-compile-failed.log（编译失败）。
 * 2. 跑测(ecoTest)报告：CI 评论里的链接主机是 `http://download.ci.openharmony.cn/...`，
 *    该域名在本机 DNS **不可解析**（实测 getent/公共 DoH 均为 NXDOMAIN，属内网域名）。
 *    但同一路径在 **`https://cidownload.openharmony.cn/`** 可下载（实测 200 / Zip，
 *    3.3MB~69MB），即 `download.ci` 只是 `cidownload` 的内网别名。
 *    报告是可解压 zip，关键文件：`report_data.json`（summary 与每个 module 的 error）、
 *    `summary.ini`、`result/<Suite>.xml`、`log/<Suite>/module_run.log`。
 *    实测样本（PR2084 10-16）：用例第一步「切换 Flutter 版本」执行
 *    `flutter_flutter PR worktree sync` 报 `fatal: not a git repository ... .git`，
 *    断言 `Failed to checkout flutter_flutter branch` 失败 → 测试用例根本没执行到断言。
 *
 * 设计原则：解析器只认**实测见过的字面标记**；认不出 → unknown/未验证，绝不猜测补全。
 */

import { gunzipSync } from 'node:zlib';

/**
 * 把内网别名域名改写成实测可达的镜像域名（同一路径）。
 * 实测：`http(s)://download.ci.openharmony.cn/log/ecoTest/...` → `https://cidownload.openharmony.cn/log/ecoTest/...` 返回 200。
 */
export function mirrorGateArtifactUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return raw.replace(/^https?:\/\/download\.ci\.openharmony\.cn\//i, 'https://cidownload.openharmony.cn/');
}

export const GATE_LOG_VERDICTS = [
  'compile_error',          // 构建日志有明确编译错误 → 确定性问题（代码）
  'build_script_failure',   // 构建脚本/tbuild 失败但无编译错误证据 → 根因未确认
  'infra_failure',          // 节点/镜像/取码/设备等基础设施阶段失败 → 平台问题（已验证）
  'harness_env_failure',    // 跑测用例未跑起来：测试框架/环境准备失败（如切换 Flutter 版本时同步 worktree 失败）→ 平台/环境侧（已验证），非 PR 代码
  'test_assertion',         // 跑测报告有真实断言/用例失败 → 确定性问题（代码）
  'test_hang',              // 跑测报告为超时/卡死 → 根因未确认，需人工
  'test_stage_unverified',  // 构建成功、跑测异步，报告不可得 → 未验证
  'unknown',
];

// ── 日志行级别与噪声过滤 ──────────────────────────────────────────────

/**
 * 构建日志里混着被回显的脚本源码（例如 `echo "[ERROR] $*" 1>&2`），
 * 以及 npm/工具的 WARN 噪声。判定失败前先剔除这些，否则会把回显当真错误。
 */
export function isBenignLogLine(line) {
  const text = String(line || '');
  if (!text) return true;
  if (/\bWARN\b/.test(text)) return true;
  if (/TAR_ENTRY_ERROR/.test(text)) return true;
  // CI 自己发的 pipeline 事件 JSON（{'topic': 'pipeline', 'message': {'buildResult': 'failed'...}}）不是日志
  if (/['"]topic['"]\s*:\s*['"]pipeline['"]/.test(text)) return true;
  if (/^\s*(?:echo|printf|cat|rm|touch|mkdir|export)\b/.test(text)) return true;
  if (/1>&2/.test(text)) return true;
  return false;
}

function isErrorLevelLine(line) {
  const text = String(line || '');
  return /\[ERROR\]\s*(?::|\s|$)/.test(text)
    || /\[ERROR\]:/.test(text)
    || /(?:^|\s)ERROR:\s*\S/.test(text)
    || /\b(?:Failed to|Unable to)\b/.test(text);
}

function uniqueLines(lines, limit) {
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    if (out.includes(line)) continue;
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

function shortLine(line, max = 240) {
  const text = String(line || '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function collectLines(lines, patterns, limit) {
  const out = [];
  for (const line of lines) {
    if (isBenignLogLine(line)) continue;
    if (patterns.some((re) => re.test(line))) {
      out.push(shortLine(line));
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ── tar 读取（CI 的 build.log.zip 实为未压缩 tar，偶尔也可能 gzip）──────

function cString(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8').trim();
}

/** 读 tar 里的普通文件成员（只取前几个，日志 tar 只有一个成员）。 */
export function readTarMembers(input, options = {}) {
  let buf = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = gunzipSync(buf);
  }
  const maxMembers = Number(options.maxMembers || 4);
  const members = [];
  let offset = 0;
  while (offset + 512 <= buf.length && members.length < maxMembers) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = cString(header.subarray(0, 100));
    const size = parseInt(cString(header.subarray(124, 136)) || '0', 8);
    if (!Number.isFinite(size)) break;
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) break;
    if (typeflag === '0' || typeflag === '\u0000' || typeflag === ' ') {
      members.push({ name, size, text: buf.subarray(dataStart, dataEnd).toString('utf8') });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return members;
}

/** 选中构建日志成员：优先 `*_failed`（失败轮次），否则第一个 ditribute_job_client。 */
export function pickBuildLogMember(members) {
  const list = Array.isArray(members) ? members : [];
  const failure = list.find((m) => /_failed$/i.test(String(m?.name || '')));
  if (failure) return { ...failure, failed_by_name: true };
  const normal = list.find((m) => /ditribute_job_client/i.test(String(m?.name || '')));
  if (normal) return { ...normal, failed_by_name: false };
  const first = list[0] || null;
  return first ? { ...first, failed_by_name: false } : null;
}

// ── build.log 解析 ────────────────────────────────────────────────────

const COMPILE_ERROR_PATTERNS = [
  /\bEngine compilation failed\b/,
  /\bCompile Flutter engine failed with exit code\b/,
  /\brunCommand error, code = \d+, command = (?:ninja|gn)\b/,
  /\bcompile failed\b/i,
  /\bninja: build stopped\b/,
  /^\s*FAILED:\s/,
  /\berror:\s+\S/,
  /\bBUILD FAILED\b/,
  /\bArkTS:ERROR\b/,
  /\bExecution failed for task\b/,
];

const SCRIPT_FAILURE_PATTERNS = [
  /build failed, cmd:.*(?:compile_build|pre_compile|after_compile)/,
  /\bTBuild failed\b/,
  /执行脚本失败/,
  /Cannot execute command:.*script returned exit code/,
];

const INFRA_ERROR_PATTERNS = [
  /Failed to (?:pull|create|start|connect|allocate|mount|login)\b/i,
  /Unable to (?:find|create|allocate|connect to|get)\b.*(?:executor|node|slave|resource)/i,
  /(?:no space left on device|disk quota exceeded)/i,
  /AccessDenied/i,
];

/**
 * 解析构建日志（build.log 的 tar 成员全文）。
 * 只认实测标记：`Finished: SUCCESS|FAILURE`、tar 成员名 `_failed`、
 * 编译错误字样、tbuild/脚本失败字样、基础设施错误行、ecoTest 触发结果。
 */
export function parseBuildJobLog(text, options = {}) {
  const memberName = String(options.memberName || '');
  const lines = String(text || '').split(/\r?\n/);

  let finished = '';
  for (const line of lines) {
    const match = line.match(/\bFinished:\s*(SUCCESS|FAILURE)\b/);
    if (match) finished = match[1];
  }
  const failedByName = /_failed$/i.test(memberName);
  const failed = finished === 'FAILURE' || failedByName;

  const compileErrors = collectLines(lines, COMPILE_ERROR_PATTERNS, 5);
  const scriptFailures = collectLines(lines, SCRIPT_FAILURE_PATTERNS, 5);

  const infraFailures = [];
  for (const line of lines) {
    if (isBenignLogLine(line)) continue;
    if (!isErrorLevelLine(line)) continue;
    if (INFRA_ERROR_PATTERNS.some((re) => re.test(line))
      || /\b(?:Timed out|timeout|超时)\b/i.test(line)) {
      infraFailures.push(shortLine(line));
      if (infraFailures.length >= 5) break;
    }
  }

  const stepFailures = uniqueLines(
    lines.map((line) => line.match(/\[ERROR\]\s*\[([a-zA-Z_]+:[a-zA-Z_0-9#]+)\]/)?.[1] || ''),
    6,
  );

  let hasTest = false;
  let ecoTestModule = '';
  for (const line of lines) {
    const testMatch = line.match(/\bhas_test['"]?\s*[:=]\s*['"]?(true|false)/i);
    if (testMatch && testMatch[1].toLowerCase() === 'true') hasTest = true;
    const moduleMatch = line.match(/\bEcoTestModule['"]?\s*[:=]\s*['"]?([A-Za-z0-9_]+)/);
    if (moduleMatch && !ecoTestModule) ecoTestModule = moduleMatch[1];
  }

  let ecoTestTrigger = null;
  for (const line of lines) {
    if (!/trigger[_ ]ecotest result/i.test(line)) continue;
    const taskId = line.match(/["']taskId["']\s*:\s*(\d+)/);
    const status = line.match(/["']status["']\s*:\s*["']([^"']+)/);
    ecoTestTrigger = {
      task_id: taskId ? Number(taskId[1]) : null,
      status: status ? status[1] : '',
      line: shortLine(line),
    };
  }

  const evidence = [];
  if (finished) evidence.push(`构建作业结束标记：Finished: ${finished}`);
  if (memberName) evidence.push(`构建日志 tar 成员：${memberName}`);
  evidence.push(...compileErrors.slice(0, 2));
  evidence.push(...scriptFailures.slice(0, 2));
  evidence.push(...infraFailures.slice(0, 2));
  if (ecoTestTrigger) evidence.push(`ecoTest 触发结果：${ecoTestTrigger.line}`);

  return {
    available: true,
    member: memberName,
    finished,
    failed,
    failed_by_member_name: failedByName,
    has_test: hasTest,
    eco_test_module: ecoTestModule,
    eco_test_trigger: ecoTestTrigger,
    compile_errors: compileErrors,
    script_failures: scriptFailures,
    infra_failures: infraFailures,
    step_failures: stepFailures,
    evidence: uniqueLines(evidence, 8),
  };
}

// ── 跑测报告解析（已对真实报告标定）──────────────────────────────────
//
// 真实报告（zip）关键文件与实测内容：
//   report_data.json : { "summary": {tests,passed,failed,...},
//                        "modules": [{name, tests, passed, failed, error, ...}] }
//   summary.ini      : [default] Platform= / Device Name= / Test Start/ End Time= ...
//   result/*.xml     : <testsuites ... message="[Script-XXXXXXX] <一句话原因>">
//   log/<Suite>/module_run.log : 用例执行明细（含 [ERROR]/[Script-...] 行）

/** 测试框架/环境准备失败——用例还没跑起来就失败。 */
const HARNESS_ENV_PATTERNS = [
  /Failed to checkout\b/i,
  /worktree sync failed/i,
  /not a git repository/i,
  /Failed to (?:deploy|install|prepare|flash|upgrade)\b/i,
];

/** 真实用例结果行：`run=2709 pass=2708 failure=1 error=0`（ecoTest 脚本汇总）。 */
const TEST_RESULT_COUNTS_RE = /run\s*=\s*(\d+)\s+pass\s*=\s*(\d+)\s+failure\s*=\s*(\d+)(?:\s+error\s*=\s*(\d+))?/i;

const TEST_ASSERTION_PATTERNS = [
  /\bAssertionError\b/,
  /\bExpected:\s.*\bReceived:/,
  /\bexpect\(.+\).*(?:to|received)/,
  /(?:失败用例|用例失败|失败)\s*[:：]/,
  /✗/,
];

const TEST_INFRA_PATTERNS = [
  /(?:no devices?|no available device|device (?:not found|offline|unavailable))/i,
  /(?:install(?:ation)? failed|failed to install)/i,
  /(?:hdc|adb)\b.{0,40}\b(?:fail|error|not found)/i,
  /(?:创建|申请).{0,6}(?:设备|环境).{0,4}失败/,
];

const TEST_TIMEOUT_PATTERNS = [
  /\btimed?\s*out\b/i,
  /\btimeout\b/i,
  /超时/,
];

function parseReportData(files) {
  const entry = files.find((file) => /(^|\/)report_data\.json$/i.test(file.name));
  if (!entry) return null;
  try {
    const data = JSON.parse(entry.text);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * 分析 ecoTest 报告解包后的文本文件。
 * 认得出的结论：harness_env_failure / test_assertion / infra_failure / test_hang；
 * 认不出返回 unknown，绝不据此声称"抖动"。
 */
export function analyzeTestReport(files) {
  const list = (Array.isArray(files) ? files : [])
    .filter((file) => file && typeof file.text === 'string')
    .map((file) => ({ name: String(file.name || ''), text: file.text }));
  if (list.length === 0) return { available: false, recognized: false, verdict: 'unknown', evidence: [] };

  const reportData = parseReportData(list);
  const summary = reportData?.summary && typeof reportData.summary === 'object' ? reportData.summary : null;
  const modules = Array.isArray(reportData?.modules) ? reportData.modules : [];

  const scan = (patterns) => {
    const out = [];
    for (const file of list) {
      for (const line of file.text.split(/\r?\n/)) {
        if (isBenignLogLine(line)) continue;
        if (patterns.some((re) => re.test(line))) {
          out.push(shortLine(`${file.name ? `${file.name}: ` : ''}${line}`));
          if (out.length >= 5) break;
        }
      }
      if (out.length >= 5) break;
    }
    return out;
  };

  // 1) 先看结构化 report_data.json 的 module.error（最权威）
  const moduleErrors = modules
    .map((module) => String(module?.error || '').trim())
    .filter(Boolean);

  const harness = uniqueLines(
    [...moduleErrors.filter((error) => HARNESS_ENV_PATTERNS.some((re) => re.test(error))), ...scan(HARNESS_ENV_PATTERNS)],
    5,
  );

  // 2) 用例执行计数：从 module.error / 报告文本里抽 `run=N pass=M failure=K`
  let counts = null;
  const countSources = [...moduleErrors, ...list.map((file) => file.text)];
  for (const source of countSources) {
    const match = String(source).match(TEST_RESULT_COUNTS_RE);
    if (match) {
      counts = { run: Number(match[1]), pass: Number(match[2]), failure: Number(match[3]), error: match[4] == null ? null : Number(match[4]) };
      break;
    }
  }

  const assertion = scan(TEST_ASSERTION_PATTERNS);
  const infra = scan(TEST_INFRA_PATTERNS);
  const timeout = scan(TEST_TIMEOUT_PATTERNS);

  const reportSummary = summary
    ? { tests: summary.tests ?? null, passed: summary.passed ?? null, failed: summary.failed ?? null, modules: summary.modules ?? modules.length }
    : null;

  const base = {
    available: true,
    report_summary: reportSummary,
    module_errors: moduleErrors.slice(0, 5),
    test_counts: counts,
  };

  // 环境/框架准备失败优先：用例没跑起来，任何"断言失败"都无从谈起。
  if (harness.length > 0) {
    return {
      ...base,
      recognized: true,
      verdict: 'harness_env_failure',
      evidence: uniqueLines(harness, 5),
    };
  }
  if (counts && counts.failure > 0) {
    return {
      ...base,
      recognized: true,
      verdict: 'test_assertion',
      evidence: uniqueLines(assertion.length ? assertion : [`用例实测计数：${JSON.stringify(counts)}`], 5),
    };
  }
  if (assertion.length > 0) {
    return { ...base, recognized: true, verdict: 'test_assertion', evidence: assertion };
  }
  if (infra.length > 0) {
    return { ...base, recognized: true, verdict: 'infra_failure', evidence: infra };
  }
  if (timeout.length > 0) {
    return { ...base, recognized: true, verdict: 'test_hang', evidence: timeout };
  }

  return { ...base, recognized: false, verdict: 'unknown', evidence: [] };
}

// ── 归因 ──────────────────────────────────────────────────────────────

/**
 * 汇总构建日志 + 跑测报告，给出根因结论。
 * root_cause_verified=true 仅当日志里存在**直接证据**（编译错误 / 基础设施错误 / 断言失败）。
 * 其余一律 false——包括"构建成功但测试异步、报告拿不到"这种最常见情形。
 */
export function classifyGateLogRootCause(input = {}) {
  const build = input.build && input.build.available !== false ? input.build : null;
  const test = input.test || null;
  const reasons = [];
  const evidence = [];

  let verdict = 'unknown';
  let rootCauseVerified = false;
  let causeKind = 'unknown';

  if (build) {
    evidence.push(...(build.evidence || []));
    if ((build.compile_errors || []).length > 0) {
      verdict = 'compile_error';
      rootCauseVerified = true;
      causeKind = 'deterministic';
      reasons.push('构建日志出现明确编译错误');
    } else if ((build.infra_failures || []).length > 0) {
      verdict = 'infra_failure';
      rootCauseVerified = true;
      causeKind = 'infra';
      reasons.push('构建阶段失败，错误行落在基础设施（节点/镜像/取码/超时）');
    } else if (build.failed && (build.script_failures || []).length > 0) {
      verdict = 'build_script_failure';
      reasons.push('构建脚本/tbuild 执行失败，但日志未见编译错误证据——无法判定是代码问题');
    } else if (build.failed) {
      verdict = 'unknown';
      reasons.push('构建作业失败，但未识别到编译错误或基础设施错误标记');
    } else if (build.finished === 'SUCCESS' && build.has_test) {
      verdict = 'test_stage_unverified';
      reasons.push('构建阶段成功；测试是异步 ecoTest 任务，结论在独立报告里，构建日志不含测试结果');
    } else if (build.finished === 'SUCCESS') {
      verdict = 'unknown';
      reasons.push('构建成功且本轮未声明测试任务；失败可能来自静态检查或其它阶段');
    } else {
      reasons.push('构建日志未给出结束标记');
    }
  } else {
    reasons.push('构建日志不可获取');
  }

  if (test && test.available && test.recognized) {
    evidence.push(...(test.evidence || []));
    if (test.verdict === 'harness_env_failure') {
      verdict = 'harness_env_failure';
      rootCauseVerified = true;
      causeKind = 'infra';
      reasons.push('跑测用例未执行到断言：测试框架/环境准备失败（如切换/同步 Flutter 代码时失败），属平台/环境侧，不是 PR 代码问题');
    } else if (test.verdict === 'test_assertion') {
      verdict = 'test_assertion';
      rootCauseVerified = true;
      causeKind = 'deterministic';
      reasons.push('跑测报告出现真实断言/用例失败');
    } else if (test.verdict === 'infra_failure') {
      verdict = 'infra_failure';
      rootCauseVerified = true;
      causeKind = 'infra';
      reasons.push('跑测报告为设备/环境失败');
    } else if (test.verdict === 'test_hang') {
      verdict = 'test_hang';
      reasons.push('跑测报告为超时/卡死，需人工确认');
    }
  } else if (test && test.available === false) {
    reasons.push(`跑测报告不可获取（${test.reason || '未知原因'}）`);
  }

  return {
    verdict,
    root_cause_verified: rootCauseVerified,
    failure_cause: causeKind,
    reasons,
    evidence: uniqueLines(evidence, 8),
  };
}

/** 给 classifyOhosPrGates / 人工复核看的单句结论。 */
export function describeGateLogVerdict(analysis) {
  if (!analysis || typeof analysis !== 'object') return '';
  switch (String(analysis.verdict || 'unknown')) {
    case 'compile_error':
      return '构建日志已确认编译错误，属确定性问题，不按抖动重试';
    case 'build_script_failure':
      return '构建脚本/tbuild 失败但未见编译错误证据，根因未确认（疑似构建基础设施），不得断言为代码问题';
    case 'infra_failure':
      return '日志已确认失败落在基础设施阶段（节点/镜像/取码/设备），属平台问题';
    case 'harness_env_failure':
      return '跑测报告已确认：用例未执行到断言，失败在测试框架/环境准备阶段（如切换/同步 Flutter 代码），属平台/环境侧，不是 PR 代码问题';
    case 'test_assertion':
      return '跑测报告已确认真实断言失败，属确定性问题，不按抖动重试';
    case 'test_hang':
      return '跑测报告为超时/卡死，根因未确认，需人工确认';
    case 'test_stage_unverified':
      return '构建阶段成功、跑测为异步任务且报告不可得，根因未验证——按疑似基础设施超时处理，不得断言为平台抖动';
    default:
      return '日志未能给出可归因结论，根因未验证';
  }
}

// ── 从 CI 评论里提取日志地址 ──────────────────────────────────────────

/** CI 评论里的构建日志入口（多个构建 target 会有多条）。 */
export function extractBuildLogUrls(comments) {
  const urls = [];
  for (const item of Array.isArray(comments) ? comments : []) {
    const body = String(item?.body || '');
    for (const match of body.matchAll(/https:\/\/cidownload\.openharmony\.cn\/Artifacts\/[^\s)'"<>]*?\/log\/build\.log/gi)) {
      if (!urls.includes(match[0])) urls.push(match[0]);
    }
  }
  return urls;
}

/** CI 评论里的跑测报告地址（ecoTest report.zip）。download.ci 是内网别名，cidownload 是可达镜像，两者都收。 */
export function extractEcoTestReportUrls(comments) {
  const urls = [];
  for (const item of Array.isArray(comments) ? comments : []) {
    const body = String(item?.body || '');
    for (const match of body.matchAll(/https?:\/\/(?:download\.ci|cidownload)\.openharmony\.cn\/log\/ecoTest\/[^\s)'"<>]+report\.zip/gi)) {
      if (!urls.includes(match[0])) urls.push(match[0]);
    }
  }
  return urls;
}

/** 指针文件判定：整份内容就是一个 .zip/产物 URL（实测 build.log 是 105B 指针）。 */
export function resolveArtifactPointer(text, baseUrl = '') {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\/\S+$/i.test(raw)) return '';
  if (!raw.includes('://')) return '';
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch {
    return raw;
  }
}
