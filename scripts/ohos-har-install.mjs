#!/usr/bin/env node
/**
 * OHOS HAR 安装门禁（F12/R08）：核对 HAR、实际依赖锁文件和构建清单，
 * 仅对匹配的 HAP 执行 hdc install；全过程写安装记录 JSON 供归档审计。
 *
 * 设计约束：
 *  - 这是唯一被允许的安装入口（诊断工作流提示词强制）；绕过即视为验证证据无效。
 *  - 任何一步失败都不安装：HAR 缺失/无法解析/模式不符 → 退出码非 0 并写记录。
 *
 * 用法：
 *  node scripts/ohos-har-install.mjs --har app.har --expected-mode release --hap app.hap --build-manifest build.json [--device 6HK...] [--record install-record.json] [--check-only]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, realpathSync, openSync, readSync, closeSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const out = { device: null, record: null, checkOnly: false, expectedTarget: null, expectPathPrefix: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--har') out.har = argv[++i];
    else if (a === '--hap') out.hap = argv[++i];
    else if (a === '--build-manifest') out.buildManifest = argv[++i];
    else if (a === '--expected-mode') out.expectedMode = argv[++i];
    else if (a === '--expected-target') out.expectedTarget = argv[++i];
    else if (a === '--expect-path-prefix') out.expectPathPrefix = argv[++i];
    else if (a === '--device') out.device = argv[++i];
    else if (a === '--record') out.record = argv[++i];
    else if (a === '--check-only') out.checkOnly = true;
    else throw new Error(`未知参数: ${a}`);
  }
  if (!out.har) throw new Error('缺少 --har <path>');
  if (!out.expectedMode || !['release', 'debug', 'profile'].includes(out.expectedMode)) {
    throw new Error('缺少或非法 --expected-mode（release|debug|profile）');
  }
  return out;
}

/** 与 src/lib/workflow/diagnosis-script-step.ts 的 inspectHarBuildProfile 同口径 */
export function inspectBuildProfile(harPath) {
  const stdout = execFileSync('tar', ['-xzOf', harPath, 'package/BuildProfile.ets'], { timeout: 8000, encoding: 'utf-8' });
  const mode = /BUILD_MODE_NAME\s*=\s*['"]([^'"]+)['"]/.exec(stdout)?.[1] || null;
  const debugRaw = /DEBUG\s*=\s*(true|false)/.exec(stdout)?.[1];
  const target = /TARGET_NAME\s*=\s*['"]([^'"]+)['"]/.exec(stdout)?.[1] || null;
  return { build_mode: mode, debug: debugRaw == null ? null : debugRaw === 'true', target };
}

export function sha256File(file) {
  const fd = openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try { let count; while ((count = readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count)); return hash.digest('hex'); }
  finally { closeSync(fd); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const record = {
    har: resolve(args.har), hap: args.hap ? resolve(args.hap) : null, hap_sha256: null,
    build_manifest: args.buildManifest ? resolve(args.buildManifest) : null,
    application_started: null, golden_flag_met: null,
    expected_mode: args.expectedMode,
    expected_target: args.expectedTarget || null,
    expect_path_prefix: args.expectPathPrefix ? resolve(args.expectPathPrefix) : null,
    device: args.device || null,
    check_only: args.checkOnly,
    checked_at: new Date().toISOString(),
    gate: 'failed', reason: null, sha256: null, build_mode: null, debug: null, target: null,
    installed: false, install_output_tail: null,
  };
  const flush = () => {
    if (args.record) { mkdirSync(dirname(resolve(args.record)), { recursive: true }); writeFileSync(args.record, JSON.stringify(record, null, 2)); }
  };
  try {
    if (!existsSync(args.har)) throw new Error(`HAR 不存在: ${args.har}`);
    // 依赖实际解析位置检查：HAR 必须来自本次 run 的预期产物目录，
    // 防止从共享 SDK 缓存/旧构建目录装上来源不明的副本
    if (args.expectPathPrefix) {
      const prefix = existsSync(args.expectPathPrefix) ? realpathSync(args.expectPathPrefix) : resolve(args.expectPathPrefix);
      if (!realpathSync(args.har).startsWith(prefix + '/') && realpathSync(args.har) !== prefix) {
        throw new Error(`HAR 路径不在预期产物目录内（${prefix}）：${resolve(args.har)}（拒绝安装）`);
      }
    }
    record.sha256 = sha256File(args.har);
    let info;
    try {
      info = inspectBuildProfile(args.har);
    } catch (e) {
      throw new Error(`无法解析 BuildProfile.ets（拒绝安装）：${String(e.message || e).slice(0, 160)}`);
    }
    record.build_mode = info.build_mode;
    record.debug = info.debug;
    record.target = info.target;
    if (info.build_mode !== args.expectedMode) {
      throw new Error(`构建模式不符：期望 ${args.expectedMode}，实际 ${info.build_mode || '未知'}（拒绝安装）`);
    }
    if (args.expectedTarget && info.target !== args.expectedTarget) {
      throw new Error(`目标产物不符：期望 ${args.expectedTarget}，实际 ${info.target}（拒绝安装）`);
    }
    if (info.debug !== (args.expectedMode === 'debug') || !info.target) throw new Error('BuildProfile DEBUG/TARGET_NAME 缺失或与构建模式不符');
    if (!args.checkOnly || args.hap || args.buildManifest) {
      if (!args.hap || !args.buildManifest) throw new Error('安装必须提供 --hap 与 --build-manifest；HAR 不能直接安装');
      if (!args.hap.endsWith('.hap')) throw new Error('安装目标必须是 HAP');
      const manifest = JSON.parse(readFileSync(args.buildManifest, 'utf8'));
      const hap = realpathSync(args.hap), har = realpathSync(args.har);
      const { resolvedFlutterHar } = await import('./ohos-hap-build.mjs');
      const dependency = resolvedFlutterHar(manifest.project);
      record.hap_sha256 = sha256File(hap);
      if (manifest.version !== 1 || manifest.producer !== 'ohos-hap-build'
        || manifest.build_mode !== args.expectedMode || manifest.target !== info.target
        || manifest.har?.path !== har || manifest.har?.sha256 !== record.sha256
        || manifest.hap?.path !== hap || manifest.hap?.sha256 !== record.hap_sha256
        || manifest.dependency?.path !== har || dependency.path !== har
        || manifest.dependency?.lock_sha256 !== dependency.lock_sha256) throw new Error('HAP 构建清单、实际依赖或产物 hash 不匹配');
    }
    record.gate = 'passed';
    if (!args.checkOnly) {
      const hdcArgs = args.device ? ['-t', args.device, 'install', args.hap] : ['install', args.hap];
      const output = execFileSync('hdc', hdcArgs, { timeout: 120000, encoding: 'utf-8' });
      if (!/success(?:ful(?:ly)?)?/i.test(output) || /\[Fail\]|install(?:ation)? failed/i.test(output)) throw new Error('hdc 未确认安装成功');
      record.installed = true;
      record.install_output_tail = output.trim().split('\n').slice(-5).join('\n').slice(0, 400);
    }
    console.log(JSON.stringify(record));
    flush();
  } catch (e) {
    record.gate = 'failed';
    record.reason = String(e.message || e).slice(0, 300);
    console.error(JSON.stringify(record));
    flush();
    process.exit(2);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch(error => { console.error(String(error.message || error)); process.exitCode = 2; });
