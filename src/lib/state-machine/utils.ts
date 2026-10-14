/**
 * Pure utility functions extracted from state-machine-workflow-manager for testability.
 * These functions have no side effects and no heavy dependencies.
 */

import { extractLooseStructuredResult } from '@/lib/ai/result-channel';
import type { WorkflowStep } from '@/lib/core/schemas';

export function stripNonAiStreamArtifacts(text: string): string {
  return text
    .replace(/\n?\s*<!-- chunk-boundary -->\s*\n?/g, '\n')
    .replace(/\n?\s*<!-- human-feedback:[\s\S]*?-->\s*\n?/g, '\n')
    .trim();
}

export function stripAceProcessEnvelopes(text: string): string {
  return String(text || '').replace(/<ace-process\b[\s\S]*?<\/ace-process>/gi, '\n');
}

export function extractTaggedBlock(text: string, tag: string): string | null {
  const blocks = extractTaggedBlocks(text, tag);
  return blocks[0] || null;
}

export function extractTaggedBlocks(text: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'gi');
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[1]?.trim();
    if (value) blocks.push(value);
  }
  return blocks;
}

/**
 * Pair from the last opening tag that still has a close after it.
 * An earlier unmatched `<step-conclusion>` (skill docs / tool dumps) must not
 * swallow the agent's real closing tag.
 */
export function extractLastTaggedBlock(text: string, tag: string): string | null {
  const source = String(text || '');
  if (!source) return null;
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  const lower = source.toLowerCase();
  const openNeedle = openTag.toLowerCase();
  const closeNeedle = closeTag.toLowerCase();
  const opens: number[] = [];
  let from = 0;
  while (from < lower.length) {
    const idx = lower.indexOf(openNeedle, from);
    if (idx < 0) break;
    opens.push(idx);
    from = idx + openNeedle.length;
  }
  for (let i = opens.length - 1; i >= 0; i -= 1) {
    const contentStart = opens[i] + openTag.length;
    const closeIdx = lower.indexOf(closeNeedle, contentStart);
    if (closeIdx < 0) continue;
    const value = source.slice(contentStart, closeIdx).trim();
    if (value) return value;
  }
  return null;
}

export function stripJsonFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export function compactStepConclusion(raw: string): string {
  const text = String(raw || '');
  const stripped = stripAceProcessEnvelopes(text);
  const tagged =
    extractLastTaggedBlock(stripped, 'step-conclusion')
    || extractLastTaggedBlock(text, 'step-conclusion');
  if (tagged) return tagged;

  const tailSource = stripNonAiStreamArtifacts(stripped || text).trim();
  const lines = tailSource.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const tail = lines.slice(-30).join('\n').trim();
  return tail.length > 4000 ? tail.slice(-4000).trim() : tail;
}

export type WorkflowVerdict = 'pass' | 'conditional_pass' | 'fail';

const CONCLUSION_VERDICT_PATTERN =
  /(?:verdict|裁定|裁决|结果|结论|判断)\s*(?:为|是|:|：|=)?\s*["'`*]*(conditional_pass|fail|pass|有条件通过|失败|不通过|通过|成功)/i;

function findBalancedJsonObjectBounds(text: string): { start: number; end: number } | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return { start, end: index + 1 };
      }
    }
  }

  return null;
}

function looksLikeToolEnvelope(json: string): boolean {
  const head = json.slice(0, 280);
  return /"toolName"\s*:/.test(head)
    || /"kind"\s*:\s*"(?:tool-call|tool-result)"/.test(head);
}

function normalizeVerdictToken(raw: unknown): WorkflowVerdict | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'fail' || value === '失败' || value === '不通过') return 'fail';
  if (value === 'conditional_pass' || value === '有条件通过') return 'conditional_pass';
  if (value === 'pass' || value === '通过' || value === '成功') return 'pass';
  return null;
}

export function parseVerdictFromConclusion(conclusion: string): WorkflowVerdict | null {
  const text = conclusion.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const fromJson = parseVerdictFromJsonSlice(text) || parseVerdictFromJsonSlice(conclusion);
  if (fromJson) return fromJson;
  const match = text.match(CONCLUSION_VERDICT_PATTERN);
  return match ? normalizeVerdictToken(match[1]) : null;
}

