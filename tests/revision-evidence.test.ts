import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { buildRevisionEvidence, extractIssueRevisionExpectation, isRevisionMatch, readFlutterSdkRevisions } from '@/lib/workflow/revision-evidence';

describe('Issue revision 证据', () => {
  test('读取 environment_info，兼容旧采集中的版本摘要', () => {
    expect(extractIssueRevisionExpectation('{"environment_info":{"framework_revision":"adaf911c","engine_revision":"42d3d75a"}}')).toMatchObject({
      framework: 'adaf911c', engine: '42d3d75a', requirement: 'strict',
    });
    const legacy = '{"issue_body_summary":"Framework revision：1.0.0=244a0e8a（正常），1.0.1=adaf911c（异常）。","environment_info":{"engine_version":"42d3d75a56efe1a2e9902f52dc8006099c45d937（两版本相同）"}}';
    expect(extractIssueRevisionExpectation(legacy)).toMatchObject({ framework: 'adaf911c', engine: '42d3d75a56efe1a2e9902f52dc8006099c45d937', requirement: 'advisory' });
    expect(extractIssueRevisionExpectation('{"environment_info":{"framework_version":"missing"}}')).toBeNull();
  });

  test('精确 revision 与短 SHA 均校验，不匹配与未知不混淆', () => {
    const actual = 'adaf911c' + '1'.repeat(32);
    const wrong = '244a0e8a' + '1'.repeat(32);
    expect(isRevisionMatch(actual, 'adaf911c')).toBe(true);
    expect(isRevisionMatch(wrong, 'adaf911c')).toBe(false);
    expect(isRevisionMatch(null, 'adaf911c')).toBe(false);
    const unknown = buildRevisionEvidence({ expected: extractIssueRevisionExpectation('{"environment_info":{"framework_revision":"adaf911c"}}'), actual: { framework: null, engine: null } });
    expect(unknown).toMatchObject({ status: 'unknown', unknown: ['sdk_framework_revision'], mismatches: [] });
    const evidence = buildRevisionEvidence({ expected: extractIssueRevisionExpectation('{"environment_info":{"framework_revision":"adaf911c"}}'), actual: { framework: wrong, engine: null }, verification: { framework: '244a0e8a' } });
    expect(evidence.status).toBe('mismatch');
    expect(evidence.mismatches).toEqual(['sdk_framework_revision']);
    expect(evidence.declaredMismatches).toEqual(['verification_framework_revision']);
  });

  test('从隔离 pin 的原始 SDK 读取 Git HEAD 与 engine.version，清理副本后仍可核对', () => {
    const sdk = mkdtempSync(join(tmpdir(), 'revision-sdk-'));
    mkdirSync(join(sdk, 'bin/cache'), { recursive: true });
    writeFileSync(join(sdk, 'bin/cache/engine.version'), '42d3d75a56efe1a2e9902f52dc8006099c45d937\n');
    execFileSync('git', ['init', '-q', sdk]);
    expect(readFlutterSdkRevisions({ sourceSdkRoot: sdk, sdkRoot: '/removed/sdk-overlay/sdk' })).toEqual({
      framework: null, engine: '42d3d75a56efe1a2e9902f52dc8006099c45d937',
    });
  });
});
