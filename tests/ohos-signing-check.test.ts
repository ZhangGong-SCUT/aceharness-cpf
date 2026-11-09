import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { inspectOhosSigning } from '../scripts/ohos-signing-check.mjs';

const doctor = readFileSync(fileURLToPath(new URL('../scripts/ace-doctor.mjs', import.meta.url)), 'utf8');

function filesOf(paths: string[]) {
  const known = new Set(paths);
  const dirs = new Map<string, string[]>();
  for (const file of paths) {
    const dir = file.replace(/[/\\][^/\\]+$/, '');
    const base = file.slice(dir.length + 1);
    if (!base || base === file) continue;
    dirs.set(dir, [...(dirs.get(dir) || []), base]);
  }
  return {
    exists: (file: string) => known.has(file),
    listDir: (dir: string) => dirs.get(dir) || [],
  };
}

describe('OHOS 调试签名检查', () => {
  test('ace doctor 会检查签名，并且不按系统跳过', () => {
    expect(doctor).toContain('checkOhosSigning();');
    expect(doctor).not.toMatch(/if\s*\(\s*IS_WIN\s*\)[\s\S]{0,80}checkOhosSigning/);
  });

  test('Windows、macOS、Linux 都认用户目录下的同一套三文件', () => {
    const cases = [
      { platform: 'win32' as const, home: 'C:\\Users\\me', root: win32.join('C:\\Users\\me', '.ohos', 'config') },
      { platform: 'darwin' as const, home: '/Users/me', root: posix.join('/Users/me', '.ohos', 'config') },
      { platform: 'linux' as const, home: '/home/flutter', root: posix.join('/home/flutter', '.ohos', 'config') },
    ];
    for (const item of cases) {
      const p = item.platform === 'win32' ? win32 : posix;
      const names = ['default_demo.cer', 'default_demo.p12', 'default_demo.p7b'];
      const paths = names.map((name) => p.join(item.root, name));
      const fs = filesOf([...paths, p.join(item.root, 'material')]);
      const result = inspectOhosSigning({
        platform: item.platform,
        env: {},
        home: item.home,
        exists: fs.exists,
        listDir: fs.listDir,
      });
      expect(result.ok, item.platform).toBe(true);
      expect(result.detail, item.platform).toContain(paths[1]);
    }
  });

  test('Linux 的 harmony-signing 目录也能配成可用签名', () => {
    const root = '/home/flutter/harmony-signing/config';
    const paths = ['default_FlutterAbilityDemo.cer', 'default_FlutterAbilityDemo.p12', 'default_FlutterAbilityDemo.p7b']
      .map((name) => posix.join(root, name));
    const fs = filesOf([...paths, posix.join(root, 'material')]);
    const result = inspectOhosSigning({
      platform: 'linux',
      env: {},
      home: '/home/flutter',
      exists: fs.exists,
      listDir: fs.listDir,
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(paths[2]);
  });

  test('没有三份文件时警告 9568320', () => {
    const result = inspectOhosSigning({
      platform: 'win32',
      env: {},
      home: 'D:\\Users\\me',
      exists: () => false,
      listDir: () => [],
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.detail).toContain('9568320');
    expect(result.detail).toContain(win32.join('D:\\Users\\me', '.ohos', 'config'));
  });

  test('环境变量指向缺失文件时不改用默认目录', () => {
    const fallback = posix.join('/Users/me', '.ohos', 'config', 'default_demo.p12');
    const result = inspectOhosSigning({
      platform: 'darwin',
      env: {
        OHOS_CERT_PATH: '/tmp/missing.cer',
        OHOS_PROFILE_PATH: '/tmp/missing.p7b',
        OHOS_STORE_FILE_PATH: '/tmp/missing.p12',
      },
      home: '/Users/me',
      exists: (file) => file === fallback,
      listDir: () => ['default_demo.cer', 'default_demo.p12', 'default_demo.p7b'],
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('/tmp/missing.p12');
    expect(result.detail).not.toContain(fallback);
  });

  test('有三份文件但没有 material 时不能当成可直接签名', () => {
    const root = posix.join('/Users/me', '.ohos', 'config');
    const names = ['default_demo.cer', 'default_demo.p12', 'default_demo.p7b'];
    const fs = filesOf(names.map((name) => posix.join(root, name)));
    const result = inspectOhosSigning({
      platform: 'darwin',
      env: {},
      home: '/Users/me',
      exists: fs.exists,
      listDir: fs.listDir,
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.detail).toContain('material');
  });
});