function parseVerdictFromJsonSlice(text: string): WorkflowVerdict | null {
  const bounds = findBalancedJsonObjectBounds(text);
  if (!bounds) return null;
  try {
    const parsed = JSON.parse(text.slice(bounds.start, bounds.end));
    return normalizeVerdictToken(parsed?.verdict);
  } catch {
    return null;
  }
}

function collectStructuredVerdictHits(output: string): Array<{ verdict: WorkflowVerdict; index: number; source: 'json' | 'conclusion' }> {
  const hits: Array<{ verdict: WorkflowVerdict; index: number; source: 'json' | 'conclusion' }> = [];
  let from = 0;
  while (from < output.length) {
    const start = output.indexOf('{', from);
    if (start < 0) break;
    const bounds = findBalancedJsonObjectBounds(output.slice(start));
    if (!bounds) {
      from = start + 1;
      continue;
    }
    const json = output.slice(start, start + bounds.end);
    if (!looksLikeToolEnvelope(json)) {
      try {
        const parsed = JSON.parse(json);
        const verdict = normalizeVerdictToken(parsed?.verdict);
        if (verdict) hits.push({ verdict, index: start, source: 'json' });
      } catch {
        // ignore non-JSON braces in prose/code
      }
    }
    from = start + bounds.end;
  }

  const conclusionSource = stripAceProcessEnvelopes(output);
  const lastConclusion =
    extractLastTaggedBlock(conclusionSource, 'step-conclusion')
    || extractLastTaggedBlock(output, 'step-conclusion');
  if (lastConclusion) {
    const verdict = parseVerdictFromConclusion(lastConclusion);
    if (verdict) {
      hits.push({
        verdict,
        index: Math.max(output.toLowerCase().lastIndexOf('<step-conclusion>'), 0),
        source: 'conclusion',
      });
    }
  }

  hits.sort((left, right) => left.index - right.index);
  return hits;
}

export function extractLastWorkflowVerdictJson(output: string): { verdict: WorkflowVerdict } | null {
  const hits = collectStructuredVerdictHits(output).filter((hit) => hit.source === 'json');
  if (hits.length === 0) return null;
  return { verdict: hits[hits.length - 1].verdict };
}

export function parseWorkflowVerdict(output: string): WorkflowVerdict {
  if (!output || !output.trim()) return 'fail';

  const hits = collectStructuredVerdictHits(output);
  if (hits.length > 0) {
    return hits[hits.length - 1].verdict;
  }

  return keywordFallbackVerdict(output);
}

export type FixVerificationContext = {
  stateName?: string;
  stepId?: string;
  stepName?: string;
  /** 清单未对上 repo 分支时，即使 Agent 写 engine_aligned=true 也不能 pass */
  sdkMatched?: boolean;
};

const FIX_VERIFY_STATE = /修复验证/;
const FIX_VERIFY_STEP = /verify-fix|修复方案对抗验证/;
const REVISED_GOLDEN_FLAG =
  /修订后?黄金标志|黄金标志必须修订|按修订后.{0,20}黄金标志|原黄金标志[\s\S]{0,80}不可达/;

export function isFixVerificationStep(context?: FixVerificationContext): boolean {
  if (!context) return false;
  return FIX_VERIFY_STATE.test(context.stateName || '')
    || FIX_VERIFY_STEP.test(context.stepId || '')
    || FIX_VERIFY_STEP.test(context.stepName || '');
}

export function extractIssueGoldenFlagMet(output: string): boolean | null {
  let found: boolean | null = null;
  walkNonToolJsonObjects(output, (parsed) => {
    const nested = parsed?.run_verification?.issue_golden_flag_met;
    const top = parsed?.issue_golden_flag_met;
    if (typeof nested === 'boolean') found = nested;
    if (typeof top === 'boolean') found = top;
  });
  if (found !== null) return found;
  // JSON 缺字段时的散文兜底：step-conclusion 常把结论写成
  // 「issue_golden_flag_met=true」等号形式。取**最后一次**匹配——
  // prompt/规则回显在前、最终结论在后（#2646 教训：验证明明通过，
  // 仅因未输出 JSON 块被门禁降级为 conditional_pass）。
  const matches = [...String(output || '').matchAll(/issue_golden_flag_met\**\s*[=:：]\s*\**\s*(true|false)\b/gi)];
  return matches.length ? matches[matches.length - 1][1].toLowerCase() === 'true' : null;
}

