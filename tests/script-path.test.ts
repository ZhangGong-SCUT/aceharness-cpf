import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { isDirectRun, siblingScript } from '../skills/gitcode-pr-review/scripts/script-path.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const scripts = fileURLToPath(new URL('../skills/gitcode-pr-review/scripts/', import.meta.url));
const gatesUrl = pathToFileURL(`${scripts}check-pr-gates.mjs`).href;
const tmpRoots: string[] = [];

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(`${tmpdir()}/script-path-`);
  tmpRoots.push(dir);
  return dir;
}

function runNode(script: string, args: string[], cwd: string) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (error: any) {
    return { status: error.status ?? 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') };
  }
}

describe('Windows import.meta.url 路径', () => {
  test('URL.pathname 在另一盘的 cwd 下会被 path.resolve 拼成 E:\\D:', () => {
    const pathname = new URL('file:///D:/ace/skills/gitcode-pr-review/scripts/check-pr-gates.mjs').pathname;
    expect(pathname).toBe('/D:/ace/skills/gitcode-pr-review/scripts/check-pr-gates.mjs');
    expect(win32.resolve('E:\\work\\run', pathname)).toBe('E:\\D:\\ace\\skills\\gitcode-pr-review\\scripts\\check-pr-gates.mjs');
    expect(win32.resolve('E:\\work\\run', 'D:\\ace\\skills\\gitcode-pr-review\\scripts\\check-pr-gates.mjs'))
      .toBe('D:\\ace\\skills\\gitcode-pr-review\\scripts\\check-pr-gates.mjs');
  });

  test('同目录脚本不会因为 ../ 多退一层', () => {
    expect(siblingScript(gatesUrl, 'fetch-dcp-report.mjs')).toBe(`${scripts}fetch-dcp-report.mjs`);
    expect(siblingScript(gatesUrl, 'fetch-gate-logs.mjs')).toBe(`${scripts}fetch-gate-logs.mjs`);
    expect(existsSync(siblingScript(gatesUrl, 'fetch-dcp-report.mjs'))).toBe(true);
    expect(existsSync(siblingScript(gatesUrl, 'fetch-gate-logs.mjs'))).toBe(true);
  });

  test('被 vitest 导入时不是直接运行', () => {
    expect(isDirectRun(gatesUrl)).toBe(false);
  });

  test('工作目录不在脚本所在盘时，直接运行仍进入 main', () => {
    const cwd = tempDir();
    const missing = [
      'check-pr-gates.mjs',
      'fetch-ai-review.mjs',
      'find-sibling-prs.mjs',
      'scan-same-rule-defects.mjs',
    ];
    for (const name of missing) {
      const result = runNode(`${scripts}${name}`, [], cwd);
      expect(result.status, name).not.toBe(0);
      expect(result.stderr, name).toContain('缺少');
      expect(result.stdout, name).not.toContain('GitCode 数据读取失败');
    }
    const out = tempDir();
    const logs = runNode(`${scripts}fetch-gate-logs.mjs`, ['--out', out], cwd);
    expect(logs.status).toBe(0);
    const analysis = JSON.parse(readFileSync(`${out}/gate-log-analysis.json`, 'utf8'));
    expect(analysis.build.reason).toBe('no_build_log_url');
  });

  test('经符号链接调用 check-pr-gates 仍进入 main', () => {
    const dir = tempDir();
    const link = `${dir}/check-pr-gates.mjs`;
    symlinkSync(`${scripts}check-pr-gates.mjs`, link);
    const result = runNode(link, [], dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('缺少');
  });

  test('这些脚本不再用 URL.pathname 解析自身路径', () => {
    const files = [
      'skills/gitcode-pr-review/scripts/check-pr-gates.mjs',
      'skills/gitcode-pr-review/scripts/fetch-ai-review.mjs',
      'skills/gitcode-pr-review/scripts/fetch-gate-logs.mjs',
      'skills/gitcode-pr-review/scripts/find-sibling-prs.mjs',
      'skills/gitcode-pr-review/scripts/scan-same-rule-defects.mjs',
      'scripts/ohos-har-install.mjs',
    ];
    for (const file of files) {
      expect(readFileSync(`${root}${file}`, 'utf8'), file).not.toContain('import.meta.url).pathname');
    }
    expect(readFileSync(`${root}skills/gitcode-pr-review/scripts/script-path.mjs`, 'utf8')).toContain('fileURLToPath');
    expect(readFileSync(`${root}scripts/ohos-har-install.mjs`, 'utf8')).toContain('fileURLToPath');
  });
});
