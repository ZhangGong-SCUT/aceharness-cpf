import { describe, expect, it } from 'vitest';
import { openCodeSdkPoolKey } from '../src/lib/engines/opencode-sdk-wrapper';

describe('openCodeSdkPoolKey', () => {
  it('同一用户的不同工作目录不共用一个 OpenCode 服务', () => {
    const diagnosis = openCodeSdkPoolKey('user-1', '/tmp/run-workspaces/run-ia');
    const review = openCodeSdkPoolKey('user-1', '/tmp/run-workspaces/run-pr');
    expect(diagnosis).not.toBe(review);
  });

  it('同一工作目录复用同一个池键', () => {
    expect(openCodeSdkPoolKey('user-1', '/tmp/run-a')).toBe(openCodeSdkPoolKey('user-1', '/tmp/run-a'));
  });
});