export function extractEngineAligned(output: string): boolean | null {
  let found: boolean | null = null;
  walkNonToolJsonObjects(output, (parsed) => {
    const nested = parsed?.run_verification?.engine_aligned;
    const top = parsed?.engine_aligned;
    if (typeof nested === 'boolean') found = nested;
    if (typeof top === 'boolean') found = top;
  });
  if (found !== null) return found;
  // 同上：散文兜底，取最后一次匹配（engine_aligned=true）
  const matches = [...String(output || '').matchAll(/engine[_\s]*aligned\**\s*[=:：]\s*\**\s*(true|false)\b/gi)];
  return matches.length ? matches[matches.length - 1][1].toLowerCase() === 'true' : null;
}

/**
 * 修复验证写 pass 时：Issue 黄金标志必须仍成立，且编 hap/真机引擎与 repo 同套。
 * 改口径、缺字段或引擎未对齐，一律降为 conditional_pass。
 */
export function enforceFixVerificationGoldenFlag(
  output: string,
  verdict: WorkflowVerdict,
  context?: FixVerificationContext,
): WorkflowVerdict {
  if (!isFixVerificationStep(context)) return verdict;
  if (extractLooseStructuredResult(output).conflicts?.length) return 'fail';
  if (verdict !== 'pass') return verdict;
  if (REVISED_GOLDEN_FLAG.test(String(output || ''))) return 'conditional_pass';
  if (extractIssueGoldenFlagMet(output) !== true) return 'conditional_pass';
  if (context?.sdkMatched === false) return 'conditional_pass';
  if (extractEngineAligned(output) !== true) return 'conditional_pass';
  return 'pass';
}

function keywordFallbackVerdict(output: string): WorkflowVerdict {
  const cleaned = output
    .replace(/故不\s*fail/gi, ' ')
    .replace(/不(?:要|得|能|应|该)?\s*fail/gi, ' ')
    .replace(/未(?:达|到)?\s*fail/gi, ' ')
    .replace(/非\s*fail/gi, ' ')
    .replace(/\bnot\s+(?:a\s+)?fail(?:ure)?\b/gi, ' ');
  if (/\b(fail|失败|不通过)\b/i.test(cleaned)) return 'fail';
  if (/\b(pass|通过|成功)\b/i.test(cleaned)) return 'pass';
  return 'conditional_pass';
}

function walkNonToolJsonObjects(output: string, onParsed: (parsed: any) => void): void {
  if (!output?.trim()) return;
  let from = 0;
  while (from < output.length) {
    const start = output.indexOf('{', from);
    if (start < 0) break;
    const bounds = findBalancedJsonObjectBounds(output.slice(start));
    if (!bounds) {
      from = start + 1;
      continue;
    }
    const json = output.slice(start, start + bounds.end);
    if (!looksLikeToolEnvelope(json)) {
      try {
        onParsed(JSON.parse(json));
      } catch {
        // ignore non-JSON braces in prose/code
      }
    }
    from = start + bounds.end;
  }
}

export function extractLastNonToolJson(output: string): any | null {
  let chosen: any = null;
  walkNonToolJsonObjects(output, (parsed) => {
    chosen = parsed;
  });
  return chosen;
}

export function extractLastNextState(output: string, validStates?: Iterable<string>): string | null {
  if (!output?.trim()) return null;
  const allowed = validStates ? new Set([...validStates].filter(Boolean)) : null;
  let chosen: string | null = null;
  walkNonToolJsonObjects(output, (parsed) => {
    const nextState = typeof parsed?.next_state === 'string' ? parsed.next_state.trim() : '';
    if (nextState && (!allowed || allowed.has(nextState))) {
      chosen = nextState;
    }
  });
  return chosen;
}

