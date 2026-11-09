/**
 * 编 HAP 用的 JDK 与鸿蒙命令行 SDK。macOS、Linux、Windows 都查。
 * JAVA_HOME、OHOS_SDK_HOME、HOS_SDK_HOME、DEVECO_SDK_HOME 一旦设置就只认它。
 */
import path from 'node:path';

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function trimPath(value) {
  const text = String(value || '').trim();
  const stripped = text.replace(/[\\/]+$/, '');
  return stripped.length >= 2 ? stripped : text;
}

function javaBinaryName(platform) {
  return platform === 'win32' ? 'java.exe' : 'java';
}

export function javaHomeCandidates(platform, env = {}, home = '') {
  const p = pathApi(platform);
  const list = [];
  const push = (source, value) => {
    const text = trimPath(value);
    if (!text) return;
    if (list.some((item) => item.path.toLowerCase() === text.toLowerCase())) return;
    list.push({ source, path: text });
  };
  push('JAVA_HOME', env.JAVA_HOME);
  if (!trimPath(env.JAVA_HOME)) {
    if (home) {
      push('default', p.join(home, 'jdk-17'));
      push('default', p.join(home, 'Android', 'jdk-17'));
    }
    if (platform === 'darwin') push('default', '/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home');
    if (platform === 'win32') {
      const local = trimPath(env.LOCALAPPDATA) || (home ? p.join(home, 'AppData', 'Local') : '');
      if (local) push('default', p.join(local, 'Huawei', 'DevEco Studio', 'jbr'));
    }
  }
  return list;
}

