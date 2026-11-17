import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test, vi } from 'vitest';
import { getBuiltinMcpServers, allowMcpConnectAttempt, ensureOpenCodeCompatibleMcpServers } from '@/lib/mcp/registry';
import {
  buildVisionMessages,
  chatCompletionsUrl,
  guessMimeType,
  isLockScreenObservation,
  lookAtImage,
  mcpToolList,
  parseCliArgs,
  resolveVisionEndpoint,
} from '../skills/cpf-ohos-issue-analysis/scripts/look-at-image.mjs';

describe('look-at-image helper', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  test('parses CLI flags and mcp mode', () => {
    expect(parseCliArgs(['mcp']).mode).toBe('mcp');
    expect(parseCliArgs(['--image', 'a.png', '--question', '齐不齐？'])).toMatchObject({
      image: 'a.png',
      question: '齐不齐？',
      mode: 'cli',
    });
  });

  test('锁屏观察不能当证据', () => {
    expect(isLockScreenObservation('当前显示的是**系统锁屏**界面。无 SIM 卡，电量 77')).toBe(true);
    expect(isLockScreenObservation('Demo 输入框里是一ersans')).toBe(false);
  });

  test('guesses image mime types', () => {
    expect(guessMimeType('shot.jpeg')).toBe('image/jpeg');
    expect(guessMimeType('shot.PNG')).toBe('image/png');
  });

  test('reads vision endpoint from OpenCode 火山网关 config', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'vision-look-'));
    const configPath = join(tempDir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({
      provider: {
        火山AI网关: {
          options: {
            baseURL: 'https://example.test/v1',
            apiKey: 'test-key',
          },
        },
      },
    }));
    expect(resolveVisionEndpoint({ OPENCODE_CONFIG: configPath }, tempDir)).toEqual({
      baseURL: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'qwen3.7-plus',
    });
    expect(chatCompletionsUrl('https://example.test/v1')).toBe('https://example.test/v1/chat/completions');
  });

  test('lookAtImage sends image_url and returns model text', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'vision-look-img-'));
    const imagePath = join(tempDir, 'red.png');
    writeFileSync(imagePath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ));
    const fetchImpl = async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.model).toBe('qwen3.7-plus');
      expect(body.messages[1].content[1].type).toBe('image_url');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: '下划线偏右' } }],
        }),
      };
    };
    const result = await lookAtImage({
      image: imagePath,
      question: '下划线齐不齐？',
      env: {
        VISION_BASE_URL: 'https://example.test/v1',
        VISION_API_KEY: 'test-key',
      },
      fetchImpl,
    });
    expect(result.text).toBe('下划线偏右');
    expect(buildVisionMessages('q', 'data:image/png;base64,xx')[1].content[0]).toEqual({
      type: 'text',
      text: 'q',
    });
  });

  test('exposes look_at_image MCP tool as a vision fallback', () => {
    expect(mcpToolList()[0]?.name).toBe('look_at_image');
    expect(mcpToolList()[0]?.description).toContain('能看图的模型请直接 Read 原图');
    expect(mcpToolList()[0]?.description).not.toContain('必须用这个工具');
  });

  test('ships a builtin vision-look MCP server', () => {
    const servers = getBuiltinMcpServers();
    expect(servers[0]?.name).toBe('vision-look');
    expect(servers[0]?.command).toContain('look-at-image.mjs');
    expect(servers[0]?.command.startsWith(JSON.stringify(process.execPath))).toBe(true);
  });

  test('retries transient MCP status errors and preserves structured errors', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce({ error: {} })
      .mockResolvedValueOnce({ data: { 'vision-look': { status: 'connected' } } });
    await ensureOpenCodeCompatibleMcpServers({ mcp: { status } }, '/tmp/project', [{ name: 'vision-look', type: 'stdio', command: 'node look-at-image.mjs mcp' }]);
    expect(status).toHaveBeenCalledTimes(2);

    vi.useFakeTimers();
    try {
      const failing = ensureOpenCodeCompatibleMcpServers({ mcp: { status: vi.fn().mockResolvedValue({ error: {} }) } }, '/tmp/project', [{ name: 'vision-look', type: 'stdio', command: 'node look-at-image.mjs mcp' }]);
      const assertion = expect(failing).rejects.toThrow('未知 MCP 错误（空错误对象）');
      await vi.advanceTimersByTimeAsync(4_000);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
});
