#!/usr/bin/env node
/**
 * ace-doctor.mjs —— ACEHarness 环境自检（`ace doctor`）
 *
 * 设计借鉴 @ohos-cpf/3rdloop 的 `3rdloop doctor`（见其 lib/doctor.js）：
 *   - 检查项结构 { name, passed, detail, fix, warning }：fix 为不通过时的精确修复命令
 *   - 默认自动修复（--no-fix 关闭）：只补缺失项，永不覆盖用户已有内容
 *   - 凭据只查存在性、不读内容（脱敏）
 *   - 支持 --json 结构化输出，退出码 0=环境就绪 / 1=存在必修复项
 *
 * 通过 bin/ace.js 前置分发，不依赖 dist 构建产物；零第三方依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFile } from 'node:child_process';

// ── argv ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2).filter(a => a !== 'doctor');
const JSON_MODE = argv.includes('--json');
const FIX_MODE = !argv.includes('--no-fix');
const QUIET = argv.includes('-q') || argv.includes('--quiet');

// ── 常量 ─────────────────────────────────────────────────────────────
const INSTALL_ROOT = process.env.ACE_INSTALL_ROOT
  || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOME_DIR = os.homedir();
const RT = path.join(HOME_DIR, '.aceharness');           // 运行时目录
const IS_WIN = process.platform === 'win32';
const RT_DIRS = ['configs', 'skills', 'scripts'];
const KEY_FILES = [
  'configs/cpf-ohos-diagnosis.yaml',
  'configs/ohos-flutter-sdks.yaml',
  'scripts/ohos-hap-build.mjs',
  'scripts/ohos-har-install.mjs',
  'skills/cpf-ohos-issue-analysis/SKILL.md',
];
const SDK_CONF = path.join(RT, 'configs', 'ohos-flutter-sdks.yaml');
const DEFAULT_PORT = Number(process.env.PORT || process.env.ACE_PORT || 3000);

// ── 检查项收集 ────────────────────────────────────────────────────────
/** @type {{group:string,name:string,ok:boolean,warning?:boolean,detail:string,fix?:string}[]} */
const checks = [];
function add(group, name, ok, detail, fix, warning = false) {
  checks.push({ group, name, ok, warning, detail: detail || '', fix: fix || '' });
}

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function sha1(p) { try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } }

/** 在 PATH 中查找可执行文件（跨平台，不经过 shell） */
function findOnPath(bin) {
  const names = IS_WIN ? [bin, `${bin}.exe`, `${bin}.cmd`, `${bin}.bat`] : [bin];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) if (exists(path.join(dir, n))) return path.join(dir, n);
  }
  return null;
}

function execFileText(file, args, timeoutMs) {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ out: `${stdout || ''}${stderr || ''}`, code: err ? (err.code ?? 1) : 0, killed: !!err?.killed });
    });
  });
}

/** 解析 ohos-flutter-sdks.yaml（无 yaml 依赖：只提取 sdkRoot 与各 SDK path，跳过注释行） */
function parseSdkManifest(text) {
  const clean = text.split('\n').filter(l => !/^\s*#/.test(l));
  const sdkRootLine = clean.find(l => /^\s*sdkRoot\s*:/.test(l));
  const sdkRoot = sdkRootLine?.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '') || '';
  const paths = clean.filter(l => /^\s+path\s*:/.test(l))
    .map(l => l.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, ''));
  const count = clean.filter(l => /^\s+-\s+id\s*:/.test(l)).length;
  return { sdkRoot, paths, count };
}

// ── 检查实现 ──────────────────────────────────────────────────────────

