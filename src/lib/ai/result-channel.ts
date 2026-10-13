import { jsonrepair } from 'jsonrepair';
import { getAceProcessRanges as getStructuredAceProcessRanges } from '@/lib/chat/ai-process-blocks';
import { findStepConclusionSpans } from '@/lib/run/output-compaction';

export interface ResultSection {
  start: number;
  end: number;
  content: string;
}

type JsonSchema = Record<string, any>;

const STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } };
const REVISION_PLAN_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      artifact: { type: 'string' },
      op: { type: 'string' },
      targetId: { type: 'string' },
      reason: { type: 'string' },
    },
  },
};
const SIMPLE_ITEM_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    data: { type: 'object' },
    payload: {
      type: 'object',
      properties: {
        data: { type: 'object' },
      },
      required: ['data'],
    },
  },
};

type AiJsonRepairLoads = (input: string, options?: Record<string, any>) => any;

const KNOWN_RESULT_SCHEMAS: Record<string, JsonSchema> = {
  home_sidebar: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      type: { type: 'string' },
      mode: { type: 'string' },
      tabs: STRING_ARRAY_SCHEMA,
      activeTab: { type: 'string' },
      intent: { type: 'string' },
      stage: { type: 'string' },
      reason: { type: 'string' },
      summary: { type: 'string' },
      knownFacts: STRING_ARRAY_SCHEMA,
      missingFields: STRING_ARRAY_SCHEMA,
      questions: STRING_ARRAY_SCHEMA,
      recommendedNextAction: { type: 'string' },
      shouldOpenModal: { type: 'boolean' },
      workflowDraft: { type: 'object' },
      agentDraft: { type: 'object' },
      payload: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
          tabs: STRING_ARRAY_SCHEMA,
          activeTab: { type: 'string' },
          intent: { type: 'string' },
          stage: { type: 'string' },
          reason: { type: 'string' },
          summary: { type: 'string' },
          knownFacts: STRING_ARRAY_SCHEMA,
          missingFields: STRING_ARRAY_SCHEMA,
          questions: STRING_ARRAY_SCHEMA,
          recommendedNextAction: { type: 'string' },
          shouldOpenModal: { type: 'boolean' },
          workflowDraft: { type: 'object' },
          agentDraft: { type: 'object' },
        },
      },
    },
  },
  card: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      payload: {
        type: 'object',
        properties: {
          header: { type: 'object' },
          blocks: { type: 'array', items: { type: 'object' } },
          actions: { type: 'array', items: { type: 'object' } },
        },
      },
      header: { type: 'object' },
      blocks: { type: 'array', items: { type: 'object' } },
      actions: { type: 'array', items: { type: 'object' } },
    },
  },
  clarification_form: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      type: { type: 'string' },
      payload: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          knownFacts: STRING_ARRAY_SCHEMA,
          missingFields: STRING_ARRAY_SCHEMA,
          questions: { type: 'array', items: { type: 'object' } },
        },
      },
      summary: { type: 'string' },
      knownFacts: STRING_ARRAY_SCHEMA,
      missingFields: STRING_ARRAY_SCHEMA,
      questions: { type: 'array', items: { type: 'object' } },
    },
  },
  plan_draft: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      type: { type: 'string' },
      payload: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          goals: STRING_ARRAY_SCHEMA,
          nonGoals: STRING_ARRAY_SCHEMA,
          constraints: STRING_ARRAY_SCHEMA,
          clarification: { type: 'object' },
          artifacts: { type: 'object' },
        },
      },
      summary: { type: 'string' },
      goals: STRING_ARRAY_SCHEMA,
      nonGoals: STRING_ARRAY_SCHEMA,
      constraints: STRING_ARRAY_SCHEMA,
      clarification: { type: 'object' },
      artifacts: { type: 'object' },
    },
  },
  workflow_draft: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      type: { type: 'string' },
      payload: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          summary: { type: 'string' },
          config: { type: 'object' },
        },
        required: ['config'],
      },
      filename: { type: 'string' },
      summary: { type: 'string' },
      config: { type: 'object' },
    },
  },
  workflow_patch: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      type: { type: 'string' },
      payload: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          summary: { type: 'string' },
          scope: { type: 'string' },
          workflowMode: { type: 'string' },
          patch: { type: 'object' },
        },
        required: ['scope', 'patch'],
      },
      filename: { type: 'string' },
      summary: { type: 'string' },
      scope: { type: 'string' },
      workflowMode: { type: 'string' },
      patch: { type: 'object' },
    },
  },
  workflow_clarification_summary: SIMPLE_ITEM_RESULT_SCHEMA,
  workflow_clarification_facts: SIMPLE_ITEM_RESULT_SCHEMA,
  workflow_clarification_gaps: SIMPLE_ITEM_RESULT_SCHEMA,
  workflow_clarification_question: SIMPLE_ITEM_RESULT_SCHEMA,
  spec_coding_meta: SIMPLE_ITEM_RESULT_SCHEMA,
  spec_requirement: SIMPLE_ITEM_RESULT_SCHEMA,
  spec_design: SIMPLE_ITEM_RESULT_SCHEMA,
  spec_decision: SIMPLE_ITEM_RESULT_SCHEMA,
  spec_task: SIMPLE_ITEM_RESULT_SCHEMA,
  workflow_state_outline: SIMPLE_ITEM_RESULT_SCHEMA,
  workflow_state_steps: SIMPLE_ITEM_RESULT_SCHEMA,
  workflow_patch_item: SIMPLE_ITEM_RESULT_SCHEMA,
  spec_revision_item: SIMPLE_ITEM_RESULT_SCHEMA,
  spec_artifact_revision: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      payload: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          revisionPlan: REVISION_PLAN_SCHEMA,
          artifacts: { type: 'object' },
        },
        required: ['artifacts'],
      },
      summary: { type: 'string' },
      revisionPlan: REVISION_PLAN_SCHEMA,
      artifacts: { type: 'object' },
    },
  },
  agent_clarification_summary: SIMPLE_ITEM_RESULT_SCHEMA,
  agent_clarification_facts: SIMPLE_ITEM_RESULT_SCHEMA,
  agent_clarification_gaps: SIMPLE_ITEM_RESULT_SCHEMA,
  agent_clarification_question: SIMPLE_ITEM_RESULT_SCHEMA,
  agent_role_profile: SIMPLE_ITEM_RESULT_SCHEMA,
  agent_execution_profile: SIMPLE_ITEM_RESULT_SCHEMA,
  agent_config: SIMPLE_ITEM_RESULT_SCHEMA,
  spec_coding_revision: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      type: { type: 'string' },
      payload: {
        type: 'object',
        properties: {
          apply: { type: 'boolean' },
          summary: { type: 'string' },
          affectedArtifacts: STRING_ARRAY_SCHEMA,
          impact: STRING_ARRAY_SCHEMA,
          revisionPlan: REVISION_PLAN_SCHEMA,
        },
      },
      apply: { type: 'boolean' },
      summary: { type: 'string' },
      affectedArtifacts: STRING_ARRAY_SCHEMA,
      impact: STRING_ARRAY_SCHEMA,
      revisionPlan: REVISION_PLAN_SCHEMA,
    },
  },
  'spec-coding-revision': {
    type: 'object',
    properties: {
      type: { type: 'string' },
      apply: { type: 'boolean' },
      summary: { type: 'string' },
      affectedArtifacts: STRING_ARRAY_SCHEMA,
      impact: STRING_ARRAY_SCHEMA,
      revisionPlan: REVISION_PLAN_SCHEMA,
    },
  },
};

function getFencedCodeBlockRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const openRegex = /^([ \t]{0,3})(`{3,}|~{3,})([^\r\n]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = openRegex.exec(markdown)) !== null) {
    const start = match.index;
    const marker = match[2];
    const markerChar = marker[0];
    const markerWidth = marker.length;
    const lineEnd = markdown.indexOf('\n', openRegex.lastIndex);
    const openingLineEnd = lineEnd === -1 ? markdown.length : lineEnd + 1;

    const closeRegex = new RegExp(`^[ \\t]{0,3}${markerChar}{${markerWidth},}[ \\t]*$`, 'gm');
    closeRegex.lastIndex = openingLineEnd;
    const close = closeRegex.exec(markdown);
    if (!close) {
      ranges.push([start, markdown.length]);
      openRegex.lastIndex = markdown.length;
      break;
    }

    const closeLineEnd = markdown.indexOf('\n', close.index + close[0].length);
    const end = closeLineEnd === -1 ? close.index + close[0].length : closeLineEnd + 1;
    ranges.push([start, end]);
    openRegex.lastIndex = end;
  }
  return ranges;
}

function getAceProcessRanges(markdown: string): Array<[number, number]> {
  return getStructuredAceProcessRanges(markdown);
}

/** HTML 注释区间：注释内的 <result>/<step-conclusion> 只是示例或旧存档，不是可信输出 */
function getHtmlCommentRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const commentRegex = /<!--[\s\S]*?-->/g;
  let match: RegExpExecArray | null;
  while ((match = commentRegex.exec(markdown)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/** Markdown 引用块（> …）区间：引述的他人/历史输出不属于本次裁决 */
function getBlockquoteRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const quoteRegex = /^[ \t]*>[^\r\n]*(?:\r?\n|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = quoteRegex.exec(markdown)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function isInsideRanges(index: number, ranges: Array<[number, number]>): boolean {  return ranges.some(([start, end]) => index >= start && index < end);
}

/** 把 fenced code、HTML 注释、引用块替换为空白：散文/内联提取只在可信正文上进行 */
function stripUntrustedRegions(markdown: string): string {
  const ranges = [
    ...getFencedCodeBlockRanges(markdown),
    ...getHtmlCommentRanges(markdown),
    ...getBlockquoteRanges(markdown),
  ];
  if (!ranges.length) return markdown;
  const chars = markdown.split('');
  for (const [start, end] of ranges) {
    for (let i = start; i < end && i < chars.length; i += 1) chars[i] = ' ';
  }
  return chars.join('');
}

export function getResultSections(markdown: string): ResultSection[] {
  const sections: ResultSection[] = [];
  const skipRanges = [
    ...getFencedCodeBlockRanges(markdown),
    ...getAceProcessRanges(markdown),
    ...getHtmlCommentRanges(markdown),
    ...getBlockquoteRanges(markdown),
  ];
  const resultRegex = /<result>([\s\S]*?)<\/result>/gi;
  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(markdown)) !== null) {
    if (isInsideRanges(match.index, skipRanges)) continue;
    sections.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[1],
    });
  }
  const resultOpenRegex = /<result>/gi;
  while ((match = resultOpenRegex.exec(markdown)) !== null) {
    if (isInsideRanges(match.index, skipRanges)) continue;
    if (sections.some((section) => match!.index >= section.start && match!.index < section.end)) continue;
    const contentStart = match.index + match[0].length;
    const bounds = findBalancedJsonObjectBounds(markdown.slice(contentStart));
    if (!bounds) continue;
    sections.push({
      start: match.index,
      end: contentStart + bounds.end,
      content: markdown.slice(contentStart + bounds.start, contentStart + bounds.end),
    });
  }
  sections.sort((left, right) => left.start - right.start);
  return sections;
}

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

function extractJsonFromCandidate(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  const fencedMatch = trimmed.match(/^```(?:json|card)\s*([\s\S]*?)```$/i);
  const body = fencedMatch ? fencedMatch[1].trim() : trimmed;
  const bounds = findBalancedJsonObjectBounds(body);
  if (!bounds) return null;
  return body.slice(bounds.start, bounds.end);
}

export function normalizeStructuredResultBlocks(markdown: string): string {
  const source = String(markdown || '');
  const sections = getResultSections(source);
  if (sections.length === 0) return source;

  let normalized = source;
  for (const section of [...sections].reverse()) {
    const bounds = findBalancedJsonObjectBounds(section.content);
    if (!bounds) continue;

    const prefix = section.content.slice(0, bounds.start);
    const suffix = section.content.slice(bounds.end);
    if (prefix.trim()) continue;
    if (!suffix.trim()) continue;

    const json = section.content.slice(bounds.start, bounds.end);
    const trailingNewline = /\r?\n/.test(prefix) || /\r?\n/.test(suffix) ? '\n' : '';
    const normalizedSection = `<result>${prefix}${json}${trailingNewline}</result>`;
    normalized = normalized.slice(0, section.start) + normalizedSection + normalized.slice(section.end);
  }

  return normalized;
}

function getAiJsonRepairLoads(): AiJsonRepairLoads | null {
  if (typeof window !== 'undefined') return null;
  try {
    const req = Function('return require')() as NodeRequire;
    const mod = req('ai-json-repair') as { loads?: AiJsonRepairLoads };
    return typeof mod.loads === 'function' ? mod.loads : null;
  } catch {
    return null;
  }
}

function lightweightRepairParse(json: string): any | null {
  try {
    return JSON.parse(jsonrepair(json));
  } catch {
    return null;
  }
}

function detectKnownResultSchemaKey(value: any): string | null {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.kind === 'string' && KNOWN_RESULT_SCHEMAS[value.kind]) {
    return value.kind;
  }
  if (typeof value.type === 'string' && KNOWN_RESULT_SCHEMAS[value.type]) {
    return value.type;
  }
  if (value.type === 'home_sidebar') return 'home_sidebar';
  return null;
}

function toStringArray(value: unknown): string[] | unknown {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return value;
}

function toBoolean(value: unknown): boolean | unknown {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'TRUE') return true;
  if (value === 'false' || value === 'FALSE') return false;
  return value;
}

function coerceKnownResultShape(parsed: any): any {
  const schemaKey = detectKnownResultSchemaKey(parsed);
  if (!schemaKey || !parsed || typeof parsed !== 'object') return parsed;

  const clone = JSON.parse(JSON.stringify(parsed));
  const target = clone.kind === schemaKey && clone.payload && typeof clone.payload === 'object'
    ? clone.payload
    : clone;

  if (schemaKey === 'home_sidebar') {
    target.tabs = toStringArray(target.tabs);
    target.knownFacts = toStringArray(target.knownFacts);
    target.missingFields = toStringArray(target.missingFields);
    target.questions = toStringArray(target.questions);
    target.shouldOpenModal = toBoolean(target.shouldOpenModal);
    return clone;
  }

  if (schemaKey === 'spec_coding_revision' || schemaKey === 'spec-coding-revision') {
    target.apply = toBoolean(target.apply);
    target.affectedArtifacts = toStringArray(target.affectedArtifacts);
    target.impact = toStringArray(target.impact);
    return clone;
  }

  if (schemaKey === 'plan_draft') {
    target.goals = toStringArray(target.goals);
    target.nonGoals = toStringArray(target.nonGoals);
    target.constraints = toStringArray(target.constraints);
    return clone;
  }

  if (schemaKey === 'clarification_form') {
    target.knownFacts = toStringArray(target.knownFacts);
    target.missingFields = toStringArray(target.missingFields);
    return clone;
  }

  return clone;
}

function repairWithKnownSchema(json: string, parsed: any): any {
  const schemaKey = detectKnownResultSchemaKey(parsed);
  if (!schemaKey) return parsed;

  const schema = KNOWN_RESULT_SCHEMAS[schemaKey];
  const loads = getAiJsonRepairLoads();
  if (!loads) return coerceKnownResultShape(parsed);
  try {
    return coerceKnownResultShape(loads(json, {
      schema,
      schemaRepairMode: 'salvage',
      returnObjects: true,
    }));
  } catch {
    return coerceKnownResultShape(parsed);
  }
}

export function extractJsonObject(text: string): any | null {
  const json = extractJsonFromCandidate(text);
  if (!json) return null;
  try {
    return repairWithKnownSchema(json, JSON.parse(json));
  } catch {
    const lightweight = lightweightRepairParse(json);
    if (lightweight) {
      return repairWithKnownSchema(json, lightweight);
    }
    return null;
  }
}

export function extractStructuredResult<T = any>(
  markdown: string,
  predicate: (parsed: any) => parsed is T,
): T | null {
  for (const section of getResultSections(markdown)) {
    const parsed = extractJsonObject(section.content);
    if (parsed && predicate(parsed)) {
      return parsed;
    }
  }
  return null;
}

// ============================================================================
// 诊断步骤结论的宽松提取（F02）
// 真实运行里步骤输出有三种历史格式：
//   1) <step-conclusion>{json}</step-conclusion>（脚本步骤；Agent 也可能在同名标签里写 Markdown）
//   2) <result>{json}</result>（本文件原有通道）
//   3) 散文内联 `key=value` / `key: value`（Agent 交接摘要的主流格式，如
//      "issue_golden_flag_met=true，engine_aligned=true"）
// 这里提供统一入口，逐字段记录来源；取不到的字段保持 unknown，不伪造 false/true。
// ============================================================================

export type LooseExtractionSource =
  | 'step-conclusion-json'
  | 'result-tag'
  | 'fenced-json'
  | 'inline-fields'
  | 'prose-verdict'
  | 'unknown';

export interface LooseExtraction {
  fields: Record<string, unknown>;
  /** 每个字段来自哪一层提取；缺失为 'unknown' */
  sources: Record<string, LooseExtractionSource>;
  /** 可信来源之间结论冲突的记录（如 result-tag=pass 而散文=fail）；无冲突为 undefined */
  conflicts?: string[];
}

/** 嵌套容器键：部分步骤把字段包在 run_verification / result 等对象里，收尾读取按顶层优先、容器回退 */
const NESTED_CONTAINER_KEYS = ['run_verification', 'verification', 'result', 'context', 'structured', 'data'] as const;

export function flattenNestedContainers(value: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...value };
  for (const key of NESTED_CONTAINER_KEYS) {
    const nested = value?.[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      for (const [nestedKey, nestedValue] of Object.entries(nested)) {
        if (!(nestedKey in out)) out[nestedKey] = nestedValue;
      }
    }
  }
  return out;
}

/** 允许从散文中提取的布尔字段白名单（避免误抓无关文本） */
const INLINE_BOOL_KEYS = new Set([
  'issue_golden_flag_met', 'engine_aligned', 'bug_fixed', 'baseline_confirmed',
  'issue_content_complete', 'reproduction_confirmed', 'fix_applied', 'tests_passed',
]);
/** 允许从散文中提取的字符串/枚举字段白名单 */
const INLINE_STRING_KEYS = new Set([
  'verdict', 'problem_ownership', 'fix_target', 'verification_status', 'evaluation_mode',
  'root_cause_summary', 'issue_golden_flag', 'demo_path', 'branch', 'commit',
  'reset_target_merge_commit', 'engine_commit', 'conditional_reason', 'input_source',
]);

function coerceInlineValue(raw: string): unknown {
  const value = raw.trim().replace(/[*_`'"。，,；;]+$/, '').trim();
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^null$/i.test(value)) return null;
  return value;
}