export function extractLastIssuesArray(output: string): any[] {
  let issues: any[] = [];
  walkNonToolJsonObjects(output, (parsed) => {
    if (Array.isArray(parsed?.issues)) {
      issues = parsed.issues;
    }
  });
  return issues;
}

export type CircuitBreakerTransition = {
  to: string;
  condition?: { verdict?: string };
};

export function pickCircuitBreakerEscape(
  transitions: CircuitBreakerTransition[],
  currentState: string,
  verdict?: string | null,
): CircuitBreakerTransition | undefined {
  const exits = transitions.filter((item) => item.to && item.to !== currentState);
  if (exits.length === 0) return undefined;

  // Explicit self-loop exhausted (根因分析 cpass → 根因分析): leave via fail,
  // never the first YAML pass edge nor a same-verdict non-self exit
  // (e.g. cpass → 问题复现), which is a deliberate reroute, not a breaker escape.
  const explicitSelfLoop = verdict
    ? transitions.some((item) => item.condition?.verdict === verdict && item.to === currentState)
    : false;
  if (explicitSelfLoop) {
    const failExit = exits.find((item) => item.condition?.verdict === 'fail');
    if (failExit) return failExit;
    const nonPass = exits.find((item) => item.condition?.verdict && item.condition.verdict !== 'pass');
    if (nonPass) return nonPass;
  }

  if (verdict) {
    const matching = exits.find((item) => item.condition?.verdict === verdict);
    if (matching) return matching;
  }

  return exits[0];
}

export function applySupervisorTransitionVeto(input: {
  engineVerdict: WorkflowVerdict;
  proposedNextState: string;
  currentState: string;
  supervisorNextState?: string | null;
  supervisorVerdict?: WorkflowVerdict | null;
  transitions: CircuitBreakerTransition[];
}): string {
  const proposed = input.proposedNextState;
  const supervisorNext = input.supervisorNextState?.trim();
  if (!supervisorNext || supervisorNext === proposed) return proposed;

  const allowed = input.transitions.some((item) => item.to === supervisorNext);
  if (!allowed && supervisorNext !== input.currentState) return proposed;

  if (input.engineVerdict === 'conditional_pass') {
    const failTargets = input.transitions
      .filter((item) => item.condition?.verdict === 'fail')
      .map((item) => item.to);
    if (failTargets.includes(supervisorNext) && supervisorNext !== input.currentState) {
      return proposed;
    }
    if (supervisorNext === input.currentState) return supervisorNext;
  }

  if (
    input.engineVerdict === 'fail'
    && input.supervisorVerdict === 'conditional_pass'
    && supervisorNext === input.currentState
  ) {
    return supervisorNext;
  }

  return proposed;
}

export function modelHasNativeVision(model?: string | null): boolean | 'unknown' {
  const id = String(model || '').toLowerCase();
  if (!id.trim()) return 'unknown';
  if (/(glm-5(\.\d+)?\b|glm5\b)/.test(id) && !/vl|vision/.test(id)) return false;
  if (/(grok|gpt-4o|gpt-5|gpt-4\.1|claude|gemini|qwen3\.7|qwen.*vl)/.test(id)) return true;
  return 'unknown';
}

export function buildVisionCapabilityPrompt(model?: string | null): string {
  const capability = modelHasNativeVision(model);
  const modelLabel = String(model || '').trim() || 'unknown';
  if (capability === true) {
    return [
      `# 看图策略`,
      `当前模型: ${modelLabel}`,
      `本模型可以直接看图。截图请先用 Read 打开原图自己看，根据像素作答。`,
      `只有 Read 看不到图、或看不清像素时，才调用 look_at_image（Qwen 子模型）。不要一上来就调 Qwen。`,
    ].join('\n');
  }
  if (capability === false) {
    return [
      `# 看图策略`,
      `当前模型: ${modelLabel}`,
      `本模型不能看像素。只要结论依赖截图长什么样，就必须调用 look_at_image（Qwen），禁止只靠正文猜图。`,
    ].join('\n');
  }
  return [
    `# 看图策略`,
    `当前模型: ${modelLabel}`,
    `先用 Read 打开截图。如果能看到像素并描述细节，就自己看，不要调用 look_at_image。`,
    `如果看不到图（空白、报错、明确说无法查看图片），再调用 look_at_image（Qwen）。`,
  ].join('\n');
}

