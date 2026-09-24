import { describe, expect, test } from 'vitest';
import {
  DEFAULT_POLICY,
  policyVersionOf,
  resolvePrReviewPolicy,
  withinPolicy,
  buildPolicyInstructions,
} from '@/lib/workflow/pr-review-policy';

const config = {
  defaults: { mode: 'suggest_fix' as const, maxRounds: 3 },
  repos: [
    { owner: 'CPF-Flutter', repo: 'flutter_flutter', mode: 'manual_apply' as const, maxRounds: 2 },
    { owner: 'CPF-Flutter', repo: 'flutter_flutter', branch: 'dev', mode: 'monitor_only' as const },
    { owner: 'other', repo: 'engine', allowPaths: ['packages/**'], denyPaths: ['.github/**'] },
  ],
};

describe('pr-review-policy（R08 可配置策略）', () => {
  test('resolution precedence: repo+branch > repo > defaults > builtin', () => {
    expect(resolvePrReviewPolicy(config, { owner: 'CPF-Flutter', repo: 'flutter_flutter', branch: 'dev' }).scope).toBe('repo+branch');
    expect(resolvePrReviewPolicy(config, { owner: 'CPF-Flutter', repo: 'flutter_flutter', branch: 'dev' }).policy.mode).toBe('monitor_only');
    expect(resolvePrReviewPolicy(config, { owner: 'CPF-Flutter', repo: 'flutter_flutter', branch: 'main' }).policy.mode).toBe('manual_apply');
    const builtin = resolvePrReviewPolicy({}, { owner: 'x', repo: 'y' });
    expect(builtin.scope).toBe('builtin');
    expect(builtin.policy.mode).toBe(DEFAULT_POLICY.mode);
  });

  test('version is stable and changes with content', () => {
    expect(policyVersionOf(config)).toBe(policyVersionOf(JSON.parse(JSON.stringify(config))));
    const changed = { ...config, defaults: { mode: 'monitor_only' as const } };
    expect(policyVersionOf(changed)).not.toBe(policyVersionOf(config));
  });

  test('withinPolicy enforces scope and budgets', () => {
    const { policy } = resolvePrReviewPolicy(config, { owner: 'other', repo: 'engine' });
    expect(withinPolicy(policy, { changedPaths: ['packages/a.ts'] }).ok).toBe(true);
    expect(withinPolicy(policy, { changedPaths: ['src/a.ts'] }).ok).toBe(false);
    expect(withinPolicy(policy, { changedPaths: ['.github/workflows/x.yml'] }).ok).toBe(false);
    expect(withinPolicy(policy, { round: 5 }).ok).toBe(false);
    expect(withinPolicy(policy, { aiCalls: 999 }).ok).toBe(false);
  });

  test('buildPolicyInstructions is deterministic', () => {
    const { policy } = resolvePrReviewPolicy(config, { owner: 'other', repo: 'engine' });
    const text = buildPolicyInstructions(policy);
    expect(text).toContain('修复策略：suggest_fix');
    expect(text).toContain('packages/**');
  });
});
