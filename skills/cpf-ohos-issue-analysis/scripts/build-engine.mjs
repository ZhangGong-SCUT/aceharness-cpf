#!/usr/bin/env node
/**
 * Flutter OH Engine 构建编排脚本（按 references/engine-build.md 标准路径）。
 *
 * 用法：
 *   node build-engine.mjs --repo <flutter_flutter目录> --check-only   # 仅环境探测，输出缺失项 JSON
 *   node build-engine.mjs --repo <...> --sync                         # cp ohos.gclient + gclient sync
 *   node build-engine.mjs --repo <...> --build --mode release         # ./ohos -t release 构建
 *   node build-engine.mjs --repo <...> --verify --mode release        # 校验产物 libflutter.so / flutter.har
 *   node build-engine.mjs --repo <...>                                # 全流程：check→sync→build→verify
 *
 * 输出：exit 0 且 stdout JSON {ok, stage, ...}；环境缺失 exit 3 且 {ok:false, missing:[...]}。
 * 工作流约定：修复验证阶段先 --check-only；缺失项原样引用进 step-conclusion（禁止不探测就写"环境性未执行"）。
 */
import { execFile, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

/** 本机代理自动探测：环境变量优先，其次探测常见本地代理端口（Clash Verge 7897 等）。
 *  工作流服务进程不带代理环境变量，gclient sync / git 访问 googlesource 必须经代理。 */
function detectProxy() {
  if (process.env.https_proxy || process.env.HTTPS_PROXY) return process.env.https_proxy || process.env.HTTPS_PROXY;
  for (const port of [7897, 7890, 10809, 8118]) {
    const r = spawnSync('bash', ['-c', `echo >/dev/tcp/127.0.0.1/${port}`], { stdio: 'ignore' });
    if (r.status === 0) return `http://127.0.0.1:${port}`;
  }
  return null;
}
const PROXY = detectProxy();
const CHILD_ENV = { ...process.env, ...(PROXY ? { https_proxy: PROXY, http_proxy: PROXY } : {}) };
// depot_tools PATH 回退：服务进程 PATH 不含 depot_tools 时补上
const DEPOT_TOOLS = join(homedir(), 'depot_tools');
if (!process.env.PATH?.includes('depot_tools') && existsSync(DEPOT_TOOLS)) {
  CHILD_ENV.PATH = `${DEPOT_TOOLS}:${process.env.PATH}`;
}
// OHOS 构建工具链（linux-build-env.md 标准环境；缺失项构建时如实报错）
const HARMONY_TOOLS = '/home/flutter/harmony-tools';
const OHOS_BUILD_ENV = {
  PATH: [
    `${HARMONY_TOOLS}/command-line-tools/bin`,
    `${HARMONY_TOOLS}/command-line-tools/tool/node/bin`,
    `${HARMONY_TOOLS}/ohos-sdk/26/toolchains`,
    CHILD_ENV.PATH,
  ].join(':'),
  DEVECO_SDK_HOME: `${HARMONY_TOOLS}/command-line-tools/sdk`,
  OHOS_SDK_HOME: `${HARMONY_TOOLS}/ohos-sdk`,
  NODE_HOME: `${HARMONY_TOOLS}/command-line-tools/tool/node`,
};
const withOhosEnv = (env = CHILD_ENV) => ({ ...env, ...OHOS_BUILD_ENV, PATH: `${OHOS_BUILD_ENV.PATH}` });

const args = process.argv.slice(2);
const arg = (name, def = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const repo = resolve(arg('repo', 'repo'));
const mode = arg('mode', 'release');
const outName = mode === 'debug' ? 'ohos_debug_unopt_arm64' : mode === 'profile' ? 'ohos_profile_arm64' : 'ohos_release_arm64';
const checkOnly = has('check-only');
const doSync = has('sync');
const doBuild = has('build');
const doVerify = has('verify');
const runAll = !checkOnly && !doSync && !doBuild && !doVerify;

const log = (stage, extra = {}) => {
  const line = JSON.stringify({ ok: true, stage, repo, mode, ...extra });
  process.stdout.write(`${line}\n`);
  return JSON.parse(line);
};

function fail(stage, missing, detail) {
  process.stdout.write(`${JSON.stringify({ ok: false, stage, missing, detail }, null, 2)}\n`);
  process.exit(3);
}

/** 探测一个命令是否可用（PATH 查找，不执行） */
function commandExists(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore', env: CHILD_ENV }).status === 0;
}

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((res) => {
    execFile(cmd, cmdArgs, { cwd: opts.cwd || repo, timeout: opts.timeoutMs || 30_000, maxBuffer: 8 * 1024 * 1024, env: opts.env || CHILD_ENV }, (err, stdout, stderr) => {
      res({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '') || (err ? `${err.code || ''} ${err.message || ''}` : ''),
      });
    });
  });
}

