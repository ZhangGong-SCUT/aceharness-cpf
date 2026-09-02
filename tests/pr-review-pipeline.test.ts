import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';
import { validateWorkflowDraft } from '@/lib/core/creator-validation';
import {
  classifyPrReviewInput,
  describeIgnoredPr,
  isOwnPrAuthor,
  parseGitcodeWebhookPayload,
  shouldStartPrReview,
} from '@/lib/workflow/pr-review-input';
import { formatGlobalContextPrompt } from '@/lib/workflow/global-context-prompt';
import { extractGitcodeWebhookSecret, secretsMatch } from '@/lib/workflow/gitcode-webhook';
import { summarizeGlobalContext } from '@/lib/workflow/run-diagnostics';

describe('classifyPrReviewInput', () => {
  test('parses GitCode pull URL', () => {
    const input = classifyPrReviewInput('请检视 https://gitcode.com/CPF-Flutter/flutter_flutter/pull/1732');
    expect(input.mode).toBe('pr');
    expect(input.number).toBe('1732');
    expect(input.owner).toBe('CPF-Flutter');
    expect(input.repo).toBe('flutter_flutter');
    expect(input.prUrl).toContain('/pull/1732');
  });

  test('parses merge_requests URL', () => {
    const input = classifyPrReviewInput('https://gitcode.com/org/repo/merge_requests/9');
    expect(input.mode).toBe('pr');
    expect(input.number).toBe('9');
  });

  test('parses webhook-style context block', () => {
    const input = classifyPrReviewInput([
      'GitCode PR 检视任务',
      'pr_url: https://gitcode.com/acme/app/pull/12',
      'owner: acme',
      'repo: app',
      'number: 12',
      'action: open',
      'head_ref: feature-x',
    ].join('\n'));
    expect(input.mode).toBe('event');
    expect(input.number).toBe('12');
    expect(input.action).toBe('open');
    expect(input.headRef).toBe('feature-x');
  });

  test('empty and freeform modes', () => {
    expect(classifyPrReviewInput('').mode).toBe('empty');
    expect(classifyPrReviewInput('随便看看这段代码').mode).toBe('freeform');
  });
});

describe('parseGitcodeWebhookPayload', () => {
  test('accepts Gitee-style merge request open', () => {
    const parsed = parseGitcodeWebhookPayload({
      hook_name: 'merge_request_hooks',
      action: 'open',
      pull_request: {
        number: 18,
        title: 'fix gate',
        html_url: 'https://gitcode.com/acme/app/pull/18',
        state: 'open',
        head: { ref: 'feature', sha: 'abc' },
        base: { ref: 'master' },
        user: { login: 'dev' },
      },
      repository: { full_name: 'acme/app' },
    });
    expect(parsed.accepted).toBe(true);
    expect(parsed.input.number).toBe('18');
    expect(parsed.context).toContain('pr_url: https://gitcode.com/acme/app/pull/18');
    expect(parsed.context).toContain('head_sha: abc');
    expect(parsed.input.author).toBe('dev');
  });

  test('ignores merged close events', () => {
    const parsed = parseGitcodeWebhookPayload({
      action: 'closed',
      pull_request: {
        number: 2,
        merged: true,
        html_url: 'https://gitcode.com/acme/app/pull/2',
        state: 'merged',
      },
      repository: { path: 'app', namespace: 'acme' },
    });
    expect(parsed.accepted).toBe(false);
    expect(parsed.reason).toContain('忽略事件');
  });

  test('accepts GitLab-style object_attributes payload', () => {
    const parsed = parseGitcodeWebhookPayload({
      object_kind: 'merge_request',
      user: { username: 'z2036709353', name: 'zhanggong' },
      object_attributes: {
        iid: 7,
        action: 'update',
        title: 'sync',
        url: 'https://gitcode.com/acme/app/merge_requests/7',
        source_branch: 'dev',
        target_branch: 'master',
        state: 'opened',
      },
      project: { path_with_namespace: 'acme/app' },
    });
    expect(parsed.accepted).toBe(true);
    expect(parsed.input.number).toBe('7');
    expect(parsed.input.headRef).toBe('dev');
    expect(parsed.input.author).toBe('z2036709353');
  });

  test('accepts note events attached to a pull request', () => {
    const parsed = parseGitcodeWebhookPayload({
      hook_name: 'note_hooks',
      action: 'comment',
      pull_request: {
        number: 18,
        html_url: 'https://gitcode.com/acme/app/pull/18',
        state: 'open',
        user: { login: 'me' },
        head: { ref: 'feature', sha: 'abc' },
      },
      repository: { full_name: 'acme/app' },
    });
    expect(parsed.accepted).toBe(true);
    expect(parsed.input.author).toBe('me');
  });

  test('accepts GitCode merge_request payload that only has web_url', () => {
    const parsed = parseGitcodeWebhookPayload({
      object_kind: 'merge_request',
      action: 'update',
      user: { username: 'z2036709353' },
      merge_request: {
        title: 'probe',
        url: 'https://gitcode.com/z2036709353/works/merge_requests/3',
        source_branch: 'test/webhook-probe-2',
        target_branch: 'main',
        state: 'opened',
      },
      repository: { git_http_url: 'https://gitcode.com/z2036709353/works.git' },
      project: { full_path: 'z2036709353/works', path: 'works' },
    });
    expect(parsed.accepted).toBe(true);
    expect(parsed.input.owner).toBe('z2036709353');
    expect(parsed.input.repo).toBe('works');
    expect(parsed.input.number).toBe('3');
    expect(parsed.input.author).toBe('z2036709353');
  });

  test('rejects payload without pull request', () => {
    const parsed = parseGitcodeWebhookPayload({ action: 'open', repository: { full_name: 'acme/app' } });
    expect(parsed.accepted).toBe(false);
  });
});

