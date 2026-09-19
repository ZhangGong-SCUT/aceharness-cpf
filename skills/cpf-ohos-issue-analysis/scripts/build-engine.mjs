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
import { existsSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

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
  return spawnSync('sh', ['-c', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((res) => {
    execFile(cmd, cmdArgs, { cwd: opts.cwd || repo, timeout: opts.timeoutMs || 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
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

  // 源码同步状态：指南 gclient sync 后 engine/src 及 third_party 完整；粗判 third_party 子目录数
  const tp = join(repo, 'src', 'flutter', 'third_party');
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
  if (unreachable.length) missing.push(`网络不可达（需代理，指南 §1.3）：${unreachable.join('、')}`);

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
  log('build.start', { cmd: `./ohos -t ${mode}` });
  const r = await run('./ohos', ['-t', mode], { timeoutMs: 150 * 60_000 });
  if (!r.ok) fail('build', [], `./ohos -t ${mode} 失败: ${(r.stderr || r.stdout).slice(-500)}`);
  return log('build.done');
}

async function verify() {
  const outDir = join(repo, 'src', 'out');
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
  return log('verify.done', { artifacts: `src/out/${outName}/{libflutter.so,flutter.har}`, outName });
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
