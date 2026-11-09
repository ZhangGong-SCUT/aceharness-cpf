/**
 * Android SDK 位置检查。复现对照在三个系统上都会用到 adb 和 emulator。
 * 查找顺序与 skills/flutter-issue-demo-reproduction/references/device-emulator-setup.md 一致：
 *   ANDROID_HOME → ANDROID_SDK_ROOT → 各系统默认目录。
 * 环境变量一旦设置就只认它，不再改用默认目录。
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

/** @returns {{source:string, path:string}[]} */
export function androidSdkCandidates(platform, env = {}, home = '') {
  const p = pathApi(platform);
  const list = [];
  const push = (source, value) => {
    const text = trimPath(value);
    if (!text) return;
    if (list.some((item) => item.path.toLowerCase() === text.toLowerCase())) return;
    list.push({ source, path: text });
  };
  push('ANDROID_HOME', env.ANDROID_HOME);
  push('ANDROID_SDK_ROOT', env.ANDROID_SDK_ROOT);
  if (platform === 'win32') {
    const local = trimPath(env.LOCALAPPDATA) || (home ? p.join(home, 'AppData', 'Local') : '');
    if (local) push('LOCALAPPDATA', p.join(local, 'Android', 'Sdk'));
  } else if (platform === 'darwin') {
    if (home) push('default', p.join(home, 'Library', 'Android', 'sdk'));
  } else {
    if (home) {
      push('default', p.join(home, 'Android', 'Sdk'));
      push('default', p.join(home, 'Android'));
    }
  }
  return list;
}

export function androidToolFile(platform, sdkRoot, tool) {
  const p = pathApi(platform);
  const name = platform === 'win32' ? `${tool}.exe` : tool;
  if (tool === 'adb') return p.join(sdkRoot, 'platform-tools', name);
  if (tool === 'emulator') return p.join(sdkRoot, 'emulator', name);
  throw new Error(`未知的 Android 工具: ${tool}`);
}

function missingTools(platform, sdkRoot, exists) {
  return ['adb', 'emulator']
    .map((tool) => androidToolFile(platform, sdkRoot, tool))
    .filter((file) => !exists(file));
}

function selectSdk(candidates, platform, exists) {
  let incomplete = null;
  for (const candidate of candidates) {
    if (!exists(candidate.path)) continue;
    const missing = missingTools(platform, candidate.path, exists);
    if (missing.length === 0) return { found: candidate, missing };
    if (!incomplete) incomplete = { found: candidate, missing };
  }
  return incomplete;
}

function installHint(platform, home) {
  if (platform === 'win32') {
    return '安装 Android Studio，确认 %LOCALAPPDATA%\\Android\\Sdk 下有 platform-tools\\adb.exe 和 emulator\\emulator.exe';
  }
  if (platform === 'darwin') {
    const guess = home ? `${home}/Library/Android/sdk` : '$HOME/Library/Android/sdk';
    return `安装 Android Studio，并执行 export ANDROID_HOME="${guess}" ANDROID_SDK_ROOT="${guess}"`;
  }
  const guess = home ? `${home}/Android/Sdk` : '$HOME/Android/Sdk';
  return `安装 Android Studio，并执行 export ANDROID_HOME="${guess}" ANDROID_SDK_ROOT="${guess}"`;
}

/**
 * @returns {{ok:boolean, warning:boolean, detail:string, fix:string}}
 */
export function inspectAndroidSdk({ platform, env = {}, home = '', exists }) {
  const candidates = androidSdkCandidates(platform, env, home);
  const envName = trimPath(env.ANDROID_HOME) ? 'ANDROID_HOME'
    : (trimPath(env.ANDROID_SDK_ROOT) ? 'ANDROID_SDK_ROOT' : '');
  const looked = envName
    ? candidates.filter((item) => item.source === envName)
    : candidates.filter((item) => item.source !== 'ANDROID_HOME' && item.source !== 'ANDROID_SDK_ROOT');
  const selected = selectSdk(looked, platform, exists);

  if (!selected) {
    const places = looked.map((item) => item.path).join(', ') || '（没有可用的查找位置）';
    return {
      ok: false,
      warning: true,
      detail: envName ? `${envName} 指向的目录不存在: ${places}` : `未找到 Android SDK。已查找: ${places}`,
      fix: installHint(platform, home),
    };
  }

  const { found, missing } = selected;
  if (missing.length) {
    return {
      ok: false,
      warning: true,
      detail: `SDK 在 ${found.path}（${found.source}），缺少 ${missing.join(', ')}`,
      fix: '用 Android Studio 安装 Android SDK Platform-Tools 和 Android Emulator',
    };
  }

  if (!envName && platform !== 'win32') {
    return {
      ok: false,
      warning: true,
      detail: `SDK 在 ${found.path}。复现命令读取 ANDROID_HOME 或 ANDROID_SDK_ROOT，当前都没有设置`,
      fix: `export ANDROID_HOME="${found.path}" ANDROID_SDK_ROOT="${found.path}"`,
    };
  }

  return {
    ok: true,
    warning: false,
    detail: `SDK ${found.path}（${found.source}），adb 与 emulator 都在`,
    fix: '',
  };
}