function checkPlatform() {
  const v = process.versions.node.split('.').map(Number);
  const ok = v[0] >= 20;
  add('平台', 'Node.js 版本', ok, `v${process.versions.node}（需 >= 20，推荐 22 LTS）`,
    ok ? '' : '升级 Node.js 至 20+（https://nodejs.org）');

  const required = ['dist/cli.js', 'server.js', 'package.json'];
  const missing = required.filter(f => !exists(path.join(INSTALL_ROOT, f)));
  add('平台', '安装完整性', missing.length === 0,
    missing.length ? `安装根缺文件: ${missing.join(', ')}（安装根 ${INSTALL_ROOT}）` : 'dist/、server.js、package.json 齐备',
    missing.length ? '重新执行 npm install -g <tgz>' : '');

  // 构建来源：fork 构建会锁定 ace update（防止误升上游丢失定制工作流）
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'package.json'), 'utf8'));
    const lin = pkg.config?.aceLineage;
    add('平台', '构建来源', true,
      lin ? `fork 构建（${lin}${pkg.config.aceLineageCommit ? `@${pkg.config.aceLineageCommit}` : ''}，v${pkg.version}）— ace update 已锁定，升级请用新 tgz 重装`
          : `上游构建 v${pkg.version} — 注意：ace update 会拉取 registry latest，若此为 fork 部署请勿使用`,
      lin ? '' : '如确需更新：确认 registry 版本含所需工作流后再 ace update', !lin);
  } catch { add('平台', '构建来源', true, '未知（package.json 不可读）', '', true); }
}

function checkRuntime() {
  const autoSynced = [];
  const stillMissing = [];
  for (const d of RT_DIRS) {
    const dst = path.join(RT, d);
    if (isDir(dst)) continue;
    if (FIX_MODE && isDir(path.join(INSTALL_ROOT, d))) {
      try { fs.cpSync(path.join(INSTALL_ROOT, d), dst, { recursive: true }); autoSynced.push(d); }
      catch { stillMissing.push(d); }
    } else stillMissing.push(d);
  }
  add('运行时目录', '~/.aceharness 基础目录', stillMissing.length === 0,
    stillMissing.length ? `缺失: ${stillMissing.join(', ')}`
      : autoSynced.length ? `已自动补齐: ${autoSynced.join(', ')}` : 'configs/、skills/、scripts/ 齐备',
    stillMissing.length ? `mkdir -p ~/.aceharness && cp -r "${INSTALL_ROOT}"/{configs,skills,scripts} ~/.aceharness/` : '');

  const missingKeys = KEY_FILES.filter(f => !exists(path.join(RT, f)));
  add('运行时目录', '关键工作流资产', missingKeys.length === 0,
    missingKeys.length ? `缺失: ${missingKeys.join(', ')}` : 'cpf-ohos-diagnosis.yaml、SDK 清单、HAR/HAP 门禁脚本、cpf skill 齐备',
    missingKeys.length ? `重跑安装脚本，或 cp -r "${INSTALL_ROOT}"/{configs,skills,scripts}/ 内容补全 ~/.aceharness/` : '');

  // scripts 新鲜度：与安装副本比对（不一致只警告+给命令，不自动覆盖本地修改）
  const marker = 'scripts/ohos-hap-build.mjs';
  const pkgCopy = path.join(INSTALL_ROOT, marker);
  const rtCopy = path.join(RT, marker);
  if (!exists(pkgCopy)) {
    add('运行时目录', 'scripts/ 与安装副本一致性', true, '跳过（安装副本无 scripts/，可能为旧打包）', '', true);
  } else if (!exists(rtCopy)) {
    add('运行时目录', 'scripts/ 与安装副本一致性', false, '~/.aceharness/scripts 未同步',
      (IS_WIN ? 'Copy-Item -Recurse "<安装根>\\scripts" "$HOME\\.aceharness\\scripts"'
              : 'cp -r "<安装根>/scripts/." ~/.aceharness/scripts/'));
  } else {
    const same = sha1(pkgCopy) === sha1(rtCopy);
    add('运行时目录', 'scripts/ 与安装副本一致性', same,
      same ? 'ohos-hap-build.mjs 与安装副本一致' : 'ohos-hap-build.mjs 与安装副本不一致（本地可能被修改或安装包已更新）',
      same ? '' : (IS_WIN ? `Copy-Item -Recurse -Force "${INSTALL_ROOT}\\scripts\\*" "$HOME\\.aceharness\\scripts\\"`
                          : `cp -r "${INSTALL_ROOT}/scripts/." ~/.aceharness/scripts/`) + '  （已跳过自动覆盖，尊重本地修改）',
      !same);
  }
}

