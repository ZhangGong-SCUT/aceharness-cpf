/**
 * gate-summary.ts — PR 自修邮件的门禁结果摘要
 *
 * 从 run 目录读取 outputs/gate-check.json（check-pr-gates.mjs 的结构化产物），
 * 生成邮件正文的三个关键段落：
 *   1. 门禁有没有过：五环节清单（DCO / 静态 / 编译 / 冒烟 / AI 检视）
 *   2. 失败了问题在哪：超时（DCP 平台抖动）还是具体报错 + 失败环节明细 + 报告链接
 *   3. 过了还差什么：人工审批 + 评论 submit
 *
 * 读不到 gate-check.json 时返回 null（发信方退回简洁文案，不影响投递）。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { getWorkspaceRunsDir } from '@/lib/core/app-paths';

export interface GateFailureItem {
  /** 失败环节（设备/任务名，如 flutter_3.35.7-test_flutter、codeCheck） */
  stage: string;
  /** 失败原因原文（如 compile failed、ecotest timeout） */
  cause: string;
}

export interface GateSummary {
  phase: string;
  /** PR 已合入（监控的成功终点，邮件不应出现"失败"字样） */
  merged: boolean;
  /** PR 已关闭（未合入） */
  closed: boolean;
  dcoOk: boolean;
  dcoFail: boolean;
  staticOk: boolean;
  staticFail: boolean;
  compileOk: boolean;
  compileFail: boolean;
  testOk: boolean;
  testFail: boolean;
  testFlaky: boolean;
  /** 最新 CI 门禁评论（已转纯文本） */
  ciComment: string;
  reportUrl: string;
  startBuildCount: number;
  startBuildMax: number;
}

