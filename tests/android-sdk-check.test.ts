import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { androidToolFile, inspectAndroidSdk } from '../scripts/android-sdk-check.mjs';

const doctor = readFileSync(fileURLToPath(new URL('../scripts/ace-doctor.mjs', import.meta.url)), 'utf8');

function present(paths: string[]) {
  const known = new Set(paths);
  return (file: string) => known.has(file);
}

function withTools(platform: 'win32' | 'darwin' | 'linux', root: string) {
  return [
    root,
    androidToolFile(platform, root, 'adb'),
    androidToolFile(platform, root, 'emulator'),
  ];
}

describe('Android SDK 检查', () => {
  test('ace doctor 在主流程里调用，不按系统跳过', () => {
    expect(doctor).toContain('checkAndroidSdk();');
    expect(doctor).not.toMatch(/if\s*\(\s*IS_WIN\s*\)[\s\S]{0,80}checkAndroidSdk/);
    expect(doctor).not.toMatch(/process\.platform\s*===\s*['"]darwin['"][\s\S]{0,80}checkAndroidSdk/);
  });

  test('Windows 未设环境变量时使用 LOCALAPPDATA\\Android\\Sdk', () => {
    const root = win32.join('C:\\Users\\me\\AppData\\Local', 'Android', 'Sdk');
    const result = inspectAndroidSdk({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      home: 'C:\\Users\\me',
      exists: present(withTools('win32', root)),
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(root);
    expect(result.detail).toContain('LOCALAPPDATA');
    expect(androidToolFile('win32', root, 'adb')).toBe(win32.join(root, 'platform-tools', 'adb.exe'));
    expect(androidToolFile('win32', root, 'emulator')).toBe(win32.join(root, 'emulator', 'emulator.exe'));
  });

  test('Windows 的 ANDROID_HOME 无效时不改用默认目录', () => {
    const fallback = win32.join('C:\\Users\\me\\AppData\\Local', 'Android', 'Sdk');
    const result = inspectAndroidSdk({
      platform: 'win32',
      env: { ANDROID_HOME: 'D:\\missing-sdk', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      home: 'C:\\Users\\me',
      exists: present(withTools('win32', fallback)),
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.detail).toContain('ANDROID_HOME');
    expect(result.detail).toContain('D:\\missing-sdk');
    expect(result.detail).not.toContain(fallback);
  });

  test('macOS 默认目录齐全但没有环境变量时给出设置命令', () => {
    const root = posix.join('/Users/me', 'Library', 'Android', 'sdk');
    const result = inspectAndroidSdk({
      platform: 'darwin',
      env: {},
      home: '/Users/me',
      exists: present(withTools('darwin', root)),
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.detail).toContain(root);
    expect(result.fix).toContain(`ANDROID_HOME="${root}"`);
    expect(androidToolFile('darwin', root, 'adb')).toBe(posix.join(root, 'platform-tools', 'adb'));
  });

  test('macOS 设置 ANDROID_HOME 且工具齐全时通过', () => {
    const root = '/Users/me/Library/Android/sdk';
    const result = inspectAndroidSdk({
      platform: 'darwin',
      env: { ANDROID_HOME: root },
      home: '/Users/me',
      exists: present(withTools('darwin', root)),
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toBe(false);
    expect(result.detail).toContain('ANDROID_HOME');
  });

  test('Linux 在 ANDROID_HOME 为空时使用 ANDROID_SDK_ROOT', () => {
    const root = '/home/flutter/Android';
    const result = inspectAndroidSdk({
      platform: 'linux',
      env: { ANDROID_HOME: '', ANDROID_SDK_ROOT: root },
      home: '/home/flutter',
      exists: present(withTools('linux', root)),
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('ANDROID_SDK_ROOT');
    expect(result.detail).toContain(root);
  });

  test('Linux 默认目录优先 ~/Android/Sdk，不完整时再看 ~/Android', () => {
    const standard = '/home/flutter/Android/Sdk';
    const custom = '/home/flutter/Android';
    const result = inspectAndroidSdk({
      platform: 'linux',
      env: {},
      home: '/home/flutter',
      exists: present([
        standard,
        androidToolFile('linux', standard, 'adb'),
        custom,
        ...['adb', 'emulator'].map((tool) => androidToolFile('linux', custom, tool)),
      ]),
    });
    expect(result.detail).toContain(custom);
    expect(result.detail).not.toContain(`${standard}。`);
  });

  test('三个系统都报告缺少的 adb 或 emulator', () => {
    const cases = [
      { platform: 'win32' as const, root: 'C:\\Android\\Sdk', home: 'C:\\Users\\me', env: { ANDROID_HOME: 'C:\\Android\\Sdk' } },
      { platform: 'darwin' as const, root: '/Users/me/Library/Android/sdk', home: '/Users/me', env: { ANDROID_HOME: '/Users/me/Library/Android/sdk' } },
      { platform: 'linux' as const, root: '/opt/android', home: '/home/flutter', env: { ANDROID_HOME: '/opt/android' } },
    ];
    for (const item of cases) {
      const result = inspectAndroidSdk({
        platform: item.platform,
        env: item.env,
        home: item.home,
        exists: present([item.root, androidToolFile(item.platform, item.root, 'adb')]),
      });
      expect(result.ok, item.platform).toBe(false);
      expect(result.warning, item.platform).toBe(true);
      expect(result.detail, item.platform).toContain(androidToolFile(item.platform, item.root, 'emulator'));
    }
  });
});
