import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  analyzeGateLogs,
  loadBuildLog,
  loadTestReport,
  normalizeFetchError,
} from '../skills/gitcode-pr-review/scripts/fetch-gate-logs.mjs';
import {
  analyzeTestReport,
  classifyGateLogRootCause,
  describeGateLogVerdict,
  extractBuildLogUrls,
  extractEcoTestReportUrls,
  mirrorGateArtifactUrl,
  parseBuildJobLog,
  pickBuildLogMember,
  readTarMembers,
  resolveArtifactPointer,
} from '../skills/gitcode-pr-review/scripts/gate-log-analysis.mjs';
import { classifyOhosPrGates } from '../skills/gitcode-pr-review/scripts/ohos-pr-gates.mjs';
import { PR1978_GATE_FAIL_COMMENT } from './fixtures/pr1978-gate-comment';

// ── 真实样本（原样摘录自 CI 产物，见 fixture 头部来源注释）────────────
const SUCCESS_LOG = readFileSync(resolve(process.cwd(), 'tests/fixtures/gate-logs/pr2084-build-success.log'), 'utf8');
const COMPILE_FAIL_LOG = readFileSync(resolve(process.cwd(), 'tests/fixtures/gate-logs/pr1533-build-compile-failed.log'), 'utf8');
// 真实跑测报告（zip 裁剪：保留 report_data.json / summary.ini / result/*.xml / module_run.log 全文）
const PR2084_REPORT_ZIP = readFileSync(resolve(process.cwd(), 'tests/fixtures/gate-logs/pr2084-report.zip'));
const PR2109_REPORT_ZIP = readFileSync(resolve(process.cwd(), 'tests/fixtures/gate-logs/pr2109-report.zip'));

// ── 合成样本（人工构造，仅用于覆盖真实样本里没有的分支）────────────────
const SCRIPT_FAIL_LOG = [
  '[2026/10/16 02:56:05.803 GMT+08:00] [INFO]  : [JobStatusPlugin] onStarted: j_synth #1',
  '[2026/10/16 03:32:29.636 GMT+08:00] [CloudCache] 2026/10/16 03:32:29 build failed, cmd: [bash -c bash ***//entrance_script/generate_ci_build.sh compile_build] err: exit status 1',
  "[2026/10/16 03:32:30.770 GMT+08:00] [INFO] [tbuild_execute:tbuild_execute#tbuild_execute] : Cannot execute command: /opt/buildtools/tbuild/tbuild -b 'bash generate_ci_build.sh compile_build', errMsg: script returned exit code 255, exitMessage: command run failed",
  '[2026/10/16 03:32:30.770 GMT+08:00] [ERROR] [tbuild_execute:tbuild_execute#tbuild_execute] : TBuild failed, 执行脚本失败',
  '[2026/10/16 03:32:43.247 GMT+08:00] Finished: FAILURE',
].join('\n');

const INFRA_FAIL_LOG = [
  '[2026/10/16 02:55:53.820 GMT+08:00] [INFO]  : [JobStatusPlugin] onStarted: j_infra #1',
  '[2026/10/16 02:56:05.803 GMT+08:00] [INFO] [PRE_ENV:slave_create] : [slave] Waiting for executor node connection...',
  '[2026/10/16 02:58:05.803 GMT+08:00] [ERROR] [PRE_ENV:slave_create] : Failed to pull image swr.cn-north-4.myhuaweicloud.com/ci-service/openharmony-flutter-build-env:3.0.0',
  '[2026/10/16 03:00:05.803 GMT+08:00] [ERROR] [tbuild_execute:tbuild_execute#tbuild_execute] : Unable to find available executor node, Timed out after 600s',
  '[2026/10/16 03:00:10.000 GMT+08:00] Finished: FAILURE',
].join('\n');

