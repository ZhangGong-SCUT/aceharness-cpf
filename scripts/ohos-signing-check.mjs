/**
 * OHOS 调试签名检查。真机安装 HAP 需要同一套 .cer、.p12、.p7b。
 * 查找顺序在 macOS、Linux、Windows 上相同：
 *   OHOS_CERT_PATH / OHOS_PROFILE_PATH / OHOS_STORE_FILE_PATH
 *   → ~/.ohos/config（DevEco 自动签名的默认位置）
 *   → ~/harmony-signing/config
 * 三个环境变量只要设置了其中一个，就只认这组路径。
 * 不读取证书和密码内容。
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

export function signingSearchDirs(platform, env = {}, home = '') {
  const p = pathApi(platform);
  const list = [];
  const push = (source, value) => {
    const text = trimPath(value);
    if (!text) return;
    if (list.some((item) => item.path.toLowerCase() === text.toLowerCase())) return;
    list.push({ source, path: text });
  };
  push('OHOS_SIGNING_DIR', env.OHOS_SIGNING_DIR);
  if (home) {
    push('default', p.join(home, '.ohos', 'config'));
    push('default', p.join(home, 'harmony-signing', 'config'));
  }
  return list;
}

function groupedMaterials(names) {
  const groups = new Map();
  for (const name of names || []) {
    const base = String(name || '').split(/[/\\]/).pop();
    const match = /^(.*)\.(cer|p12|p7b)$/i.exec(base);
    if (!match) continue;
    const stem = match[1].toLowerCase();
    const ext = match[2].toLowerCase();
    if (!groups.has(stem)) groups.set(stem, {});
    groups.get(stem)[ext] = base;
  }
  return [...groups.entries()]
    .filter(([, files]) => files.cer && files.p12 && files.p7b)
    .map(([stem, files]) => ({ stem, ...files }));
}

function materialReady(storeFile, env, exists, p) {
  const material = p.join(p.dirname(storeFile), 'material');
  const passwords = Boolean(trimPath(env.OHOS_KEY_PASSWORD) && trimPath(env.OHOS_STORE_PASSWORD));
  return { material, ready: exists(material) || passwords, passwords };
}

function resultForSet(paths, source, env, exists, p) {
  const missing = [paths.cer, paths.p12, paths.p7b].filter((file) => !exists(file));
  if (missing.length) {
    return {
      ok: false,
      warning: true,
      detail: `签名材料不齐，缺少 ${missing.join(', ')}`,
      fix: 'DevEco Studio → Signing Configs → Automatically generate signature，生成 .cer、.p12、.p7b',
    };
  }
  const material = materialReady(paths.p12, env, exists, p);
  if (!material.ready) {
    return {
      ok: false,
      warning: true,
      detail: `已找到 ${paths.cer}、${paths.p12}、${paths.p7b}，缺少同级 material 目录。未签名的 HAP 安装会报 9568320 no signature file`,
      fix: `把 DevEco 的 material 目录放在 ${p.dirname(paths.p12)} 下，或设置 OHOS_KEY_PASSWORD 与 OHOS_STORE_PASSWORD`,
    };
  }
  return {
    ok: true,
    warning: false,
    detail: `调试签名（${source}）：${paths.cer}、${paths.p12}、${paths.p7b}`,
    fix: '',
    paths,
  };
}

/**
 * @returns {{ok:boolean, warning:boolean, detail:string, fix:string, paths?:object}}
 */
export function inspectOhosSigning({ platform, env = {}, home = '', exists, listDir }) {
  const p = pathApi(platform);
  const cert = trimPath(env.OHOS_CERT_PATH);
  const profile = trimPath(env.OHOS_PROFILE_PATH);
  const store = trimPath(env.OHOS_STORE_FILE_PATH);
  if (cert || profile || store) {
    return resultForSet({ cer: cert, p12: store, p7b: profile }, '环境变量', env, exists, p);
  }

  const dirs = signingSearchDirs(platform, env, home);
  let partial = null;
  for (const dir of dirs) {
    const names = listDir(dir.path) || [];
    for (const set of groupedMaterials(names)) {
      const found = resultForSet({
        cer: p.join(dir.path, set.cer),
        p12: p.join(dir.path, set.p12),
        p7b: p.join(dir.path, set.p7b),
      }, dir.source, env, exists, p);
      if (found.ok) return found;
      if (!partial) partial = found;
    }
  }
  if (partial) return partial;
  const places = dirs.map((item) => item.path).join(', ') || '（没有可用的查找位置）';
  return {
    ok: false,
    warning: true,
    detail: `未找到 .cer、.p12、.p7b。已查找: ${places}。未签名的 HAP 安装会报 9568320 no signature file`,
    fix: platform === 'win32'
      ? '在 DevEco Studio 勾选 Automatically generate signature。文件生成在 %USERPROFILE%\\.ohos\\config，material 目录与 .p12 同级'
      : '在 DevEco Studio 勾选 Automatically generate signature。文件生成在 ~/.ohos/config，material 目录与 .p12 同级',
  };
}