export type StepSegment =
  | { type: 'serial'; step: WorkflowStep }
  | { type: 'parallel'; groupId: string; steps: WorkflowStep[] };

function getStepConcurrencyGroup(step: WorkflowStep): string | undefined {
  return (step as any).concurrency?.groupId || (step as any).parallelGroup || undefined;
}

export function groupStateStepsIntoSegments(steps: WorkflowStep[]): StepSegment[] {
  const segments: StepSegment[] = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    const groupId = getStepConcurrencyGroup(step);
    if (!groupId) {
      segments.push({ type: 'serial', step });
      i += 1;
      continue;
    }

    const groupSteps: WorkflowStep[] = [step];
    let j = i + 1;
    while (j < steps.length && getStepConcurrencyGroup(steps[j]) === groupId) {
      groupSteps.push(steps[j]);
      j += 1;
    }

    if (groupSteps.length > 1) {
      segments.push({ type: 'parallel', groupId, steps: groupSteps });
    } else {
      segments.push({ type: 'serial', step });
    }
    i = j;
  }
  return segments;
}

function isStepToolFailure(message: string): boolean {
  return /(?:ENOENT|ENOTDIR|EISDIR|EACCES|EPERM):/i.test(message)
    || /no such file or directory/i.test(message)
    || /file not found/i.test(message)
    || /cannot find path/i.test(message)
    || /找不到文件|文件不存在|路径不存在|没有那个文件或目录/.test(message)
    || /permission denied/i.test(message);
}

/** HTTP 401/403 must have protocol or status context. Bare "401" matches source line numbers like "401: }". */
function hasHttpAuthStatus(message: string): boolean {
  return /\bHTTP(?:\/[\d.]+)?\s*(?:401|403)\b/i.test(message)
    || /\b(?:status(?:\s*code)?|状态码)\s*[:：]?\s*(?:401|403)\b/i.test(message)
    || /\b(?:401|403)\s+(?:Unauthorized|Forbidden|Unauthenticated)\b/i.test(message);
}

export function isEngineLevelFailure(message: string): boolean {
  const raw = String(message || '');
  if (!raw.trim()) return false;
  if (/引擎连续失败|自动恢复\s*\d+\s*次后仍失败/.test(raw)) return true;

  // Agent 工具流 <ace-process> 里常有 GitCode 401 / skill 正文，不能当成引擎挂了。
  const normalized = stripAceProcessEnvelopes(raw).trim();
  if (!normalized) return false;
  if (isStepToolFailure(normalized)) return false;

  return /acp\s+connection\s+closed/i.test(normalized)
    || /apierror/i.test(normalized)
    || /模型调用失败(?:\s*\(\s*\d{3}\s*\))?\s*:/i.test(normalized)
    || /(?:unauthorized|invalid token|invalid api key|authentication failed|permission denied)/i.test(normalized)
    || /(?:无效的令牌|令牌无效|认证失败|鉴权失败|API\s*Key\s*无效)/i.test(normalized)
    || hasHttpAuthStatus(normalized)
    || /context window limit/i.test(normalized)
    || /reached (its |the )?context window limit/i.test(normalized)
    || /maximum context length/i.test(normalized)
    || /prompt is too long/i.test(normalized)
    || /SDK API retry limit/i.test(normalized)
    || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE/i.test(normalized)
    || /engine (?:not initialized|unavailable|connection .*failed|process .*failed|session .*failed)/i.test(normalized)
    || /failed to create .*process streams/i.test(normalized)
    || /引擎(?:未初始化|初始化失败|不可用|连接.*失败|连接.*断开|连续失败)/.test(normalized)
    || /ACP session\/load timeout/i.test(normalized)
    || /ACP newSession timeout/i.test(normalized)
    || /Model\s+"[^"]+"\s+not found/i.test(normalized)
    || /模型不可用/.test(normalized);
}