/** HTML 富文本 → 纯文本（CI 评论是 <table>/<br> 富文本） */
export function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(tr|p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

/** 从 CI 评论纯文本中提取失败明细（环节 + 原因），按出现顺序去重，最多 4 条 */
export function extractFailureItems(ciText: string): GateFailureItem[] {
  const text = stripHtml(ciText);
  const items: GateFailureItem[] = [];
  const seen = new Set<string>();
  const push = (stage: string, cause: string) => {
    const key = `${stage}|${cause}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ stage: stage || '(未知环节)', cause });
  };
  /** 向前扫描"环节名"：含字母+连字符/下划线、非链接、非 NA/箭头 */
  const findStage = (tokens: string[]): string => {
    for (let j = tokens.length - 1; j >= 0 && tokens.length - 1 - j <= 5; j--) {
      const t = tokens[j];
      if (/^[A-Za-z][\w.-]*[_-][\w.-]*$/.test(t) && !/^https?/.test(t) && !/^(NA|-|>>>)$/i.test(t)) {
        return t;
      }
    }
    return '';
  };

  for (const line of text.split('\n')) {
    if (!/failed/i.test(line)) continue;
    // 优先匹配带原因的形式：failed(...) / failed(IGNORE)(...)（原因可含空格，如 compile failed、ecotest timeout）
    const re = /failed(?:\(IGNORE\))?\(([^)]+)\)/gi;
    let matched = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      matched = true;
      const before = line.slice(0, m.index).trim().split(/\s+/).filter(Boolean);
      push(findStage(before), m[1].trim());
      if (items.length >= 4) return items;
    }
    // 兜底：行内有裸 failed（无括号原因）
    if (!matched) {
      const tokens = line.trim().split(/\s+/);
      for (let i = 0; i < tokens.length; i++) {
        if (!/^failed:?$/i.test(tokens[i])) continue;
        push(findStage(tokens.slice(0, i)), 'failed（未给出原因）');
        break;
      }
    }
  }
  return items;
}

/**
 * 失败分类：全部为超时 → 平台抖动（重试大概率通过）；否则按首个具体原因归类。
 */
export function classifyFailure(items: GateFailureItem[]): { kind: 'timeout' | 'compile' | 'error' | 'none'; label: string } {
  if (!items.length) return { kind: 'none', label: '' };
  const causes = items.map((i) => i.cause.toLowerCase());
  if (causes.every((c) => /timeout|timed?\s*out|ecotest/.test(c))) {
    return { kind: 'timeout', label: '超时（DCP 平台抖动，非代码问题，重试大概率通过）' };
  }
  if (causes.some((c) => /compile/.test(c))) {
    return { kind: 'compile', label: '编译失败' };
  }
  return { kind: 'error', label: '具体报错' };
}

/** 读取 run 的门禁检查结果（结构化），失败返回 null */
export function loadGateSummary(runId: string): GateSummary | null {
  try {
    const raw = readFileSync(join(getWorkspaceRunsDir(), runId, 'outputs', 'gate-check.json'), 'utf8');
    const g = JSON.parse(raw);
    if (!g || typeof g !== 'object') return null;
    return {
      phase: String(g.phase || ''),
      merged: !!g.merged,
      closed: !!g.closed,
      dcoOk: !!g.dco_ok,
      dcoFail: !!g.dco_fail,
      staticOk: !!g.static_ok,
      staticFail: !!g.static_fail,
      compileOk: !!g.compile_ok,
      compileFail: !!g.compile_fail,
      testOk: !!g.test_ok,
      testFail: !!g.test_fail,
      testFlaky: !!g.test_flaky,
      ciComment: stripHtml(String(g.latest_ci_comment || '')),
      reportUrl: String(g.report_url || ''),
      startBuildCount: Number(g.start_build_count || 0),
      startBuildMax: Number(g.start_build_max || 0),
    };
  } catch {
    return null;
  }
}

/** 门禁总体状态行（邮件标题下方的第一句结论）；合入/关闭优先于 phase 分类 */
export function gateStatusLine(gate: GateSummary): string {
  if (gate.merged) return '✅ PR 已合入（监控圆满结束）';
  if (gate.closed) return '⛔ PR 已关闭（未合入）';
  switch (gate.phase) {
    case 'green': return '✅ 门禁全绿';
    case 'compile_failed': return '❌ 编译失败';
    case 'static_failed': return '❌ 静态检查失败';
    case 'test_failed': return gate.testFlaky ? '❌ 冒烟测试失败（全部超时·平台抖动）' : '❌ 冒烟测试失败';
    case 'dco_failed': return '❌ DCO 签名缺失';
    case 'blocked_no_issue': return '⛔ 未关联 Issue（CI 拒绝构建）';
    case 'running': return '⏳ 门禁运行中';
    case 'need_start_build': return '🔁 等待触发构建';
    default: return gate.phase ? `⚠️ ${gate.phase}` : '⚠️ 状态未知';
  }
}

/** 五环节清单（✓ 通过 / ✗ 失败 / · 未出结果） */
export function gateChecklistLine(gate: GateSummary): string {
  const mark = (ok: boolean, fail: boolean, suffix = '') =>
    fail ? `✗${suffix}` : ok ? '✓' : '·';
  const smoke = gate.testFail
    ? (gate.testFlaky ? '✗（超时）' : '✗')
    : gate.testOk ? '✓' : '·';
  return `DCO ${mark(gate.dcoOk, gate.dcoFail)}   静态 ${mark(gate.staticOk, gate.staticFail)}   编译 ${mark(gate.compileOk, gate.compileFail)}   冒烟 ${smoke}`;
}

/** 失败明细行（供邮件"失败原因"段落；含分类结论 + 环节明细 + 报告链接） */
export function gateFailureLines(gate: GateSummary): string[] {
  const items = extractFailureItems(gate.ciComment);
  const cls = classifyFailure(items);
  const lines: string[] = [];
  if (gate.reportUrl) lines.push(`门禁报告: ${gate.reportUrl}`);
  if (cls.kind === 'none') {
    lines.push('失败明细: 见门禁报告（CI 评论未含可解析的失败原因）');
    return lines;
  }
  lines.push(`原因分类: ${cls.label}`);
  if (items.length) {
    lines.push('失败环节:');
    for (const it of items) lines.push(`  · ${it.stage}: ${it.cause}`);
  }
  return lines;
}

/** 预算提示行（超出时才返回，否则空串） */
export function gateBudgetLine(gate: GateSummary): string {
  if (gate.startBuildMax > 0 && gate.startBuildCount >= gate.startBuildMax) {
    return `start build 重试预算已用尽（${gate.startBuildCount}/${gate.startBuildMax}）`;
  }
  return '';
}

/** 按 phase 推导"下一步"建议（失败邮件的行动指引）；合入/关闭优先 */
export function gateNextStepLines(gate: GateSummary): string[] {
  if (gate.merged) {
    return ['PR 已成功合入，监控正常结束，无需任何操作。'];
  }
  if (gate.closed) {
    return ['PR 已关闭（未合入），监控结束。若在 GitCode 重新打开后可再开启监控。'];
  }
  const budget = gateBudgetLine(gate);
  switch (gate.phase) {
    case 'dco_failed':
      return [
        '按 PR 上「DCO 检查失败」评论的指引处理：在线签署 DCO 协议或给 commit 补 Signed-off-by，然后评论 check dco 复检。',
      ];
    case 'static_failed':
      return ['查看门禁报告的 codeCheck 明细，修复点名的文件后推送；工作流的修复结论见运行详情。'];
    case 'compile_failed':
      return budget
        ? [`${budget}。`, '编译失败若为环境问题（超时/工具链报错），重发 start build 大概率通过：到 GitCode PR 页评论 start build。']
        : ['查看门禁报告定位失败文件；工作流已完成日志分析并给出结论，见运行详情。'];
    case 'test_failed':
      return gate.testFlaky
        ? ['冒烟失败全部为 ecotest 超时（DCP 平台抖动，非代码问题）：到 GitCode PR 页评论 start build 重试。' + (budget ? `（${budget}）` : '')]
        : ['查看门禁报告中的失败用例明细；测试失败不做自动修复，需人工判断。'];
    case 'blocked_no_issue':
      return ['在 PR 描述中关联一个 Issue（如 Issue: #123），然后评论 start build 重新触发构建。'];
    default:
      return [];
  }
}

/** 工作台运行详情链接（公网入口） */
export function buildWorkbenchUrl(runId: string): string {
  const origin = process.env.ACE_PUBLIC_ORIGIN?.trim() || `http://127.0.0.1:${process.env.ACE_PORT || 3031}`;
  const route = `/workbench/gitcode-pr-review.yaml?mode=run&run=${runId}`;
  return `${origin}/dashboard?route=${encodeURIComponent(route)}`;
}
