import { describe, expect, test, vi } from 'vitest';
import type { EngineStreamEvent } from '@/lib/engines/engine-interface';
import {
  discoverOpenCodeModelsFromHttpClient,
  formatError,
  getOpenCodeStreamTimeoutConfig,
  normalizeOpenCodeModelsFromProviderSources,
  resolveOpenCodeModelId,
  sendPromptWithOpenCodeHttp,
} from '@/lib/engines/opencode-http-adapter';

describe('sendPromptWithOpenCodeHttp regressions', () => {
  test('uses a long default total timeout with a separate idle timeout for streaming prompts', () => {
    const originalTotal = process.env.ACE_OPENCODE_STREAM_TIMEOUT_MS;
    const originalIdle = process.env.ACE_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
    try {
      delete process.env.ACE_OPENCODE_STREAM_TIMEOUT_MS;
      delete process.env.ACE_OPENCODE_STREAM_IDLE_TIMEOUT_MS;

      expect(getOpenCodeStreamTimeoutConfig()).toEqual({
        totalMs: 60 * 60 * 1000,
        idleMs: 10 * 60 * 1000,
      });

      process.env.ACE_OPENCODE_STREAM_TIMEOUT_MS = '7200000';
      process.env.ACE_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '900000';
      expect(getOpenCodeStreamTimeoutConfig()).toEqual({
        totalMs: 7_200_000,
        idleMs: 900_000,
      });

      expect(getOpenCodeStreamTimeoutConfig(120_000)).toEqual({
        totalMs: 120_000,
        idleMs: 120_000,
      });
    } finally {
      if (originalTotal === undefined) {
        delete process.env.ACE_OPENCODE_STREAM_TIMEOUT_MS;
      } else {
        process.env.ACE_OPENCODE_STREAM_TIMEOUT_MS = originalTotal;
      }
      if (originalIdle === undefined) {
        delete process.env.ACE_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
      } else {
        process.env.ACE_OPENCODE_STREAM_IDLE_TIMEOUT_MS = originalIdle;
      }
    }
  });

  test('classifies OpenCode SQLite exhaustion as an environment failure', () => {
    const message = formatError(new Error('Failed to execute statement: SQLiteError: database or disk is full'));
    expect(message).toContain('OpenCode SQLite 数据库或磁盘已满');
    expect(message).toContain('不是 Flutter 引擎错误');
  });

  test('normalizes OpenCode provider model responses from new and config shapes', () => {
    expect(normalizeOpenCodeModelsFromProviderSources(
      {
        data: {
          providers: [
            {
              id: 'penguiapigpt',
              name: 'Pengui-gpt',
              models: {
                'gpt-5.3-codex': { id: 'gpt-5.3-codex', name: 'gpt-5.3-codex' },
              },
            },
          ],
        },
      },
      {
        data: {
          provider: {
            penguiapi: {
              name: 'Pengui-Api',
              models: {
                'claude-sonnet-4-5': { name: 'claude-sonnet-4-6' },
              },
            },
          },
        },
      },
    )).toEqual([
      { modelId: 'penguiapigpt/gpt-5.3-codex', name: 'Pengui-gpt/gpt-5.3-codex' },
      { modelId: 'penguiapi/claude-sonnet-4-5', name: 'Pengui-Api/claude-sonnet-4-6' },
    ]);
  });

  test('resolves short OpenCode model names against discovered provider models', () => {
    const models = [
      { modelId: 'siliconflow-cn/Pro/zai-org/GLM-5.1', name: 'SiliconFlow (China)/Pro/zai-org/GLM-5.1' },
      { modelId: 'volcengine/GLM-5.1', name: 'csi.ai/GLM-5.1' },
      { modelId: 'volcengine/GLM-5', name: 'csi.ai/GLM-5' },
    ];

    expect(resolveOpenCodeModelId('glm-5.1', models)).toBe('volcengine/GLM-5.1');
    expect(resolveOpenCodeModelId('volcengine/GLM-5.1', models)).toBe('volcengine/GLM-5.1');
    expect(resolveOpenCodeModelId('missing/model', models)).toBe('');
  });

  test('discovers OpenCode models through SDK HTTP provider APIs before config fallback', async () => {
    const configProviders = vi.fn(async () => ({
      data: {
        providers: [
          {
            id: 'opencode',
            name: 'OpenCode Zen',
            models: {
              'big-pickle': { name: 'Big Pickle' },
            },
          },
        ],
      },
    }));
    const providerList = vi.fn();
    const configGet = vi.fn();

    await expect(discoverOpenCodeModelsFromHttpClient({
      config: {
        providers: configProviders,
        get: configGet,
      },
      provider: {
        list: providerList,
      },
      session: {} as any,
    })).resolves.toEqual([
      { modelId: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
    ]);

    expect(configProviders).toHaveBeenCalledTimes(1);
    expect(providerList).not.toHaveBeenCalled();
    expect(configGet).not.toHaveBeenCalled();
  });

  test('returns hydrated assistant output when the SSE stream errors after prompt acceptance', async () => {
    const emitted: EngineStreamEvent[] = [];
    const logs: Array<{ message: string; level?: string }> = [];
    let messageCallCount = 0;

    const messagesMock = vi.fn(async () => {
      messageCallCount += 1;
      if (messageCallCount === 1) {
        return { data: [] };
      }
      return {
        data: [
          {
            info: { role: 'assistant' },
            parts: [
              {
                id: 'answer-1',
                type: 'text',
                text: '{"files":["ace.js"]}',
              },
            ],
          },
        ],
      };
    });

    const subscribeMock = vi.fn(async ({
      signal,
      onSseError,
    }: {
      signal?: AbortSignal;
      onSseError?: (error: unknown) => void;
    }) => {
      setTimeout(() => {
        onSseError?.(new Error('ECONNRESET'));
      }, 40);

      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'message.part.updated',
              properties: {
                sessionID: 'session-1',
                part: {
                  id: 'tool-1',
                  type: 'tool',
                  tool: 'glob',
                  state: {
                    status: 'pending',
                    input: {
                      pattern: '*',
                      path: 'C:\\workspace\\bin',
                    },
                  },
                },
              },
            };

            while (!signal?.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          },
        },
      };
    });

    await expect(sendPromptWithOpenCodeHttp({
      engineName: 'opencode-http',
      client: {
        event: {
          subscribe: subscribeMock,
        },
        session: {
          create: vi.fn(),
          prompt: vi.fn(async () => ({ data: { parts: [] } })),
          promptAsync: vi.fn(async () => ({ data: {} })),
          messages: messagesMock,
        },
      } as any,
      sessionId: 'session-1',
      fullPrompt: '输出 bin 目录文件列表，只输出一个 json',
      emit: (event) => emitted.push(event),
      log: (entry) => logs.push({ message: entry.message, level: entry.level }),
    })).resolves.toBe('{"files":["ace.js"]}');

    const textEvents = emitted
      .filter((event) => event.type === 'text')
      .map((event) => event.content)
      .join('');

    expect(textEvents).toContain('{"files":["ace.js"]}');
    expect(logs.some((entry) => entry.message === 'Raw SSE error')).toBe(false);
    expect(logs.some((entry) => entry.message === 'Streaming prompt recovered from stream error via hydrated output')).toBe(false);
  });

  test('completes from session status polling when OpenCode SSE misses idle with stale pending parts', async () => {
    const emitted: EngineStreamEvent[] = [];
    let messageCalls = 0;
    const messagesMock = vi.fn(async () => {
      messageCalls += 1;
      if (messageCalls === 1) return { data: [] };
      return {
      data: [
        {
          info: { role: 'assistant' },
          parts: [
            {
              id: 'answer-1',
              type: 'text',
              text: 'done from status poll',
            },
            {
              id: 'tool-1',
              type: 'tool',
              state: {
                status: 'running',
                input: { command: 'echo done' },
              },
            },
          ],
        },
      ],
    };
    });

    const subscribeMock = vi.fn(async ({ signal }: { signal?: AbortSignal }) => ({
      stream: {
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        },
      },
    }));

    await expect(sendPromptWithOpenCodeHttp({
      engineName: 'opencode-http',
      client: {
        event: {
          subscribe: subscribeMock,
        },
        session: {
          create: vi.fn(),
          prompt: vi.fn(async () => ({ data: { parts: [] } })),
          promptAsync: vi.fn(async () => ({ data: {} })),
          status: vi.fn(async () => ({ data: { 'session-1': { type: 'idle' } } })),
          messages: messagesMock,
        },
      } as any,
      sessionId: 'session-1',
      fullPrompt: 'finish',
      emit: (event) => emitted.push(event),
    })).resolves.toBe('done from status poll');

    const textEvents = emitted
      .filter((event) => event.type === 'text')
      .map((event) => event.content)
      .join('');
    expect(textEvents).toContain('done from status poll');
  });

  test('does not treat a resumed session that is already idle as a finished empty reply', async () => {
    const previous = {
      info: { id: 'old-assistant', role: 'assistant' },
      parts: [{ id: 'old-text', type: 'text', text: 'previous answer' }],
    };
    process.env.ACE_OPENCODE_NO_NEW_OUTPUT_GRACE_MS = '80';
    try {
      await expect(sendPromptWithOpenCodeHttp({
        engineName: 'opencode-http',
        client: {
          event: {
            subscribe: vi.fn(async ({ signal }: { signal?: AbortSignal }) => ({
              stream: {
                async *[Symbol.asyncIterator]() {
                  while (!signal?.aborted) {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                  }
                },
              },
            })),
          },
          session: {
            create: vi.fn(),
            prompt: vi.fn(async () => ({ data: { parts: [] } })),
            promptAsync: vi.fn(async () => ({ data: {} })),
            status: vi.fn(async () => ({ data: { 'session-1': { type: 'idle' } } })),
            messages: vi.fn(async () => ({ data: [previous] })),
          },
        } as any,
        sessionId: 'session-1',
        fullPrompt: 'challenge the plan again',
        emit: () => {},
      })).rejects.toThrow(/未产生任何输出/);
    } finally {
      delete process.env.ACE_OPENCODE_NO_NEW_OUTPUT_GRACE_MS;
    }
  });

  test('aborts the server-side session when a prompt fails after acceptance', async () => {
    const abort = vi.fn(async () => ({ data: true }));
    process.env.ACE_OPENCODE_NO_NEW_OUTPUT_GRACE_MS = '80';
    try {
      await expect(sendPromptWithOpenCodeHttp({
        engineName: 'opencode-http',
        client: {
          event: {
            subscribe: vi.fn(async ({ signal }: { signal?: AbortSignal }) => ({
              stream: {
                async *[Symbol.asyncIterator]() {
                  while (!signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
                },
              },
            })),
          },
          session: {
            create: vi.fn(),
            prompt: vi.fn(async () => ({ data: { parts: [] } })),
            promptAsync: vi.fn(async () => ({ data: {} })),
            messages: vi.fn(async () => ({ data: [] })),
            abort,
          },
        } as any,
        sessionId: 'session-1',
        fullPrompt: 'go',
        workingDirectory: '/tmp/run-ws',
        emit: () => {},
      })).rejects.toThrow(/未产生任何输出/);
      expect(abort).toHaveBeenCalledWith({ path: { id: 'session-1' }, query: { directory: '/tmp/run-ws' } });
    } finally {
      delete process.env.ACE_OPENCODE_NO_NEW_OUTPUT_GRACE_MS;
    }
  });

  test('gives up on a promptAsync call that never answers instead of waiting forever', async () => {
    const abort = vi.fn(async () => ({ data: true }));
    const prompt = vi.fn(async () => ({ data: { parts: [] } }));
    process.env.ACE_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '1000';
    try {
      await expect(sendPromptWithOpenCodeHttp({
        engineName: 'opencode-http',
        client: {
          event: {
            subscribe: vi.fn(async ({ signal }: { signal?: AbortSignal }) => ({
              stream: {
                async *[Symbol.asyncIterator]() {
                  while (!signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
                },
              },
            })),
          },
          session: {
            create: vi.fn(),
            prompt,
            promptAsync: vi.fn(() => new Promise(() => {})),
            messages: vi.fn(async () => ({ data: [] })),
            abort,
          },
        } as any,
        sessionId: 'session-1',
        fullPrompt: 'go',
        workingDirectory: '/tmp/run-ws',
        emit: () => {},
      })).rejects.toThrow(/idle timed out/);
      expect(abort).toHaveBeenCalledWith({ path: { id: 'session-1' }, query: { directory: '/tmp/run-ws' } });
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      delete process.env.ACE_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
    }
  }, 10_000);

  test('ignores a permission request that an earlier always-approval already resolved', async () => {
    const logs: Array<{ level?: string; message: string }> = [];
    const abort = vi.fn(async () => ({ data: true }));
    const reply = vi.fn(async ({ path }: { path: { permissionID: string } }) => (path.permissionID === 'per-2'
      ? { error: { name: 'NotFoundError', data: { message: 'Permission request not found: per-2' } } }
      : { data: true }));
    const permission = (id: string) => ({
      type: 'permission.asked',
      properties: { id, sessionID: 'session-1', permission: 'external_directory' },
    });
    const output = await sendPromptWithOpenCodeHttp({
      engineName: 'opencode-http',
      client: {
        postSessionIdPermissionsPermissionId: reply,
        event: {
          subscribe: vi.fn(async () => ({
            stream: {
              async *[Symbol.asyncIterator]() {
                await new Promise((resolve) => setTimeout(resolve, 20));
                yield permission('per-1');
                yield permission('per-2');
                await new Promise((resolve) => setTimeout(resolve, 20));
                yield {
                  type: 'message.part.delta',
                  properties: { sessionID: 'session-1', partID: 'new-text', field: 'text', delta: 'read both files' },
                };
                await new Promise((resolve) => setTimeout(resolve, 20));
                yield { type: 'session.idle', properties: { sessionID: 'session-1' } };
              },
            },
          })),
        },
        session: {
          create: vi.fn(),
          prompt: vi.fn(async () => ({ data: { parts: [] } })),
          promptAsync: vi.fn(async () => ({ data: {} })),
          messages: vi.fn(async () => ({
            data: [{ info: { role: 'assistant' }, parts: [{ id: 'new-text', type: 'text', text: 'read both files' }] }],
          })).mockResolvedValueOnce({ data: [] }),
          abort,
        },
      } as any,
      sessionId: 'session-1',
      fullPrompt: 'read references',
      permissionResponse: 'always',
      emit: () => {},
      log: (entry) => logs.push(entry),
    });

    expect(output).toBe('read both files');
    expect(reply).toHaveBeenCalledTimes(2);
    expect(abort).not.toHaveBeenCalled();
    expect(logs.filter((entry) => entry.level === 'error')).toEqual([]);
    expect(logs.map((entry) => entry.message)).toContain('OpenCode permission request already resolved');
  });
});