export function shouldFinalizeDiagnosisAsCompleted(input: {
  hasFixVerificationState: boolean;
  lastFixVerificationVerdict: WorkflowVerdict | null;
  finalStateName?: string | null;
  /** 修复验证状态是否真正执行过（false = 走的是设计内兜底/建议出口，未进入修复环节） */
  fixVerificationReached?: boolean;
  /** F04：conditional_pass 的具体原因（如"无 OHOS 设备"），来自验证步骤输出的结构化/散文记录 */
  conditionalReason?: string | null;
  /** R06：归档完整度。failed 时 run 不得呈现为"全部成功"（可只重试归档） */
  diagnosisArtifactStatus?: 'complete' | 'partial' | 'failed' | null;
  diagnosisVerificationStatus?: string | null;
}): { complete: boolean; reason: string } {
  // R06：归档失败独立于验证裁决——即使验证 pass，归档失败也不能呈现为全部成功
  if (input.diagnosisVerificationStatus === 'evidence_conflict') return { complete: false, reason: '验证结论存在冲突，需要核对原始证据后重新验证' };
  if (input.diagnosisArtifactStatus === 'partial') return { complete: false, reason: '必需诊断产物归档不完整，补齐证据后才能完成' };
  if (input.diagnosisArtifactStatus === 'failed') {
    return { complete: false, reason: '诊断产物归档失败（artifact_status=failed），可只重试归档，不得呈现为全部成功' };
  }
  if (!input.hasFixVerificationState) return { complete: true, reason: '' };
  if (input.fixVerificationReached !== false && input.diagnosisVerificationStatus
    && input.diagnosisVerificationStatus !== 'verified') return { complete: false, reason: `验证证据尚未完整闭环（${input.diagnosisVerificationStatus}），不能标完成` };
  if (input.finalStateName && input.finalStateName !== '完成') {
    return { complete: true, reason: '' };
  }
  if (input.lastFixVerificationVerdict === 'pass') return { complete: true, reason: '' };
  if (input.lastFixVerificationVerdict == null) {
    if (input.fixVerificationReached === false) {
      return {
        complete: true,
        reason: '修复验证未执行（设计内兜底/建议出口，如根因 fail 或应用层问题分流），按 completed 收尾',
      };
    }
    return {
      complete: false,
      reason: '诊断工作流未完成修复验证（需要 issue_golden_flag_met=true 且 engine_aligned=true），不得标 completed',
    };
  }
  // F04：把"验证受限（缺设备/缺环境）"与"验证失败"区分开，不再笼统归为未过黄金标志
  if (input.lastFixVerificationVerdict === 'conditional_pass') {
    const detail = input.conditionalReason?.trim();
    return {
      complete: false,
      reason: `修复验证未完全通过（conditional_pass）${detail ? `：${detail}` : '，验证步骤未记录具体原因'}。按规则保持未完成，补齐验证条件后可恢复`,
    };
  }
  return {
    complete: false,
    reason: `修复验证未过黄金标志/引擎对齐（verdict=${input.lastFixVerificationVerdict}），不得标 completed`,
  };
}

// ============ 基于输出字段的转移条件匹配 ============

export type TransitionFieldCondition = {
  fieldEquals?: Record<string, string | number | boolean>;
  fieldNotEquals?: Record<string, string | number | boolean>;
  fieldMatch?: Record<string, string>;
  fieldAbsent?: string[];
  outputMatch?: string;
};

function descendJsonPath(parsed: any, candidates: string[]): { found: boolean; value: unknown } {
  for (const candidate of candidates) {
    let current: any = parsed;
    let resolved = true;
    for (const segment of candidate.split('.').map((part) => part.trim()).filter(Boolean)) {
      if (current == null || typeof current !== 'object' || !(segment in current)) {
        resolved = false;
        break;
      }
      current = current[segment];
    }
    if (resolved) return { found: true, value: current };
  }
  return { found: false, value: undefined };
}