/** 造一个 tar（与 CI 的 build.log.zip 同格式：未压缩 tar）。 */
function buildTar(entries: Array<{ name: string; text: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.text, 'utf8');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644 \u0000', 100, 8, 'utf8');
    header.write('0000000 \u0000', 108, 8, 'utf8');
    header.write('0000000 \u0000', 116, 8, 'utf8');
    header.write(`${data.length.toString(8).padStart(11, '0')} `, 124, 12, 'utf8');
    header.write('00000000000 ', 136, 12, 'utf8');
    header.fill(' ', 148, 156);
    header.write('0', 156, 1, 'utf8');
    header.write('ustar  \u0000', 257, 8, 'utf8');
    header.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')} \u0000`, 148, 8, 'utf8');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe('gate-log-analysis / tar 读取', () => {
  test('解出 tar 成员，失败轮次用 _failed 成员名', () => {
    const members = readTarMembers(buildTar([
      { name: 'ditribute_job_client_failed', text: 'Finished: FAILURE\n' },
    ]));
    expect(members).toHaveLength(1);
    expect(members[0].name).toBe('ditribute_job_client_failed');
    expect(pickBuildLogMember(members)).toMatchObject({ failed_by_name: true });
  });

  test('成功轮次成员名不带后缀，失败标志为 false', () => {
    const members = readTarMembers(buildTar([{ name: 'ditribute_job_client', text: 'Finished: SUCCESS\n' }]));
    expect(pickBuildLogMember(members)).toMatchObject({ failed_by_name: false });
  });

  test('指针文件解析：整份内容是 URL 才认；普通日志正文不认', () => {
    expect(resolveArtifactPointer('https://cidownload.openharmony.cn/x/log/build.log.zip\n', 'https://a/b'))
      .toBe('https://cidownload.openharmony.cn/x/log/build.log.zip');
    expect(resolveArtifactPointer('Finished: SUCCESS\n[INFO] something')).toBe('');
    expect(resolveArtifactPointer('')).toBe('');
  });
});

describe('gate-log-analysis / build.log 归因', () => {
  test('真实成功样本：Finished SUCCESS、含测试、触发 ecoTest，且噪声不产生假失败', () => {
    const parsed = parseBuildJobLog(SUCCESS_LOG, { memberName: 'ditribute_job_client' });
    expect(parsed.finished).toBe('SUCCESS');
    expect(parsed.failed).toBe(false);
    expect(parsed.has_test).toBe(true);
    expect(parsed.eco_test_module).toBe('FLUTTER_FW_TEST_201');
    expect(parsed.eco_test_trigger).toMatchObject({ task_id: 2298970, status: 'Success' });
    // 日志里有 `echo "[ERROR] $*" 1>&2`、`[WARNING] find empty runtime`、`timeout 600s repo forall`
    // —— 都必须被噪声过滤挡掉，不能算失败证据。
    expect(parsed.compile_errors).toEqual([]);
    expect(parsed.script_failures).toEqual([]);
    expect(parsed.infra_failures).toEqual([]);
  });

  test('真实编译失败样本：抓到 engine 编译错误，且不误判为基础设施', () => {
    const parsed = parseBuildJobLog(COMPILE_FAIL_LOG, { memberName: 'ditribute_job_client_failed' });
    expect(parsed.failed).toBe(true);
    expect(parsed.finished).toBe('FAILURE');
    expect(parsed.compile_errors.join('\n')).toContain('Engine compilation failed');
    expect(parsed.compile_errors.join('\n')).toContain('ninja: build stopped');
    // npm WARN TAR_ENTRY_ERROR 不能被当成错误
    expect(parsed.compile_errors.join('\n')).not.toContain('TAR_ENTRY_ERROR');
    expect(parsed.infra_failures).toEqual([]);
  });

  test('成功 + 异步测试 → test_stage_unverified（未验证，不得当抖动）', () => {
    const build = parseBuildJobLog(SUCCESS_LOG, { memberName: 'ditribute_job_client' });
    const result = classifyGateLogRootCause({ build, test: { available: false, reason: 'dns_unresolved' } });
    expect(result.verdict).toBe('test_stage_unverified');
    expect(result.root_cause_verified).toBe(false);
    expect(result.failure_cause).toBe('unknown');
    expect(result.reasons.join('\n')).toContain('dns_unresolved');
  });

  test('编译错误 → compile_error（已验证、确定性）', () => {
    const build = parseBuildJobLog(COMPILE_FAIL_LOG, { memberName: 'ditribute_job_client_failed' });
    const result = classifyGateLogRootCause({ build });
    expect(result.verdict).toBe('compile_error');
    expect(result.root_cause_verified).toBe(true);
    expect(result.failure_cause).toBe('deterministic');
  });

  test('只有脚本/tbuild 失败、无编译错误 → build_script_failure（未验证，不诬为代码问题）', () => {
    const build = parseBuildJobLog(SCRIPT_FAIL_LOG, { memberName: 'ditribute_job_client_failed' });
    expect(build.compile_errors).toEqual([]);
    expect(build.script_failures.length).toBeGreaterThan(0);
    const result = classifyGateLogRootCause({ build });
    expect(result.verdict).toBe('build_script_failure');
    expect(result.root_cause_verified).toBe(false);
  });

  test('基础设施错误行（拉镜像失败/无可用执行节点）→ infra_failure（已验证）', () => {
    const build = parseBuildJobLog(INFRA_FAIL_LOG, { memberName: 'ditribute_job_client_failed' });
    expect(build.infra_failures.length).toBeGreaterThan(0);
    const result = classifyGateLogRootCause({ build });
    expect(result.verdict).toBe('infra_failure');
    expect(result.root_cause_verified).toBe(true);
    expect(result.failure_cause).toBe('infra');
  });
});

