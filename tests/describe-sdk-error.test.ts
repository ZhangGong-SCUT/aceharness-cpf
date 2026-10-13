import { describe, expect, it } from 'vitest';
import { describeSdkError } from '../src/lib/engines/opencode-sdk-wrapper';

describe('describeSdkError（F07：空 {} 必须补充错误类别）', () => {
  it('Error 实例带 code/status/exitCode/stderr 全部展开', () => {
    const err: any = new Error('spawn opencode failed');
    err.code = 'ENOENT';
    err.exitCode = 127;
    err.stderr = 'opencode: command not found\nstack tail';
    const text = describeSdkError(err);
    expect(text).toContain('spawn opencode failed');
    expect(text).toContain('code=ENOENT');
    expect(text).toContain('exit=127');
    expect(text).toContain('stderr=opencode: command not found');
  });

  it('SDK 响应错误 {status, message} → 含 HTTP 状态码', () => {
    expect(describeSdkError({ status: 401, message: 'Unauthorized' })).toBe('HTTP 401；Unauthorized');
    expect(describeSdkError({ status: 503 })).toBe('HTTP 503');
  });

  it('空对象不再产生空消息', () => {
    const text = describeSdkError({});
    expect(text).not.toBe('{}');
    expect(text.length).toBeGreaterThan(0);
  });

  it('null/字符串/嵌套 error 字段', () => {
    expect(describeSdkError(null)).toMatch(/空错误对象/);
    expect(describeSdkError('plain failure')).toBe('plain failure');
    expect(describeSdkError({ error: { message: 'model overloaded', code: 429 } })).toContain('model overloaded');
  });

  it('脱敏：令牌与 Bearer 凭据不外泄', () => {
    const text = describeSdkError({ message: 'auth failed for sk-abc123456789SECRET and Bearer tok.en-xyz' });
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('tok.en-xyz');
  });

  it('消息可进入下游瞬态/永久分类（401 不可重试、503 可重试）', () => {
    // 与 workflow-manager isTransientEngineFailure 的口径对齐：401 含 HTTP 401 → 非瞬态
    expect(describeSdkError({ status: 401 })).toMatch(/HTTP 401/);
    expect(describeSdkError({ status: 503 })).toMatch(/HTTP 503/);
    expect(describeSdkError({ code: 'ECONNREFUSED' })).toMatch(/ECONNREFUSED/);
  });
});