/** 指南 §1.2 前置条件 + §2.1 depot_tools + §3 源码同步 + §1.3 网络 */
async function preflight() {
  const missing = [];
  const detail = {};

  // 工具链版本（指南 §1.2）：JDK 17+、Python 3.8–3.11、Node 14.19.1+（低于 17 要求仅作用于构建脚本宿主，探测时记录不阻断）
  const java = await run('java', ['-version']);
  detail.java = (java.stderr || java.stdout).split('\n')[0] || 'missing';
  if (!/version "(\d+)/.test(detail.java) || Number(/version "(\d+)/.exec(detail.java)?.[1] || 0) < 17) missing.push(`JDK 17+（当前: ${detail.java}）`);

  const py = await run('python3', ['--version']);
  detail.python3 = py.stdout.trim() || 'missing';
  const pyv = /Python (\d+)\.(\d+)/.exec(detail.python3);
  if (!pyv || Number(pyv[1]) !== 3 || Number(pyv[2]) < 8 || Number(pyv[2]) > 11) missing.push(`Python 3.8–3.11（当前: ${detail.python3}，3.12 不兼容）`);

  detail.node = process.version;
  if (!commandExists('java')) missing.push('java 命令不可用');
  if (!commandExists('python3')) missing.push('python3 命令不可用');
  if (!commandExists('ninja') && !commandExists('ninja-build')) missing.push('ninja 未安装（apt install ninja-build）');

  // depot_tools（gclient/gn，指南 §2.1）
  detail.gclient = commandExists('gclient');
  detail.gn = commandExists('gn');
  if (!detail.gclient) missing.push('depot_tools 未安装/不在 PATH（gclient 不可用，见 references/engine-build.md §2.1）');
  if (!detail.gn) missing.push('gn 不在 PATH（随 depot_tools 提供）');

  // 引擎源码（flutter_flutter checkout + DEPS_ohos + 同步状态）
  if (!existsSync(repo)) {
    missing.push(`flutter_flutter 源码目录不存在: ${repo}`);
    return { missing, detail };
  }
  const depsPath = join(repo, 'DEPS_ohos');
  if (!existsSync(depsPath)) missing.push(`DEPS_ohos 缺失（${depsPath}）——非 flutter_flutter 完整 checkout`);
  const gclientTpl = join(repo, 'engine', 'scripts', 'ohos.gclient');
  if (!existsSync(gclientTpl)) missing.push(`engine/scripts/ohos.gclient 模板缺失（${gclientTpl}）`);

  // 源码同步状态：指南 gclient sync 后依赖齐备；粗判 third_party 子目录数（实际布局 engine/src/flutter/third_party）
  const tp = join(repo, 'engine', 'src', 'flutter', 'third_party');
  let tpCount = 0;
  try { tpCount = readdirSync(tp).length; } catch { /* 未同步 */ }
  detail.third_party_subdirs = tpCount;
  if (tpCount < 20) missing.push(`引擎源码未同步（src/flutter/third_party 仅 ${tpCount} 个子目录，需 gclient sync，约 30–60 分钟）`);

  // 磁盘（指南 §1.2：预留 50GB+）
  try {
    const df = execFileSync('sh', ['-c', `df -BG --output=avail ${repo} | tail -1`], { encoding: 'utf8' }).trim();
    const availGb = Number((/(\d+)G/.exec(df) || [])[1] || 0);
    detail.disk_avail_gb = availGb;
    if (availGb < 50) missing.push(`磁盘空间不足（建议 50GB+，当前 ${availGb}GB）`);
  } catch { /* df 失败不阻断 */ }

  // 网络（指南 §1.3 / DEPS_ohos allowed_hosts）：逐域探测，3s 超时
  let hosts = [];
  try {
    const deps = readFileSync(depsPath, 'utf8');
    hosts = [...new Set((deps.match(/https:\/\/([a-z0-9.-]+)/g) || []).map((u) => u.replace('https://', '')))].slice(0, 20);
  } catch { /* 无 DEPS 时用指南静态清单 */ }
  if (!hosts.length) hosts = ['chromium.googlesource.com', 'flutter.googlesource.com', 'skia.googlesource.com', 'llvm.googlesource.com', 'github.com', 'gitcode.com'];
  const unreachable = [];
  for (const h of hosts) {
    const r = await run('curl', ['-s', '-o', '/dev/null', '-m', '3', `https://${h}`], { timeoutMs: 5000 });
    if (r.code !== 0 && r.code !== 22) unreachable.push(h); // 22=HTTP错误码也算可达(域名通)
  }
  detail.allowed_hosts = hosts;
  detail.unreachable_hosts = unreachable;
  detail.proxy = PROXY || 'none';
  if (unreachable.length) missing.push(`网络不可达（需代理，指南 §1.3）：${unreachable.join('、')}${PROXY ? '' : '（未检测到本地代理）'}`);

  return { missing, detail };
}