/**
 * 从散文中提取白名单内联字段。
 * 兼容 `key=value`、`key: value`、`key：**value**`，值截止到中文/英文逗号、分号、句号或换行。
 */
export function extractInlineKeyValues(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!text) return out;
  const sanitized = stripUntrustedRegions(text);
  const allKeys = [...INLINE_BOOL_KEYS, ...INLINE_STRING_KEYS];
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])(${allKeys.join('|')})\\s*[:：=]\\s*(?:\\*\\*|__|\`)?([^\\n,，;；。]+?)(?:\\*\\*|__|\`)?(?=[,，;；。\\n]|$)`,
    'g',
  );
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sanitized)) !== null) {
    const key = match[1];
    if (key in out) continue; // 首次出现优先（步骤结论通常先写结论）
    const value = coerceInlineValue(match[2]);
    if (INLINE_BOOL_KEYS.has(key) && typeof value !== 'boolean') continue;
    if (typeof value === 'string' && !value) continue;
    out[key] = value;
  }
  return out;
}

/** 散文中的裁决：仅接受显式 verdict 标记或「XX验证 **pass**」句式，拒绝否定语境 */
export function extractProseVerdict(text: string): 'pass' | 'fail' | 'conditional_pass' | null {
  if (!text) return null;
  const sanitized = stripUntrustedRegions(text);
  const explicit = /["'`]?verdict["'`]?\s*[:：=]\s*["'`]?\s*(conditional_pass|pass|fail)\b/i.exec(sanitized);
  if (explicit) return explicit[1].toLowerCase() as 'pass' | 'fail' | 'conditional_pass';
  const sentence = /(?:修复验证|复现验证|方案裁决|根因裁决|对抗验证)\s*[:：]?\s*\*{0,2}\s*(conditional_pass|pass|fail)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = sentence.exec(sanitized)) !== null) {
    const prefix = sanitized.slice(Math.max(0, match.index - 12), match.index);
    if (/不|未|非|否决|驳回|而非/.test(prefix)) continue;
    return match[1].toLowerCase() as 'pass' | 'fail' | 'conditional_pass';
  }
  return null;
}

/** F04：conditional_pass 的具体原因。兼容结构化 conditional_reason 与散文"conditional_pass 的（唯一）原因：…"；只在可信正文上提取 */
export function extractConditionalReason(text: string): string | null {
  if (!text) return null;
  const sanitized = stripUntrustedRegions(text);
  const structured = /["'`]?conditional_reason["'`]?\s*[:：=]\s*["'`]?([^。\n"'`,，}]+)/i.exec(sanitized);
  if (structured?.[1]?.trim()) return structured[1].trim().slice(0, 200);
  const prose = /conditional_pass\s*的(?:唯一|主要)?原因\s*[:：是]?\s*([^。\n]+)/i.exec(sanitized);
  if (prose?.[1]?.trim()) return prose[1].trim().slice(0, 200);
  return null;
}

function parseJsonCandidate(raw: string): Record<string, any> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  const bounds = findBalancedJsonObjectBounds(trimmed);
  if (!bounds) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(bounds.start, bounds.end));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** <step-conclusion> 段落：内容是 JSON 才接受；Agent 在同名标签里写的 Markdown 会被跳过；
 * 注释/引用块里的同名标签视为示例或引述，不可信；
 * 标签就近配对——引文里未闭合的开标签不会吞并后续真实结论（#1761 教训） */
export function getStepConclusionJson(markdown: string): Record<string, any> | null {
  const skipRanges = [
    ...getFencedCodeBlockRanges(markdown),
    ...getHtmlCommentRanges(markdown),
    ...getBlockquoteRanges(markdown),
  ];
  for (const span of findStepConclusionSpans(markdown)) {
    if (isInsideRanges(span.start, skipRanges)) continue;
    const content = span.content.slice(span.content.indexOf('>') + 1, span.content.lastIndexOf('<'));
    const parsed = parseJsonCandidate(content);
    if (parsed) return parsed;
  }
  return null;
}

/** 紧跟在"示例/格式/例如/example"等提示语之后的 fenced JSON 是格式示范，不是裁决结果 */
const EXAMPLE_CONTEXT_RE = /(示例|样例|例子|例如|example|e\.g\.|template|sample)/i;

function normalizeVerdictText(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isExampleFence(markdown: string, fenceIndex: number): boolean {
  const before = markdown.slice(Math.max(0, fenceIndex - 120), fenceIndex);
  const lines = before.split('\n').map((line) => line.trim()).filter(Boolean);
  const nearest = lines[lines.length - 1] || '';
  return EXAMPLE_CONTEXT_RE.test(nearest);
}

function getFencedJsonObjects(markdown: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const regex = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    if (isExampleFence(markdown, match.index)) continue;
    const parsed = parseJsonCandidate(match[1]);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * 统一宽松提取：优先级 step-conclusion(JSON) > result 标签 JSON > fenced json > 内联字段。
 * verdict 额外允许散文句式（extractProseVerdict）。
 * 返回值带逐字段来源，调用方应把 sources 一并归档，便于审计"字段从哪来"。
 */
export function extractLooseStructuredResult(markdown: string): LooseExtraction {
  const fields: Record<string, unknown> = {};
  const sources: Record<string, LooseExtractionSource> = {};
  const apply = (obj: Record<string, any>, source: LooseExtractionSource) => {
    const flat = flattenNestedContainers(obj);
    for (const [key, value] of Object.entries(flat)) {
      if (key in fields) continue;
      fields[key] = value;
      sources[key] = source;
    }
  };

  const stepConclusion = getStepConclusionJson(markdown);
  if (stepConclusion) apply(stepConclusion, 'step-conclusion-json');

  const resultTagged = extractStructuredResult<Record<string, any>>(
    markdown,
    (value): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value),
  );
  if (resultTagged) apply(resultTagged, 'result-tag');

  const fencedObjects = getFencedJsonObjects(markdown);
  for (const fenced of fencedObjects) apply(fenced, 'fenced-json');

  apply(extractInlineKeyValues(markdown), 'inline-fields');

  if (!('verdict' in fields)) {
    const prose = extractProseVerdict(markdown);
    if (prose) {
      fields.verdict = prose;
      sources.verdict = 'prose-verdict';
    }
  }

  // F02 返修：可信来源之间的 verdict 冲突必须显式记录，不允许静默按优先级覆盖。
  const verdictCandidates: Array<{ source: string; verdict: string }> = [];
  const collectVerdict = (obj: Record<string, any> | null, source: string) => {
    const flat = obj ? flattenNestedContainers(obj) : {};
    const raw = flat.verdict;
    if (typeof raw === 'string' && raw.trim()) verdictCandidates.push({ source, verdict: normalizeVerdictText(raw) });
  };
  collectVerdict(stepConclusion, 'step-conclusion-json');
  collectVerdict(resultTagged, 'result-tag');
  for (const fenced of fencedObjects) collectVerdict(fenced, 'fenced-json');
  const proseVerdict = sources.verdict === 'prose-verdict' ? String(fields.verdict) : extractProseVerdict(markdown);
  if (proseVerdict) verdictCandidates.push({ source: 'prose-verdict', verdict: normalizeVerdictText(proseVerdict) });
  const distinct = [...new Set(verdictCandidates.map((candidate) => candidate.verdict))].filter(Boolean);
  const conflicts = distinct.length > 1
    ? verdictCandidates.map((candidate) => `${candidate.source}=${candidate.verdict}`)
    : undefined;

  return conflicts ? { fields, sources, conflicts } : { fields, sources };
}