function checkOhos() {
  if (!exists(SDK_CONF)) {
    add('OHOS 环境', 'Flutter SDK 清单', false, `未找到 ${SDK_CONF}`,
      IS_WIN ? `copy "${INSTALL_ROOT}\\configs\\ohos-flutter-sdks.yaml" "$HOME\\.aceharness\\configs\\"`
             : `cp "${INSTALL_ROOT}/configs/ohos-flutter-sdks.yaml" ~/.aceharness/configs/`);
    return;
  }
  let manifest;
  try { manifest = parseSdkManifest(fs.readFileSync(SDK_CONF, 'utf8')); }
  catch (e) { add('OHOS 环境', 'Flutter SDK 清单', false, `解析失败: ${e.message}`, '检查 YAML 语法或恢复备份'); return; }

  if (manifest.count === 0) {
    add('OHOS 环境', 'Flutter SDK 登记', false, '清单中未登记任何 SDK',
      [
        'rsync -avP <源机>:/home/flutter/flutter-sdks/ ~/flutter-sdks/   （从源机拷贝）',
        'git clone --depth 1 -b dev https://gitcode.com/CPF-Flutter/flutter_flutter.git ~/flutter-sdks/3.44.9-ohos && ~/flutter-sdks/3.44.9-ohos/bin/flutter precache --ohos   （新装单个版本）',
        '装好后编辑 ~/.aceharness/configs/ohos-flutter-sdks.yaml 登记（只登记装好的版本）',
      ].join('\n'));
    return;
  }
  const badPaths = manifest.paths.filter(p => {
    const full = path.isAbsolute(p) ? p : path.join(manifest.sdkRoot || HOME_DIR, p);
    return !exists(path.join(full, 'bin', IS_WIN ? 'flutter.bat' : 'flutter'));
  });
  add('OHOS 环境', `Flutter SDK 登记（${manifest.count} 个版本）`, badPaths.length === 0,
    badPaths.length ? `以下 SDK 路径无效或缺 bin/flutter: ${badPaths.join(', ')}`
      : `全部 ${manifest.count} 个登记版本路径有效（sdkRoot: ${manifest.sdkRoot || '（逐项 path）'}）`,
    badPaths.length ? '修正 ohos-flutter-sdks.yaml 中的 path，或删除未安装版本的条目' : '');
}

async function checkHdc() {
  const bin = findOnPath('hdc');
  if (!bin) {
    add('OHOS 环境', 'hdc 命令', false, 'PATH 中未找到 hdc',
      '安装 DevEco Studio（含 Command Line Tools）并加入 PATH 后执行 hdc list targets 验证');
    return;
  }
  const { out } = await execFileText(bin, ['list', 'targets'], 8000);
  const lines = out.split('\n').map(s => s.trim()).filter(s => s.length > 0);
  const empty = lines.some(l => /empty/i.test(l)) || lines.length === 0;
  // 设备未连接是瞬时态 → 警告；hdc 缺失才是持久环境缺陷 → 阻断
  add('OHOS 环境', 'hdc 连接', !empty, empty ? 'hdc 可用但当前无设备（list targets = [Empty]）' : `已连接 ${lines.length} 台设备`,
    empty ? '诊断/验证 run 执行前连接 OHOS 真机并开启 USB 调试' : '', empty);
}

function checkEngineSrc() {
  const home = path.join(HOME_DIR, 'engine-src');
  const ok = isDir(home) && (exists(path.join(home, 'DEPS')) || isDir(path.join(home, 'engine', 'src')));
  add('OHOS 环境', '~/engine-src 引擎源码树', ok, ok ? '存在' : '不存在',
    ok ? '' : '仅「engine 源码修复」类 run 需要：gclient sync 建立（见 ~/.aceharness/skills/cpf-ohos-issue-analysis/references/engine-build.md），其余诊断流程不受影响',
    !ok);
}