async function sync() {
  const tpl = join(repo, 'engine', 'scripts', 'ohos.gclient');
  const dst = join(repo, '.gclient');
  if (!existsSync(dst)) copyFileSync(tpl, dst);
  log('sync.start', { note: 'gclient sync 约 30–60 分钟，超时/失败可重跑' });
  const r = await run('gclient', ['sync'], { timeoutMs: 90 * 60_000 });
  if (!r.ok) fail('sync', [], `gclient sync 失败: ${(r.stderr || r.stdout).slice(-500)}（指南 §7.1 排查）`);
  return log('sync.done');
}

async function build() {
  log('build.start', { cmd: `cd engine && ./ohos -t ${mode} --unuse-bisheng` });
  const buildStartTs = Date.now();
  // 预补丁 HAR 源模板：ohos.py 每次运行会重新复制 embedding 工程到 out 目录，
  // 生成物里的补丁活不过一次构建——必须改源模板（本机 SDK 为 ohos-sdk/26/OpenHarmony，
  // 与模板的 5.0.0(12)/HarmonyOS 不匹配，hvigor 会报 SDK component missing 并令 ninja 提前停止，
  // 导致 libflutter.so 不重链、交付陈旧产物）。git checkout 还原后由本函数下次重新打上（幂等）。
  const embeddingDir = join(repo, 'engine', 'src', 'flutter', 'shell', 'platform', 'ohos', 'flutter_embedding');
  const embeddingProfile = join(embeddingDir, 'build-profile.json5');
  try {
    let tpl = readFileSync(embeddingProfile, 'utf8');
    const patched = tpl
      .replace(/"compatibleSdkVersion":\s*"5\.0\.0\(12\)"/g, '"compatibleSdkVersion": 26')
      .replace(/"targetSdkVersion":\s*"5\.0\.0\(12\)"/g, '"targetSdkVersion": 26')
      .replace('"runtimeOS": "HarmonyOS"', '"runtimeOS": "OpenHarmony"')
      .replace('"compatibleSdkVersion": 26,', '"compatibleSdkVersion": 26,\n        "compileSdkVersion": 26,');
    if (patched !== tpl) {
      writeFileSync(embeddingProfile, patched, 'utf8');
    }
    // local.properties：ohos_create_flutter_har.py 每次 copytree 再生构建目录（旧补丁会被清掉），
    // 放源目录才能随再生传播；hvigor 由此找到 ohos-sdk
    writeFileSync(join(embeddingDir, 'local.properties'), `sdk.dir=${HARMONY_TOOLS}/ohos-sdk\n`, 'utf8');
    log('build.har-template-patch', { note: 'embedding 源模板已适配 ohos-sdk/26（profile 26/OpenHarmony + local.properties）' });
  } catch (e) {
    fail('build.har-template-patch', [], `读/写 HAR 源模板失败: ${e.message}`);
  }
  // --unuse-bisheng：本机无 BiSheng 编译器（hms/native/BiSheng 缺失），用 SDK 自带 llvm clang
  const r = await run('./ohos', ['-t', mode, '--unuse-bisheng'], { cwd: join(repo, 'engine'), timeoutMs: 150 * 60_000, env: withOhosEnv() });
  const outDir = join(repo, 'engine', 'src', 'out', outName);
  const soPath = join(outDir, 'libflutter.so');
  const soOk = existsSync(soPath);
  const harOk = existsSync(join(outDir, 'flutter.har'));
  // 新鲜度校验：libflutter.so 的 mtime 必须晚于本次构建开始——防止 ninja 中途失败时
  // 把上一轮的陈旧 so 当成本轮产物（补丁没编进去却报成功）
  const soFresh = soOk && statSync(soPath).mtimeMs > buildStartTs - 5_000;
  if (!soFresh) {
    // 无源码改动的纯校验轮：so 不重链是正确的（ninja no-op 或仅 HAR 步骤失败）。
    // 有 .cpp/.h 比 so 新却没重链 → 补丁未编入，必须报错防交付陈旧产物。
    const flutterSrcDir = join(repo, 'engine', 'src', 'flutter');
    const newer = spawnSync('find', [flutterSrcDir, '-newer', soPath, '(', '-name', '*.cpp', '-o', '-name', '*.cc', '-o', '-name', '*.h', ')'], { encoding: 'utf8' });
    const dirtySources = String(newer.stdout || '').trim().split('\n').filter((l) => l && !l.includes('flutter_embedding'));
    if (dirtySources.length) {
      fail('build', [
        `libflutter.so 未重链但源码有改动（${dirtySources.length} 个文件新于产物，前 3：${dirtySources.slice(0, 3).map((s) => s.replace(flutterSrcDir, '')).join('、')}）——补丁未编入，产物陈旧`,
      ], `./ohos 输出尾部: ${(r.stderr || r.stdout).slice(-400)}`);
    }
    log('build.noop', { note: '无源码改动，libflutter.so 保持现物' });
  }
  // HAR 兜底：ninja 的 flutter_embedding_release.har 步骤用 hvigor 编 ArkTS embedding，
  // 生成目录的 build-profile 默认 5.0.0(12)/HarmonyOS——本机只有 ohos-sdk/26（OpenHarmony API 26）。
  // 产物 libflutter.so 已成时，补丁 profile 为 26/OpenHarmony（demo 工程同款配置）后手动编 HAR。
  if (!harOk) {
    log('build.har-rescue', { note: 'libflutter.so 已产出，HAR 走 26/OpenHarmony 兜底' });
    const harDir = join(outDir, 'obj', 'ohos', 'flutter_embedding_har');
    const bp = join(harDir, 'build-profile.json5');
    try {
      let profile = readFileSync(bp, 'utf8');
      profile = profile
        .replace(/"compatibleSdkVersion":\s*"5\.0\.0\(12\)"/g, '"compatibleSdkVersion": 26')
        .replace(/"targetSdkVersion":\s*"5\.0\.0\(12\)"/g, '"targetSdkVersion": 26')
        .replace('"runtimeOS": "HarmonyOS"', '"runtimeOS": "OpenHarmony"');
      if (!profile.includes('"compileSdkVersion"')) {
        profile = profile.replace('"compatibleSdkVersion": 26,', '"compatibleSdkVersion": 26,\n        "compileSdkVersion": 26,');
      }
      writeFileSync(bp, profile, 'utf8');
      writeFileSync(join(harDir, 'local.properties'), `sdk.dir=${HARMONY_TOOLS}/ohos-sdk\n`, 'utf8');
    } catch (e) {
      fail('build.har-rescue', [], `HAR build-profile 补丁失败: ${e.message}`);
    }
    const hv = await run('hvigorw', ['clean', '--mode', 'module', '-p', 'module=flutter@default', '-p', 'product=default', `-p`, `buildMode=${mode}`, 'assembleHar', '--no-daemon'], { cwd: harDir, timeoutMs: 30 * 60_000, env: withOhosEnv() });
    const produced = [join(harDir, 'flutter', 'build', 'default', 'outputs', 'default', 'flutter.har')].find(existsSync);
    if (!hv.ok || !produced) {
      fail('build.har-rescue', [], `hvigor 编 HAR 失败: ${(hv.stderr || hv.stdout).slice(-400)}`);
    }
    copyFileSync(produced, join(outDir, 'flutter.har'));
  }
  // HAR 内打包了 libflutter.so（--native_lib）：so 重链后必须同步刷新顶层 flutter.har，
  // 否则顶层是旧 HAR（内含旧 so），后续盖 SDK cache / flutter build hap 会用回旧引擎
  const producedHar = join(outDir, 'obj', 'ohos', 'flutter_embedding_har', 'flutter', 'build', 'default', 'outputs', 'default', 'flutter.har');
  if (existsSync(producedHar)) {
    copyFileSync(producedHar, join(outDir, 'flutter.har'));
  }
  return log('build.done', { libflutter_so: true, libflutter_so_fresh: true, flutter_har: existsSync(join(outDir, 'flutter.har')) });
}