describe('own-author filter', () => {
  test('requires configured author and ignores other people', () => {
    expect(isOwnPrAuthor('me', ['me'])).toBe(true);
    expect(isOwnPrAuthor('other', ['me'])).toBe(false);
    expect(describeIgnoredPr({
      author: 'other',
      owner: 'acme',
      repo: 'app',
      allowedAuthors: ['me'],
      watchedRepos: [],
    })).toContain('忽略他人 PR');
    expect(describeIgnoredPr({
      author: 'me',
      owner: 'acme',
      repo: 'app',
      allowedAuthors: [],
      watchedRepos: [],
    })).toContain('未配置 ACE_GITCODE_PR_AUTHOR');
    expect(describeIgnoredPr({
      author: 'me',
      owner: 'acme',
      repo: 'app',
      allowedAuthors: ['me'],
      watchedRepos: ['acme/app'],
    })).toBeNull();
  });
});

describe('shouldStartPrReview', () => {
  test('starts on open/update and skips merge', () => {
    expect(shouldStartPrReview('open')).toBe(true);
    expect(shouldStartPrReview('synchronize')).toBe(true);
    expect(shouldStartPrReview('merge', { merged: true })).toBe(false);
    expect(shouldStartPrReview('closed')).toBe(false);
  });
});

describe('formatGlobalContextPrompt', () => {
  test('uses PR prompt for pull URLs instead of diagnosis freeform', () => {
    const prompt = formatGlobalContextPrompt('https://gitcode.com/CPF-Flutter/flutter_flutter/pull/1732');
    expect(prompt).toContain('mode=pr');
    expect(prompt).toContain('gitcode-pr-review');
    expect(prompt).not.toContain('mode=freeform');
  });

  test('keeps diagnosis issue prompt', () => {
    const prompt = formatGlobalContextPrompt('https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2116');
    expect(prompt).toContain('mode=issue');
  });
});

describe('gitcode webhook secret extraction', () => {
  test('reads password from query, header or body', () => {
    expect(extractGitcodeWebhookSecret({ query: { password: 'q' }, body: {} })).toBe('q');
    expect(extractGitcodeWebhookSecret({
      headers: { 'X-GitCode-Token': 'h' },
      body: {},
    })).toBe('h');
    expect(extractGitcodeWebhookSecret({ body: { password: 'b' } })).toBe('b');
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
  });
});

describe('summarizeGlobalContext', () => {
  test('marks PR urls separately from issues', () => {
    const pr = summarizeGlobalContext('https://gitcode.com/acme/app/pull/4');
    expect(pr.hasPrUrl).toBe(true);
    expect(pr.inputMode).toBe('pr');
    expect(pr.hasIssueUrl).toBe(false);
  });
});

describe('gitcode-pr-review workflow config', () => {
  test('validates as a portable state machine with three-way verdicts', () => {
    const raw = readFileSync(resolve(__dirname, '../configs/gitcode-pr-review.yaml'), 'utf-8');
    const config = parse(raw);
    const result = validateWorkflowDraft(config, { mode: 'portable' });
    const errors = result.issues.filter((issue) => issue.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(config.workflow.states.map((state: { name: string }) => state.name)).toEqual([
      '识别',
      '等待门禁',
      '挂起',
      '分类处置',
      '分流静态',
      '分流编译',
      '分流测试',
      '分流检视',
      '分流触发',
      'DCO修复',
      '静态修复',
      '编译修复',
      '检视修复',
      '推送并触发',
      '就绪',
      '人工确认',
      '完成',
      '终止',
    ]);
    expect(config.workflow.maxTransitions).toBeGreaterThanOrEqual(40);
    const wait = config.workflow.states.find((state: { name: string }) => state.name === '等待门禁');
    expect(wait.transitions.map((item: { to: string }) => item.to).sort()).toEqual(['分类处置', '挂起', '终止']);
    const push = config.workflow.states.find((state: { name: string }) => state.name === '推送并触发');
    expect(push.transitions.some((item: { to: string }) => item.to === '等待门禁')).toBe(true);
    expect(push.transitions.some((item: { to: string }) => item.to === '完成')).toBe(false);
  });
});
