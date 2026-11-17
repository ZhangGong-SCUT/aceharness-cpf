import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ directory: '', run: null as any }));
vi.mock('@/lib/run/state-persistence', () => ({ loadRunState: vi.fn(async () => fixture.run) }));
vi.mock('@/lib/core/app-paths', () => ({ getWorkspaceRunsDir: vi.fn(() => fixture.directory) }));

beforeEach(async () => {
  fixture.directory = await mkdtemp(join(tmpdir(), 'ace-failure-evidence-'));
  fixture.run = { runId: 'run-test', status: 'failed' };
  await mkdir(join(fixture.directory, 'run-test'), { recursive: true });
  await writeFile(join(fixture.directory, 'run-test', 'diagnostics.jsonl'), [
    JSON.stringify({ timestamp: '2026-11-15T11:31:37.884Z', event: 'ohos.flutter.sdk', matched: true,
      branch: 'oh-3.41.9-dev', sdkId: '3.41.9-ohos', flutterBin: '/private/sdk/bin/flutter' }),
    JSON.stringify({ timestamp: '2026-11-15T14:47:45.969Z', event: 'ohos.flutter.sdk', matched: false,
      branch: 'B', reason: '没有与 B 对应的 SDK', prompt: '不能泄露的提示词', output: '不能泄露的输出' }),
    JSON.stringify({ timestamp: '2026-11-15T14:53:25.161Z', event: 'step.fail', state: '方案设计', step: '方案裁决',
      error: 'SDK 隔离目录不兼容或不完整', prompt: '敏感提示词' }),
    JSON.stringify({ event: 'step.prompt', prompt: '禁止返回完整提示词' }),
  ].join('\n'));
});

test('failure evidence returns bounded structured events without prompt or output contents', async () => {
  const { GET } = await import('@/app/api/runs/[id]/failure-evidence/route');
  const response = await GET(null as any, { params: Promise.resolve({ id: 'run-test' }) });
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.events).toHaveLength(4);
  expect(data.events[1]).toMatchObject({ branch: 'B', matched: false });
  expect(data.events[1]).not.toHaveProperty('prompt');
  expect(data.events[1]).not.toHaveProperty('output');
  expect(JSON.stringify(data)).not.toContain('不能泄露的');
  expect(JSON.stringify(data)).not.toContain('禁止返回完整提示词');
});

test('failure evidence does not open arbitrary paths when run identity is absent', async () => {
  fixture.run = null;
  const { GET } = await import('@/app/api/runs/[id]/failure-evidence/route');
  const response = await GET(null as any, { params: Promise.resolve({ id: '../other-run' }) });
  expect(response.status).toBe(404);
});