async function verify() {
  const outDir = join(repo, 'engine', 'src', 'out');
  const target = join(outDir, outName);
  const artifacts = {};
  for (const f of ['libflutter.so', 'flutter.har']) {
    const p = join(target, f);
    artifacts[f] = existsSync(p);
  }
  const ok = Object.values(artifacts).every(Boolean);
  if (!ok) {
    // 指南 §4.2：以实际生成目录为准，列出 out/ 下实际目录辅助排查
    let actual = [];
    try { actual = readdirSync(outDir); } catch { /* 无 out */ }
    fail('verify', [`产物不完整（期望 src/out/${outName}/ 含 ${Object.keys(artifacts).join('、')}）`], `out/ 实际目录: ${actual.join(', ') || '无'}`);
  }
  return log('verify.done', { artifacts: `engine/src/out/${outName}/{libflutter.so,flutter.har}`, outName });
}

async function main() {
  if (checkOnly) {
    const { missing, detail } = await preflight();
    if (missing.length) fail('check', missing, detail);
    return log('check', { ...detail, conclusion: '环境满足，可按 references/engine-build.md 构建' });
  }
  const { missing, detail } = await preflight();
  // 网络不可达仅在「源码尚未同步」时才是阻断项（已同步过的树可离线重编）
  const synced = Number(detail.third_party_subdirs || 0) >= 20;
  const blocking = synced ? missing.filter((m) => !m.startsWith('网络不可达')) : missing;
  if (blocking.length) fail('check', blocking, '构建前置条件缺失（--check-only 可单独探测）');
  if (doSync || runAll) await sync();
  if (doBuild || runAll) await build();
  if (doVerify || runAll) await verify();
  log('all.done', {
    localEngine: outName,
    localEngineHost: mode === 'debug' ? 'host_debug_unopt' : `host_${mode}`,
    useHint: `flutter build hap --target-platform ohos-arm64 --${mode} --local-engine=${outName} --local-engine-host=${mode === 'debug' ? 'host_debug_unopt' : `host_${mode}`}`,
  });
}

main().catch((e) => fail('unexpected', [], e?.stack || String(e)));