export function javaMajor(releaseText) {
  const match = String(releaseText || '').match(/JAVA_VERSION="(\d+)/);
  return match ? Number(match[1]) : null;
}

function javaFix(platform, homePath) {
  if (platform === 'win32') {
    return `安装 JDK 17，并设置 JAVA_HOME。确认 ${homePath || '%JAVA_HOME%'}\\bin\\java.exe 存在`;
  }
  const shown = homePath || '$JAVA_HOME';
  return `安装 JDK 17，并执行 export JAVA_HOME="${shown}"`;
}

/**
 * @returns {{ok:boolean, warning:boolean, detail:string, fix:string}}
 */
export function inspectJavaHome({ platform, env = {}, home = '', exists, readText = () => '' }) {
  const p = pathApi(platform);
  const candidates = javaHomeCandidates(platform, env, home);
  const envLocked = Boolean(trimPath(env.JAVA_HOME));
  const looked = envLocked ? candidates.filter((item) => item.source === 'JAVA_HOME') : candidates.filter((item) => item.source !== 'JAVA_HOME');
  const found = looked.find((item) => exists(p.join(item.path, 'bin', javaBinaryName(platform))));
  if (!found) {
    const places = looked.map((item) => item.path).join(', ') || '（没有 JAVA_HOME）';
    return {
      ok: false,
      warning: true,
      detail: envLocked ? `JAVA_HOME 指向的目录没有 ${javaBinaryName(platform)}: ${places}` : `未找到 JDK 17。已查找: ${places}`,
      fix: javaFix(platform, looked[0]?.path || ''),
    };
  }
  const major = javaMajor(readText(p.join(found.path, 'release')));
  if (major && major !== 17) {
    const binary = platform === 'win32' ? 'bin\\java.exe' : 'bin/java';
    return {
      ok: false,
      warning: true,
      detail: `${found.source} ${found.path} 是 JDK ${major}。hvigor 需要 JDK 17`,
      fix: platform === 'win32'
        ? `安装 JDK 17，把 JAVA_HOME 改到该目录，并确认 ${binary} 存在`
        : '安装 JDK 17，并执行 export JAVA_HOME="<JDK 17 目录>"',
    };
  }
  if (!envLocked) {
    return {
      ok: false,
      warning: true,
      detail: `JDK 在 ${found.path}。编 HAP 读取 JAVA_HOME，当前没有设置`,
      fix: javaFix(platform, found.path),
    };
  }
  return {
    ok: true,
    warning: false,
    detail: `JDK ${major || '17'}（JAVA_HOME）：${found.path}`,
    fix: '',
  };
}

export function ohosSdkCandidates(platform, env = {}, home = '') {
  const p = pathApi(platform);
  const list = [];
  const push = (source, value) => {
    const text = trimPath(value);
    if (!text) return;
    if (list.some((item) => item.path.toLowerCase() === text.toLowerCase())) return;
    list.push({ source, path: text });
  };
  push('OHOS_SDK_HOME', env.OHOS_SDK_HOME);
  push('HOS_SDK_HOME', env.HOS_SDK_HOME);
  push('DEVECO_SDK_HOME', env.DEVECO_SDK_HOME);
  const locked = trimPath(env.OHOS_SDK_HOME) || trimPath(env.HOS_SDK_HOME) || trimPath(env.DEVECO_SDK_HOME);
  if (!locked) {
    if (home) {
      push('default', p.join(home, 'harmony-tools', 'ohos-sdk'));
      push('default', p.join(home, 'harmony-tools', 'command-line-tools', 'sdk'));
    }
    if (platform === 'darwin') push('default', '/Applications/DevEco-Studio.app/Contents/sdk');
    if (platform === 'win32') {
      const local = trimPath(env.LOCALAPPDATA) || (home ? p.join(home, 'AppData', 'Local') : '');
      if (local) push('default', p.join(local, 'OpenHarmony', 'Sdk'));
    }
  }
  return list;
}

function toolFile(platform, dir, tool, exists) {
  const p = pathApi(platform);
  const names = platform === 'win32' ? [`${tool}.bat`, `${tool}.cmd`, `${tool}.exe`, tool] : [tool];
  for (const name of names) {
    const file = p.join(dir, name);
    if (exists(file)) return file;
  }
  return '';
}

export function commandToolBesideSdk(platform, sdkRoot, tool, exists) {
  const p = pathApi(platform);
  const parent = p.dirname(sdkRoot);
  const dirs = [
    p.join(parent, 'bin'),
    p.join(parent, 'tools', tool === 'ohpm' ? 'ohpm' : 'hvigor', 'bin'),
    p.join(parent, 'command-line-tools', 'bin'),
  ];
  for (const dir of dirs) {
    const file = toolFile(platform, dir, tool, exists);
    if (file) return file;
  }
  return '';
}

function sdkFix(platform, sdkPath) {
  const shown = sdkPath || (platform === 'win32' ? '%OHOS_SDK_HOME%' : '$OHOS_SDK_HOME');
  if (platform === 'win32') {
    return `安装 DevEco 命令行工具，设置 OHOS_SDK_HOME（或 HOS_SDK_HOME）为 ${shown}，并把 hvigorw.bat 和 ohpm.bat 加入 PATH`;
  }
  return `安装 DevEco 命令行工具，并执行 export OHOS_SDK_HOME="${shown}" HOS_SDK_HOME="${shown}"。把 hvigorw 和 ohpm 加入 PATH`;
}

/**
 * @returns {{ok:boolean, warning:boolean, detail:string, fix:string}}
 */
export function inspectOhosCommandLineSdk({ platform, env = {}, home = '', exists, findOnPath = () => '' }) {
  const lockedName = trimPath(env.OHOS_SDK_HOME) ? 'OHOS_SDK_HOME'
    : (trimPath(env.HOS_SDK_HOME) ? 'HOS_SDK_HOME'
      : (trimPath(env.DEVECO_SDK_HOME) ? 'DEVECO_SDK_HOME' : ''));
  const candidates = ohosSdkCandidates(platform, env, home);
  const looked = lockedName
    ? candidates.filter((item) => item.source === lockedName)
    : candidates.filter((item) => item.source === 'default');
  const found = looked.find((item) => exists(item.path));
  if (!found) {
    const places = looked.map((item) => item.path).join(', ') || '（没有可用的查找位置）';
    return {
      ok: false,
      warning: true,
      detail: lockedName ? `${lockedName} 指向的目录不存在: ${places}` : `未找到鸿蒙命令行 SDK。已查找: ${places}`,
      fix: sdkFix(platform, looked[0]?.path || ''),
    };
  }
  const missing = ['hvigorw', 'ohpm'].filter((tool) => !findOnPath(tool) && !commandToolBesideSdk(platform, found.path, tool, exists));
  if (missing.length) {
    return {
      ok: false,
      warning: true,
      detail: `SDK 在 ${found.path}（${found.source}），缺少 ${missing.join('、')}`,
      fix: sdkFix(platform, found.path),
    };
  }
  if (!lockedName) {
    return {
      ok: false,
      warning: true,
      detail: `SDK 在 ${found.path}。flutter build hap 读取 OHOS_SDK_HOME 或 HOS_SDK_HOME，当前都没有设置`,
      fix: sdkFix(platform, found.path),
    };
  }
  return {
    ok: true,
    warning: false,
    detail: `SDK ${found.path}（${found.source}），hvigorw 与 ohpm 都在`,
    fix: '',
  };
}