async function checkTilde() {
  if (IS_WIN) {
    add('OHOS 环境', 'shell ~ 展开', true, 'Windows：请确保 agent 终端使用 PowerShell 7+ 或 Git Bash（cmd.exe 不展开 ~）', '', true);
    return;
  }
  const shell = process.env.SHELL || '/bin/sh';
  const { out, code } = await execFileText(shell, ['-c', 'echo ~/.aceharness'], 5000);
  const expanded = out.trim();
  add('OHOS 环境', 'shell ~ 展开', code === 0 && expanded === RT,
    `期望 ${RT}，实际 ${expanded || '（无输出）'}（${shell}）`,
    code === 0 && expanded === RT ? '' : '工作流配置依赖 ~ 展开：请使用 bash/zsh 作为 agent 执行 shell');
}

function checkService() {
  return new Promise(resolve => {
    const sock = new net.Socket();
    const done = inUse => {
      add('服务与凭据', `端口 ${DEFAULT_PORT}`, !inUse,
        inUse ? `已被占用（如已有 ace 实例在运行则正常）` : '可绑定',
        inUse ? `PORT=${DEFAULT_PORT + 100} ace start 换端口启动` : '', inUse);
      resolve();
    };
    sock.setTimeout(1500);
    sock.once('connect', () => { sock.destroy(); done(true); });
    sock.once('timeout', () => { sock.destroy(); done(false); });
    sock.once('error', () => done(false));
    sock.connect(DEFAULT_PORT, '127.0.0.1');
  });
}

function checkCredentials() {
  const dir = path.join(RT, 'data', 'runtime-grants');
  let n = 0;
  try { n = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length; } catch { /* 不存在 */ }
  add('服务与凭据', 'AI 凭据（脱敏）', n > 0, n > 0 ? `${dir} 下有 ${n} 个凭据项（仅计数，未读取内容）` : 'runtime-grants 为空，诊断 run 将无法创建 AI 会话',
    n > 0 ? '' : '运行 ace 启动向导配置模型 provider key（每机独立，勿拷贝他人）', n === 0);
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  checkPlatform();
  checkRuntime();
  checkOhos();
  await checkHdc();
  checkEngineSrc();
  await checkTilde();
  await checkService();
  checkCredentials();

  const failed = checks.filter(c => !c.ok && !c.warning);
  const warnings = checks.filter(c => !c.ok && c.warning);
  const passed = checks.filter(c => c.ok);

  if (JSON_MODE) {
    console.log(JSON.stringify({
      ok: failed.length === 0,
      summary: { passed: passed.length, failed: failed.length, warnings: warnings.length },
      checks: checks.map(({ group, name, ok, warning, detail, fix }) => ({ group, name, ok, warning, detail, fix })),
    }, null, 2));
  } else if (!QUIET) {
    let lastGroup = '';
    for (const c of checks) {
      if (c.group !== lastGroup) { console.log(`\n[${c.group}]`); lastGroup = c.group; }
      const icon = c.ok ? '✓' : (c.warning ? '⚠' : '✗');
      console.log(`  ${icon} ${c.name}${c.detail ? ` — ${c.detail.split('\n')[0]}` : ''}`);
      if (c.fix) {
        const label = c.ok ? '提示' : '修复';
        for (const line of c.fix.split('\n')) console.log(`      ${label}: ${line}`);
      }
    }
    console.log(`\n${'─'.repeat(40)}\n${passed.length} 项通过 / ${failed.length} 项需修复 / ${warnings.length} 项警告`);
    if (!FIX_MODE) console.log('（当前 --no-fix：缺失项未自动补齐）');
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(e => { console.error('ace doctor 异常:', e); process.exit(1); });
