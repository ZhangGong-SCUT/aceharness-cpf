import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyConfiguredEnv } from '@/lib/core/configured-env';
import { mergeProcessPath } from '@/lib/core/process-path';
import { bundledPrWorkflowNeedsRefresh, resolvePrScript } from '@/lib/workflow/pr-identity-step';

const execPath = 'C:\\Program Files\\nodejs\\node.exe';
const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' } as NodeJS.ProcessEnv;

describe('Windows PR 识别环境', () => {
  it('配置里的短 PATH 不会盖掉 node、powershell 和用户目录', () => {
    const merged = mergeProcessPath({
      base: 'D:\\zg\\node;C:\\Windows\\System32',
      configured: 'C:\\Users\\zg2036\\AppData\\Roaming\\npm',
      registry: 'D:\\zg\\tools',
      platform: 'win32',
      execPath,
      env,
    });
    const entries = merged.split(';');
    expect(entries[0]).toBe('C:\\Program Files\\nodejs');
    expect(entries).toContain('C:\\Windows\\System32');
    expect(entries).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
    expect(entries).toContain('C:\\Users\\zg2036\\AppData\\Roaming\\npm');
    expect(entries).toContain('D:\\zg\\node');
    expect(entries).toContain('D:\\zg\\tools');
  });

  it('占位令牌不会进入子进程，作者令牌会保留', () => {
    const result = applyConfiguredEnv(
      { PATH: 'D:\\zg\\node', GITCODE_TOKEN: 'not_defined' },
      {
        PATH: 'C:\\Users\\zg2036\\AppData\\Roaming\\npm',
        GITCODE_TOKEN_author: 'token-value',
      },
      undefined,
      'win32',
      execPath,
      'D:\\zg\\bin',
    );
    expect(result.GITCODE_TOKEN).toBeUndefined();
    expect(result.GITCODE_TOKEN_author).toBe('token-value');
    expect(result.ACE_NODE).toBe(execPath);
    expect(result.PATH).toContain('C:\\Program Files\\nodejs');
    expect(result.PATH).toContain('WindowsPowerShell\\v1.0');
    expect(result.PATH).toContain('D:\\zg\\node');
    expect(result.Path).toBe(result.PATH);
  });

  it('旧的识别配置也会走身份脚本', () => {
    expect(resolvePrScript('gitcode-pr-review.yaml', '识别', {})).toBe('identity');
    expect(resolvePrScript('gitcode-pr-review.yaml', '等待门禁', {})).toBeUndefined();
    expect(resolvePrScript('gitcode-pr-review.yaml', '识别', { prScript: 'gates' })).toBe('gates');
    expect(bundledPrWorkflowNeedsRefresh('task: 从 globalContext 解析字段')).toBe(true);
    expect(bundledPrWorkflowNeedsRefresh('prScript: identity')).toBe(false);
  });

  it('当前工作流写明由引擎执行识别脚本', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const yaml = readFileSync(resolve(root, 'configs/gitcode-pr-review.yaml'), 'utf8');
    expect(yaml).toContain('prScript: identity');
    expect(yaml).toContain('ACE_NODE');
    expect(yaml).toContain('validate-pr-identity.mjs');
  });
});