describe('gate-log-analysis / 跑测报告与评论地址', () => {
  test('报告缺失/断言/设备失败/无法识别', () => {
    expect(analyzeTestReport([])).toMatchObject({ available: false, recognized: false });
    expect(analyzeTestReport([{ name: 'r.txt', text: 'AssertionError: Expected: 1 Received: 2' }]))
      .toMatchObject({ verdict: 'test_assertion' });
    expect(analyzeTestReport([{ name: 'r.txt', text: 'hdc: device not found, install failed' }]))
      .toMatchObject({ verdict: 'infra_failure' });
    expect(analyzeTestReport([{ name: 'r.txt', text: 'everything is fine here' }]))
      .toMatchObject({ verdict: 'unknown', recognized: false });
  });

  test('断言失败报告覆盖未验证结论 → 确定性', () => {
    const build = parseBuildJobLog(SUCCESS_LOG, { memberName: 'ditribute_job_client' });
    const test = analyzeTestReport([{ name: 'r.txt', text: '✗ testFoo 失败: AssertionError' }]);
    const result = classifyGateLogRootCause({ build, test });
    expect(result.verdict).toBe('test_assertion');
    expect(result.root_cause_verified).toBe(true);
    expect(result.failure_cause).toBe('deterministic');
  });

  test('从 CI 评论里提取 build.log / ecoTest 报告地址', () => {
    const comments = [
      { body: '门禁未通过 https://cidownload.openharmony.cn/Artifacts/flutter_x/20261016-1-00003/log/build.log' },
      { body: '测试 http://download.ci.openharmony.cn/log/ecoTest/task_2298970/block_abc_1/report.zip' },
    ];
    expect(extractBuildLogUrls(comments)).toEqual([
      'https://cidownload.openharmony.cn/Artifacts/flutter_x/20261016-1-00003/log/build.log',
    ]);
    expect(extractEcoTestReportUrls(comments)).toEqual([
      'http://download.ci.openharmony.cn/log/ecoTest/task_2298970/block_abc_1/report.zip',
    ]);
  });
});

