/**
 * R08：可配置自动化策略（仓库/分支级）
 *
 * 提供四种模板：
 *   monitor_only     只监控，不生成/推送修复
 *   suggest_fix      生成修复建议，等用户决策（默认）
 *   manual_apply     必须有用户确认才应用/推送
 *   auto_fix_limited 受限自动修复（在允许路径内、预算内可自动推送）
 *
 * 另含允许/禁止改动范围、轮次/时间/费用预算、构建触发规则。
 * 配置有版本（内容哈希），运行记录引用版本即可回看当时使用的规则。
 * 配置来源：~/.aceharness/configs/pr-review-policies.yaml（缺省用内置默认）。
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'yaml';

export type PrAutoMode = 'monitor_only' | 'suggest_fix' | 'manual_apply' | 'auto_fix_limited';
export type BuildTrigger = 'always' | 'on_fix' | 'never';

export interface PrReviewPolicy {
  mode: PrAutoMode;
  allowPaths: string[];
  denyPaths: string[];
  maxRounds: number;
  timeBudgetMs: number;
  aiCallBudget: number;
  buildTrigger: BuildTrigger;
}

export interface PrPolicyRule extends Partial<PrReviewPolicy> {
  owner: string;
  repo: string;
  branch?: string; // 省略/* 表示该仓库所有分支
}

export interface PrPolicyConfig {
  defaults?: Partial<PrReviewPolicy>;
  repos?: PrPolicyRule[];
}

export const DEFAULT_POLICY: PrReviewPolicy = {
  mode: 'suggest_fix',
  allowPaths: [],
  denyPaths: ['.github/**', '**/*.lock', '**/package-lock.json'],
  maxRounds: 3,
  timeBudgetMs: 30 * 60 * 1000,
  aiCallBudget: 20,
  buildTrigger: 'on_fix',
};

export function resolvePolicyPath(): string {
  const override = process.env.ACE_PR_POLICY_FILE?.trim();
  if (override) return override;
  return join(homedir(), '.aceharness', 'configs', 'pr-review-policies.yaml');
}

/** 内容哈希作为策略版本；空配置返回固定基线版本。 */
export function policyVersionOf(config: PrPolicyConfig | null | undefined): string {
  const canonical = JSON.stringify({
    defaults: config?.defaults || {},
    repos: [...(config?.repos || [])].map((r) => ({ ...r, branch: r.branch || '' }))
      .sort((a, b) => `${a.owner}/${a.repo}@${a.branch}`.localeCompare(`${b.owner}/${b.repo}@${b.branch}`)),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export function loadPrReviewPolicies(path = resolvePolicyPath()): { config: PrPolicyConfig; version: string } {
  let config: PrPolicyConfig = {};
  try {
    const parsed = parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object') config = parsed as PrPolicyConfig;
  } catch {
    // 缺省/无法解析 → 用内置默认，版本仍稳定
  }
  return { config, version: policyVersionOf(config) };
}

function mergePolicy(base: PrReviewPolicy, patch?: Partial<PrReviewPolicy>): PrReviewPolicy {
  if (!patch) return { ...base, allowPaths: [...base.allowPaths], denyPaths: [...base.denyPaths] };
  return {
    mode: patch.mode || base.mode,
    allowPaths: Array.isArray(patch.allowPaths) ? [...patch.allowPaths] : [...base.allowPaths],
    denyPaths: Array.isArray(patch.denyPaths) ? [...patch.denyPaths] : [...base.denyPaths],
    maxRounds: patch.maxRounds ?? base.maxRounds,
    timeBudgetMs: patch.timeBudgetMs ?? base.timeBudgetMs,
    aiCallBudget: patch.aiCallBudget ?? base.aiCallBudget,
    buildTrigger: patch.buildTrigger || base.buildTrigger,
  };
}

/**
 * 解析某 PR 生效的策略。优先级：仓库+分支精确 > 仓库（branch 空或 *）> defaults > 内置默认。
 */
export function resolvePrReviewPolicy(
  config: PrPolicyConfig | null | undefined,
  input: { owner: string; repo: string; branch?: string },
): { policy: PrReviewPolicy; scope: string; version: string } {
  const base = mergePolicy(DEFAULT_POLICY, config?.defaults);
  const rules = config?.repos || [];
  const owner = String(input.owner || '').toLowerCase();
  const repo = String(input.repo || '').toLowerCase();
  const branch = String(input.branch || '');
  const exact = rules.find((r) => r.owner?.toLowerCase() === owner && r.repo?.toLowerCase() === repo && r.branch && r.branch !== '*' && r.branch === branch);
  const repoWide = rules.find((r) => r.owner?.toLowerCase() === owner && r.repo?.toLowerCase() === repo && (!r.branch || r.branch === '*'));
  const rule = exact || repoWide;
  const policy = mergePolicy(base, rule);
  return {
    policy,
    scope: exact ? `repo+branch` : repoWide ? 'repo' : (config?.defaults ? 'defaults' : 'builtin'),
    version: policyVersionOf(config),
  };
}

function matchesGlob(path: string, glob: string): boolean {
  const p = String(path || '').replace(/^\.\//, '');
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`).test(p);
}

/** 校验一次修复动作是否越界/超预算。 */
export function withinPolicy(
  policy: PrReviewPolicy,
  usage: { round?: number; elapsedMs?: number; aiCalls?: number; changedPaths?: string[] } = {},
): { ok: boolean; reason: string } {
  const round = Number(usage.round || 0);
  if (policy.maxRounds > 0 && round > policy.maxRounds) {
    return { ok: false, reason: `修复轮次 ${round} 超过预算 ${policy.maxRounds}` };
  }
  if (policy.timeBudgetMs > 0 && Number(usage.elapsedMs || 0) > policy.timeBudgetMs) {
    return { ok: false, reason: `耗时 ${Math.round(Number(usage.elapsedMs) / 1000)}s 超过预算 ${Math.round(policy.timeBudgetMs / 1000)}s` };
  }
  if (policy.aiCallBudget > 0 && Number(usage.aiCalls || 0) > policy.aiCallBudget) {
    return { ok: false, reason: `AI 调用 ${usage.aiCalls} 超过预算 ${policy.aiCallBudget}` };
  }
  for (const path of usage.changedPaths || []) {
    if (policy.denyPaths.some((g) => matchesGlob(path, g))) {
      return { ok: false, reason: `改动命中禁止范围：${path}` };
    }
    if (policy.allowPaths.length && !policy.allowPaths.some((g) => matchesGlob(path, g))) {
      return { ok: false, reason: `改动不在允许范围：${path}` };
    }
  }
  return { ok: true, reason: '' };
}

/** 生成注入工作流的策略约束说明（确定性，不含模型判断）。 */
export function buildPolicyInstructions(policy: PrReviewPolicy): string {
  const lines = [`修复策略：${policy.mode}`, `最多修复轮次：${policy.maxRounds}`, `构建触发：${policy.buildTrigger}`];
  if (policy.allowPaths.length) lines.push(`仅允许改动：${policy.allowPaths.join(', ')}`);
  if (policy.denyPaths.length) lines.push(`禁止改动：${policy.denyPaths.join(', ')}`);
  return lines.join('\n');
}