/**
 * 从状态的步骤输出中解析字段路径。
 * 键格式："feedback_to_target" / "run_verification.engine_aligned" / "a|b"（候选路径，取第一个存在的）。
 * 跨多个非工具 JSON 按出现顺序解析，最后一次解析结果生效（与 verdict 提取口径一致）。
 */
export function resolveOutputField(outputs: string[], path: string): { found: boolean; value: unknown } {
  const candidates = String(path || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  if (candidates.length === 0) return { found: false, value: undefined };

  let result: { found: boolean; value: unknown } = { found: false, value: undefined };
  const joined = (outputs || []).join('\n');
  walkNonToolJsonObjects(joined, (parsed) => {
    const resolution = descendJsonPath(parsed, candidates);
    if (resolution.found) result = resolution;
  });
  return result;
}

function stringifyConditionValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value);
}

function valuesEqual(actual: unknown, expected: string | number | boolean): boolean {
  if (actual == null) return false;
  return stringifyConditionValue(actual) === stringifyConditionValue(expected);
}

function safeTestRegex(pattern: string, subject: string): boolean | null {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return null; // 无效正则视为条件失败，不拖垮工作流
  }
  return regex.test(subject);
}

/**
 * 评估转移条件中的字段/全文匹配部分。
 * - fieldEquals：所有键必须解析成功且相等
 * - fieldNotEquals：所有键均不得等于给定值（字段缺失视为不相等，条件通过）
 * - fieldMatch：所有键必须存在且匹配正则（不回退到全文）
 * - fieldAbsent：所有键都必须未解析到（结构化字段缺失时才允许全文散文匹配）
 * - outputMatch：正则必须匹配状态完整原始输出
 */
export function matchTransitionFieldConditions(
  outputs: string[],
  condition: TransitionFieldCondition,
): boolean {
  const fieldEquals = condition.fieldEquals || {};
  for (const [path, expected] of Object.entries(fieldEquals)) {
    const resolution = resolveOutputField(outputs, path);
    if (!resolution.found || !valuesEqual(resolution.value, expected)) return false;
  }

  const fieldNotEquals = condition.fieldNotEquals || {};
  for (const [path, expected] of Object.entries(fieldNotEquals)) {
    const resolution = resolveOutputField(outputs, path);
    if (resolution.found && valuesEqual(resolution.value, expected)) return false;
  }

  const fieldMatch = condition.fieldMatch || {};
  for (const [path, pattern] of Object.entries(fieldMatch)) {
    const resolution = resolveOutputField(outputs, path);
    if (!resolution.found) return false;
    const matched = safeTestRegex(pattern, stringifyConditionValue(resolution.value));
    if (matched !== true) return false;
  }

  for (const path of condition.fieldAbsent || []) {
    if (resolveOutputField(outputs, path).found) return false;
  }

  if (condition.outputMatch) {
    const matched = safeTestRegex(condition.outputMatch, (outputs || []).join('\n'));
    if (matched !== true) return false;
  }

  return true;
}

export function hasTransitionFieldCondition(condition?: TransitionFieldCondition | null): boolean {
  if (!condition) return false;
  return Boolean(
    condition.fieldEquals
    || condition.fieldNotEquals
    || condition.fieldMatch
    || condition.fieldAbsent?.length
    || condition.outputMatch,
  );
}

/** 供提示词展示用：把字段条件压缩成一行可读文本 */
export function describeTransitionFieldCondition(condition?: TransitionFieldCondition | null): string {
  if (!condition) return '';
  const parts: string[] = [];
  for (const [path, expected] of Object.entries(condition.fieldEquals || {})) {
    parts.push(`${path}=${expected}`);
  }
  for (const [path, expected] of Object.entries(condition.fieldNotEquals || {})) {
    parts.push(`${path}!=${expected}`);
  }
  for (const [path, pattern] of Object.entries(condition.fieldMatch || {})) {
    parts.push(`${path}~/${pattern}/`);
  }
  for (const path of condition.fieldAbsent || []) {
    parts.push(`!${path}`);
  }
  if (condition.outputMatch) parts.push(`output~/${condition.outputMatch}/`);
  return parts.join(', ');
}