describe('gate-log-analysis / 真实跑测报告（已对 zip 标定）', () => {
  const getZip = (buffer: Buffer) => async (url: string) => (
    url.includes('/log/ecoTest/')
      ? { ok: true, status: 200, buffer, error: '' }
      : { ok: false, status: 0, buffer: Buffer.alloc(0), error: 'not_used' }
  );

  test('download.ci 内网别名 → 可达镜像 cidownload（同路径），cidownload 原样保留', () => {
    expect(mirrorGateArtifactUrl('http://download.ci.openharmony.cn/log/ecoTest/task_1/block_2/report.zip'))
      .toBe('https://cidownload.openharmony.cn/log/ecoTest/task_1/block_2/report.zip');
    expect(mirrorGateArtifactUrl('https://download.ci.openharmony.cn/log/ecoTest/task_1/report.zip'))
      .toBe('https://cidownload.openharmony.cn/log/ecoTest/task_1/report.zip');
    expect(mirrorGateArtifactUrl('https://cidownload.openharmony.cn/x/log/build.log'))
      .toBe('https://cidownload.openharmony.cn/x/log/build.log');
    expect(mirrorGateArtifactUrl('')).toBe('');
  });

  test('真实 PR2084 报告（10-16）：用例没跑到断言、环境准备失败 → harness_env_failure（已验证/平台侧）', async () => {
    const test = await loadTestReport(
      'http://download.ci.openharmony.cn/log/ecoTest/task_2298970/block_x_1/report.zip',
      { get: getZip(PR2084_REPORT_ZIP) },
    );
    expect(test).toMatchObject({ available: true, recognized: true, verdict: 'harness_env_failure', mirrored: true });
    expect(test.report_summary).toMatchObject({ tests: 2, passed: 0, failed: 2 });
    expect(test.evidence.join('\n')).toContain('Failed to checkout flutter_flutter branch');

    const build = parseBuildJobLog(SUCCESS_LOG, { memberName: 'ditribute_job_client' });
    const root = classifyGateLogRootCause({ build, test });
    expect(root.verdict).toBe('harness_env_failure');
    expect(root.root_cause_verified).toBe(true);
    expect(root.failure_cause).toBe('infra');
    expect(describeGateLogVerdict(root)).toContain('不是 PR 代码问题');
  });

  test('真实 PR2109 报告（10-12）：用例真跑了并失败 → test_assertion（确定性）', async () => {
    const test = await loadTestReport(
      'http://download.ci.openharmony.cn/log/ecoTest/task_2287804/block_x_1/report.zip',
      { get: getZip(PR2109_REPORT_ZIP) },
    );
    expect(test).toMatchObject({ available: true, recognized: true, verdict: 'test_assertion' });
    expect(test.test_counts).toMatchObject({ run: 2709, pass: 2708, failure: 1 });

    const build = parseBuildJobLog(SUCCESS_LOG, { memberName: 'ditribute_job_client' });
    const root = classifyGateLogRootCause({ build, test });
    expect(root.verdict).toBe('test_assertion');
    expect(root.root_cause_verified).toBe(true);
    expect(root.failure_cause).toBe('deterministic');
  });

  test('评论里的 cidownload 镜像地址也能被提取（不再只认 download.ci）', () => {
    expect(extractEcoTestReportUrls([
      { body: '测试 https://cidownload.openharmony.cn/log/ecoTest/task_1/block_a_1/report.zip' },
    ])).toEqual(['https://cidownload.openharmony.cn/log/ecoTest/task_1/block_a_1/report.zip']);
  });

  test('真实报告 zip 在离线注入下即可判定（不需要网络）', async () => {
    // 同一份 PR2084 报告用 tar 之外的 zip 通道解析 → 证明 readReportZip 走通且只挑需要的成员
    const test = await loadTestReport('https://cidownload.openharmony.cn/log/ecoTest/t/r/report.zip', {
      get: getZip(PR2084_REPORT_ZIP),
    });
    expect(test.files).toContain('report_data.json');
    expect(test.files).not.toContain('static/vue.global.js');
  });
});

