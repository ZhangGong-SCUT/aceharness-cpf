import { describe, expect, it } from 'vitest';
import { resolveRunEngineDirectory } from '../src/lib/workflow/run-engine-directory';

describe('resolveRunEngineDirectory', () => {
  it('隔离目录优先于配置里的 _template', () => {
    const dir = resolveRunEngineDirectory({
      isolatedDir: '/tmp/run-workspaces/run-1',
      projectRoot: '_template',
      personalDir: '/tmp/personal',
      workspaceRoot: '/tmp/workspace',
    });
    expect(dir).toBe('/tmp/run-workspaces/run-1');
  });

  it('没有隔离目录时才解析模板相对路径', () => {
    const dir = resolveRunEngineDirectory({
      projectRoot: '_template',
      personalDir: '/tmp/personal',
      workspaceRoot: '/tmp/workspace',
    });
    expect(dir).toBe('/tmp/personal/_template');
  });
});
