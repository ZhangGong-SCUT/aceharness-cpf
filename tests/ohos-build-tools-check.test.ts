import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { inspectJavaHome, inspectOhosCommandLineSdk, javaMajor } from '../scripts/ohos-build-tools-check.mjs';

const doctor = readFileSync(fileURLToPath(new URL('../scripts/ace-doctor.mjs', import.meta.url)), 'utf8');

function filesOf(paths: string[]) {
  const known = new Set(paths);
  return (file: string) => known.has(file);
}

describe('编 HAP 的 JDK 与命令行 SDK', () => {
  test('ace doctor 在三个系统上都会检查这两项', () => {
    expect(doctor).toContain('checkJavaHome();');
    expect(doctor).toContain('checkOhosCommandLineSdk();');
    expect(doctor).not.toMatch(/if\s*\(\s*IS_WIN\s*\)[\s\S]{0,120}checkJavaHome/);
    expect(doctor).not.toMatch(/if\s*\(\s*process\.platform\s*===\s*['"]darwin['"]\s*\)[\s\S]{0,120}checkOhosCommandLineSdk/);
  });

  test('Windows、macOS、Linux 的 JAVA_HOME 都要有 java 可执行文件', () => {
    const cases = [
      { platform: 'win32' as const, home: 'C:\\Java\\jdk-17', binary: win32.join('C:\\Java\\jdk-17', 'bin', 'java.exe') },
      { platform: 'darwin' as const, home: '/Library/Java/jdk-17', binary: posix.join('/Library/Java/jdk-17', 'bin', 'java') },
      { platform: 'linux' as const, home: '/home/flutter/Android/jdk-17', binary: posix.join('/home/flutter/Android/jdk-17', 'bin', 'java') },
    ];
    for (const item of cases) {
      const release = item.platform === 'win32'
        ? win32.join(item.home, 'release')
        : posix.join(item.home, 'release');
      const result = inspectJavaHome({
        platform: item.platform,
        env: { JAVA_HOME: item.home },
        home: item.platform === 'win32' ? 'C:\\Users\\me' : '/home/flutter',
        exists: filesOf([item.binary, release]),
        readText: (file) => (file === release ? 'JAVA_VERSION="17.0.12"\n' : ''),
      });
      expect(result.ok, item.platform).toBe(true);
      expect(result.detail, item.platform).toContain(item.home);
    }
    expect(javaMajor('JAVA_VERSION="17.0.12"\n')).toBe(17);
  });

  test('macOS 找到 DevEco JBR 但没设 JAVA_HOME 时给出 export', () => {
    const home = '/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home';
    const result = inspectJavaHome({
      platform: 'darwin',
      env: {},
      home: '/Users/me',
      exists: filesOf([posix.join(home, 'bin', 'java'), posix.join(home, 'release')]),
      readText: () => 'JAVA_VERSION="17.0.9"\n',
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.fix).toContain(`JAVA_HOME="${home}"`);
  });

  test('JDK 25 只告警，修复命令不指回当前目录', () => {
    const home = '/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home';
    const result = inspectJavaHome({
      platform: 'darwin',
      env: { JAVA_HOME: home },
      home: '/Users/me',
      exists: filesOf([posix.join(home, 'bin', 'java'), posix.join(home, 'release')]),
      readText: () => 'JAVA_VERSION="25.0.1"\n',
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.detail).toContain('JDK 25');
    expect(result.fix).toContain('JDK 17');
    expect(result.fix).not.toContain(home);
  });

  test('Linux 的 JAVA_HOME 无效时不改用 ~/jdk-17', () => {
    const fallback = '/home/flutter/jdk-17/bin/java';
    const result = inspectJavaHome({
      platform: 'linux',
      env: { JAVA_HOME: '/opt/missing-jdk' },
      home: '/home/flutter',
      exists: filesOf([fallback]),
      readText: () => '',
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('/opt/missing-jdk');
    expect(result.detail).not.toContain('/home/flutter/jdk-17');
  });

  test('三个系统都能认出 SDK 目录和 hvigorw、ohpm', () => {
    const cases = [
      { platform: 'win32' as const, sdk: 'D:\\OpenHarmony\\Sdk', hvigor: 'D:\\command-line-tools\\bin\\hvigorw.bat', ohpm: 'D:\\command-line-tools\\bin\\ohpm.bat' },
      { platform: 'darwin' as const, sdk: '/Applications/DevEco-Studio.app/Contents/sdk', hvigor: '/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw', ohpm: '/Applications/DevEco-Studio.app/Contents/tools/ohpm/bin/ohpm' },
      { platform: 'linux' as const, sdk: '/home/flutter/harmony-tools/ohos-sdk', hvigor: '/home/flutter/harmony-tools/command-line-tools/bin/hvigorw', ohpm: '/home/flutter/harmony-tools/command-line-tools/bin/ohpm' },
    ];
    for (const item of cases) {
      const onPath = item.platform === 'win32';
      const result = inspectOhosCommandLineSdk({
        platform: item.platform,
        env: { OHOS_SDK_HOME: item.sdk },
        home: item.platform === 'win32' ? 'C:\\Users\\me' : '/home/flutter',
        exists: filesOf(onPath ? [item.sdk] : [item.sdk, item.hvigor, item.ohpm]),
        findOnPath: (tool) => (onPath ? `C:\\bin\\${tool}.bat` : ''),
      });
      expect(result.ok, item.platform).toBe(true);
      expect(result.detail, item.platform).toContain(item.sdk);
    }
  });

  test('Windows 的 HOS_SDK_HOME 不存在时不改用 LocalAppData', () => {
    const fallback = win32.join('C:\\Users\\me\\AppData\\Local', 'OpenHarmony', 'Sdk');
    const result = inspectOhosCommandLineSdk({
      platform: 'win32',
      env: { HOS_SDK_HOME: 'E:\\missing-sdk', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      home: 'C:\\Users\\me',
      exists: filesOf([fallback]),
      findOnPath: () => 'C:\\bin\\hvigorw.bat',
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.detail).toContain('HOS_SDK_HOME');
    expect(result.detail).toContain('E:\\missing-sdk');
    expect(result.detail).not.toContain(fallback);
  });
});