describe('fetch-gate-logs / 下载与降级', () => {
  test('网络错误码归一化', () => {
    expect(normalizeFetchError({ cause: { code: 'ENOTFOUND' } })).toBe('dns_unresolved');
    expect(normalizeFetchError({ name: 'AbortError' })).toBe('timeout');
    expect(normalizeFetchError({ cause: { code: 'ECONNREFUSED' } })).toBe('connection_refused');
  });

  test('指针 → tar 两跳下载后可归因（注入 fetch，无需网络）', async () => {
    const tar = buildTar([{ name: 'ditribute_job_client', text: SUCCESS_LOG }]);
    const calls: string[] = [];
    const get = async (url: string) => {
      calls.push(url);
      if (url === 'https://cdn/log/build.log') {
        return { ok: true, status: 200, buffer: Buffer.from('https://cdn/artifacts/build.log.zip\n'), error: '' };
      }
      return { ok: true, status: 200, buffer: tar, error: '' };
    };
    const build = await loadBuildLog('https://cdn/log/build.log', { get });
    expect(calls).toEqual(['https://cdn/log/build.log', 'https://cdn/artifacts/build.log.zip']);
    expect(build).toMatchObject({ available: true, member: 'ditribute_job_client', finished: 'SUCCESS', has_test: true });
  });

  test('报告主机 DNS 不可达 → available:false / dns_unresolved（不抛错）', async () => {
    const test = await loadTestReport('http://download.ci.openharmony.cn/log/ecoTest/task_1/block_2/report.zip', {
      get: async () => ({ ok: false, status: 0, buffer: Buffer.alloc(0), error: 'dns_unresolved' }),
    });
    expect(test).toMatchObject({ available: false, reason: 'dns_unresolved' });
  });

  test('构建日志非 tar 且非日志正文 → no_member_decoded', async () => {
    const build = await loadBuildLog('https://cdn/log/build.log', {
      get: async () => ({ ok: true, status: 200, buffer: Buffer.from('<html>not a log</html>'), error: '' }),
    });
    expect(build).toMatchObject({ available: false, reason: 'no_member_decoded' });
  });

  test('全流程（注入 fetch）：构建成功 + 报告不可得 → test_stage_unverified', async () => {
    const tar = buildTar([{ name: 'ditribute_job_client', text: SUCCESS_LOG }]);
    const get = async (url: string) => (
      url.includes('/log/ecoTest/')
        ? { ok: false, status: 0, buffer: Buffer.alloc(0), error: 'dns_unresolved' }
        : { ok: true, status: 200, buffer: tar, error: '' }
    );
    const result = await analyzeGateLogs({
      buildLogUrl: 'https://cidownload.openharmony.cn/Artifacts/x/20261016-1-00003/log/build.log',
      reportUrl: 'http://download.ci.openharmony.cn/log/ecoTest/task_1/block_2/report.zip',
      get,
    });
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('test_stage_unverified');
    expect(result.root_cause_verified).toBe(false);
    expect(result.reasons.join('\n')).toContain('dns_unresolved');
  });

  test('CLI 实跑：拿不到的地址也退出 0 并写出降级 JSON（离线可跑）', () => {
    const out = mkdtempSync(join(tmpdir(), 'gate-logs-'));
    const script = resolve(process.cwd(), 'skills/gitcode-pr-review/scripts/fetch-gate-logs.mjs');
    try {
      execFileSync(process.execPath, [
        script,
        '--build-log-url', 'http://no-such-host.invalid/log/build.log',
        '--out', out,
      ], { encoding: 'utf8', timeout: 60000 });
      const written = JSON.parse(readFileSync(join(out, 'gate-log-analysis.json'), 'utf8'));
      expect(written.build.available).toBe(false);
      expect(written.root_cause_verified).toBe(false);
      expect(written.verdict).toBe('unknown');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('classifyOhosPrGates / 接入日志证据', () => {
  const flakyComments = [
    { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
    { author: 'dev', body: 'start build', created_at: '2026-09-09T09:58:00Z' },
    { author: 'openharmony_ci', body: '门禁构建开始,预计60分钟', created_at: '2026-09-09T09:59:00Z' },
    { author: 'openharmony_ci', body: PR1978_GATE_FAIL_COMMENT, created_at: '2026-09-09T11:13:00Z' },
  ];
  const flakyLabels = ['dco检查成功', '静态检查成功', '编译成功', '冒烟测试失败'];

  test('未验证（构建成功+报告拿不到）：仍可重试，但明确不得断言平台抖动', () => {
    const result = classifyOhosPrGates({
      labels: flakyLabels,
      comments: flakyComments,
      state: 'open',
      own_pr: true,
      log_analysis: {
        verdict: 'test_stage_unverified',
        root_cause_verified: false,
        failure_cause: 'unknown',
        reasons: ['构建阶段成功；测试是异步 ecoTest 任务', '跑测报告不可获取（dns_unresolved）'],
        evidence: ['构建作业结束标记：Finished: SUCCESS'],
      },
    });
    expect(result.phase).toBe('need_start_build');
    expect(result.log_verdict).toBe('test_stage_unverified');
    expect(result.root_cause_verified).toBe(false);
    expect(result.summary).toContain('根因未验证');
    expect(result.summary).toContain('不得断言为平台抖动');
  });

  test('日志确认为确定性测试失败：不再烧抖动重试预算，直接人工确认', () => {
    const result = classifyOhosPrGates({
      labels: flakyLabels,
      comments: flakyComments,
      state: 'open',
      own_pr: true,
      log_analysis: { verdict: 'test_assertion', root_cause_verified: true, failure_cause: 'deterministic' },
    });
    expect(result.phase).toBe('test_failed');
    expect(result.summary).toContain('确定性失败');
  });

  test('日志确认为基础设施失败：重试，且标记已验证', () => {
    const result = classifyOhosPrGates({
      labels: flakyLabels,
      comments: flakyComments,
      state: 'open',
      own_pr: true,
      log_analysis: { verdict: 'infra_failure', root_cause_verified: true, failure_cause: 'infra' },
    });
    expect(result.phase).toBe('need_start_build');
    expect(result.root_cause_verified).toBe(true);
    expect(result.summary).toContain('基础设施阶段');
  });

  test('日志确认为跑测环境准备失败：平台侧、非 PR 代码，重试且直说', () => {
    const result = classifyOhosPrGates({
      labels: flakyLabels,
      comments: flakyComments,
      state: 'open',
      own_pr: true,
      log_analysis: { verdict: 'harness_env_failure', root_cause_verified: true, failure_cause: 'infra' },
    });
    expect(result.phase).toBe('need_start_build');
    expect(result.root_cause_verified).toBe(true);
    expect(result.log_verdict).toBe('harness_env_failure');
    expect(result.summary).toContain('测试环境准备失败');
    expect(result.summary).toContain('不是 PR 代码问题');
  });

  test('跑测环境准备失败 + 预算用尽 → test_failed，summary 说明原因并提示联系门禁维护', () => {
    const result = classifyOhosPrGates({
      labels: flakyLabels,
      comments: flakyComments,
      state: 'open',
      own_pr: true,
      start_build_max: 1,
      jitter_retry_max: 1,
      log_analysis: { verdict: 'harness_env_failure', root_cause_verified: true, failure_cause: 'infra' },
    });
    expect(result.phase).toBe('test_failed');
    expect(result.retry_budget_exhausted).toBe(true);
    expect(result.needs_maintainer).toBe(true);
    expect(result.log_platform_verified).toBe(true);
    expect(result.maintainer_hint).toContain('联系门禁维护人员');
    expect(result.maintainer_hint).toContain('非 PR 代码');
    expect(result.summary).toContain('测试环境准备失败');
    expect(result.summary).toContain('不是 PR 代码问题');
    expect(result.summary).toContain('联系门禁维护人员');
  });

  test('预算用尽 + 日志未知（根因未核实）→ 提醒维护人员，但不得排除 PR 代码', () => {
    const result = classifyOhosPrGates({
      labels: flakyLabels,
      comments: flakyComments,
      state: 'open',
      own_pr: true,
      start_build_max: 1,
      jitter_retry_max: 1,
      log_analysis: { verdict: 'unknown', root_cause_verified: false },
    });
    expect(result.phase).toBe('test_failed');
    expect(result.retry_budget_exhausted).toBe(true);
    expect(result.needs_maintainer).toBe(true);
    expect(result.log_platform_verified).toBe(false);
    expect(result.maintainer_hint).toContain('联系门禁维护人员');
    expect(result.maintainer_hint).toContain('根因未核实');
    expect(result.maintainer_hint).not.toContain('非 PR 代码');
    expect(result.summary).not.toContain('不是 PR 代码问题');
  });

  test('预算用尽但日志确认是代码问题（确定性）→ 不提示门禁维护，走代码修复', () => {
    const result = classifyOhosPrGates({
      labels: flakyLabels,
      comments: flakyComments,
      state: 'open',
      own_pr: true,
      start_build_max: 1,
      jitter_retry_max: 1,
      log_analysis: { verdict: 'test_assertion', root_cause_verified: true, failure_cause: 'deterministic' },
    });
    expect(result.phase).toBe('test_failed');
    expect(result.needs_maintainer).toBe(false);
    expect(result.maintainer_hint).toBe('');
    expect(result.summary).not.toContain('联系门禁维护人员');
  });

  test('编译失败 + 日志确认编译错误：不进抖动重试，直接编译修复', () => {
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查成功', '编译失败'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'dev', body: 'start build', created_at: '2026-09-09T09:58:00Z' },
        { author: 'openharmony_ci', body: '门禁构建开始,预计60分钟', created_at: '2026-09-09T09:59:00Z' },
        { author: 'openharmony_ci', body: '代码门禁未通过 failed(compile failed)', created_at: '2026-09-09T11:13:00Z' },
      ],
      state: 'open',
      own_pr: true,
      log_analysis: { verdict: 'compile_error', root_cause_verified: true, failure_cause: 'deterministic' },
    });
    expect(result.phase).toBe('compile_failed');
    expect(result.root_cause_verified).toBe(true);
  });

  test('不传 log_analysis 时行为不变（向后兼容）', () => {
    const result = classifyOhosPrGates({
      labels: flakyLabels,
      comments: flakyComments,
      state: 'open',
      own_pr: true,
    });
    expect(result.phase).toBe('need_start_build');
    expect(result.log_verdict).toBe(null);
    expect(result.root_cause_verified).toBe(false);
    expect(result.summary).not.toContain('日志核对');
  });

  test('describeGateLogVerdict 对每种结论都给出可读说明', () => {
    for (const verdict of ['compile_error', 'build_script_failure', 'infra_failure', 'harness_env_failure', 'test_assertion', 'test_hang', 'test_stage_unverified', 'unknown']) {
      expect(describeGateLogVerdict({ verdict }).length).toBeGreaterThan(0);
    }
    expect(describeGateLogVerdict(null)).toBe('');
  });
});
