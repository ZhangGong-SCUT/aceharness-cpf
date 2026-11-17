import { describe, expect, test } from 'vitest';
import { parseContext } from '../skills/gitcode-pr-review/scripts/validate-pr-identity.mjs';

const wrapped = `# Auto-generated run state
globalContext: >-
  GitCode 自己的 PR 自修任务

  event: manual

  action: open

  pr_url:
  https://gitcode.com/CPF-Flutter/fluttertpc_flutter_exit_app/merge_requests/13

  owner: CPF-Flutter

  repo: fluttertpc_flutter_exit_app

  number: 13

  author: z2036709353

  head_repo: z2036709353/fluttertpc_flutter_exit_app

  head_ref: br_3.27_dev

  base_ref: br_3.27_dev

  manual-start-by: z2036709353
phaseContexts: {}
`;

describe('PR 身份上下文', () => {
  test('折叠后的长 pr_url 会拼回完整地址', () => {
    const fields = parseContext(wrapped);
    expect(fields.pr_url).toBe('https://gitcode.com/CPF-Flutter/fluttertpc_flutter_exit_app/merge_requests/13');
    expect(fields.owner).toBe('CPF-Flutter');
    expect(fields.number).toBe('13');
    expect(fields['manual-start-by']).toBe('z2036709353');
  });

  test('同一行的 pr_url 保持原值', () => {
    const fields = parseContext(`globalContext: |-
  pr_url: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/2111
  owner: CPF-Flutter
phaseContexts: {}
`);
    expect(fields.pr_url).toBe('https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/2111');
    expect(fields.owner).toBe('CPF-Flutter');
  });

  test('没有 pr_url 时仍是空字段', () => {
    const fields = parseContext(`globalContext: |-
  owner: CPF-Flutter
  repo: flutter_flutter
phaseContexts: {}
`);
    expect(fields.pr_url).toBeUndefined();
    expect(fields.repo).toBe('flutter_flutter');
  });
});
