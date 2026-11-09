#!/usr/bin/env node
/**
 * ACEHarness 运行时根目录。
 * ACE_HOME 优先；Windows 用 %APPDATA%\ACEHarness；设置了 XDG_DATA_HOME 时用 $XDG_DATA_HOME/aceharness；
 * 否则用 ~/.aceharness。安装脚本、doctor、AIWeb 和技能脚本都走这里。
 */
import { homedir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveRuntimeRoot({ env, platform, home }) {
  const pathApi = platform === 'win32' ? win32 : posix;
  const aceHome = env.ACE_HOME?.trim();
  if (aceHome) return pathApi.resolve(aceHome);
  if (platform === 'win32' && env.APPDATA?.trim()) {
    return pathApi.resolve(env.APPDATA.trim(), 'ACEHarness');
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) return pathApi.resolve(xdgDataHome, 'aceharness');
  return pathApi.join(home, '.aceharness');
}

export function runtimeRoot() {
  return resolveRuntimeRoot({ env: process.env, platform: process.platform, home: homedir() });
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  process.stdout.write(runtimeRoot());
}
