#!/usr/bin/env node
/** Build a fresh HAP and record its actual resolved Flutter HAR dependency. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonrepair } from 'jsonrepair';
import { inspectBuildProfile, sha256File } from './ohos-har-install.mjs';

export function resolvedFlutterHar(project) {
  const lock = resolve(project, 'ohos/oh_modules/.ohpm/lock.json5');
  const data = JSON.parse(jsonrepair(readFileSync(lock, 'utf8')));
  const resolved = data.overrides?.['@ohos/flutter_ohos'];
  if (typeof resolved !== 'string' || !resolved.startsWith('file:')) throw new Error('缺少实际解析的本地 Flutter HAR override');
  return { path: realpathSync(resolve(project, 'ohos', resolved.slice(5))), lock, lock_sha256: sha256File(lock) };
}
export function buildHap(args) {
  for (const key of ['project', 'flutter', 'har', 'hap', 'expected-mode', 'manifest']) {
    if (!args[key]) throw new Error(`缺少 --${key}`);
  }
  const mode = args['expected-mode'];
  if (!['debug', 'profile', 'release'].includes(mode)) throw new Error('构建模式无效');
  const har = realpathSync(args.har), project = realpathSync(args.project);
  const hap = resolve(args.hap), manifest = resolve(args.manifest);
  if (!hap.endsWith('.hap') || hap === manifest || har === manifest) throw new Error('产物路径无效');
  const info = inspectBuildProfile(har);
  if (info.build_mode !== mode || info.debug !== (mode === 'debug') || !info.target) throw new Error('HAR 构建配置不匹配或不完整');
  const hash = sha256File(har);
  // Preserve old artifacts but require this invocation to produce a new HAP.
  const suffix = `.previous-${Date.now()}`;
  if (existsSync(hap)) renameSync(hap, hap + suffix);
  if (existsSync(manifest)) renameSync(manifest, manifest + suffix);
  const started = new Date().toISOString();
  execFileSync(realpathSync(args.flutter), ['build', 'hap', `--${mode}`], { cwd: project, stdio: 'inherit', timeout: 1800000 });
  const dependency = resolvedFlutterHar(project);
  if (dependency.path !== har || sha256File(har) !== hash) throw new Error('构建实际依赖与受检 HAR 不一致或构建期间 HAR 改变');
  if (!existsSync(hap)) throw new Error('构建未生成指定 HAP');
  const record = { version: 1, producer: 'ohos-hap-build', project, started_at: started,
    completed_at: new Date().toISOString(), build_mode: mode, target: info.target,
    har: { path: har, sha256: hash }, hap: { path: realpathSync(hap), sha256: sha256File(hap) },
    dependency };
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest + '.tmp', JSON.stringify(record, null, 2));
  renameSync(manifest + '.tmp', manifest);
  return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw new Error('参数需成对传入');
      args[process.argv[i].slice(2)] = process.argv[i + 1];
    }
    console.log(JSON.stringify(buildHap(args)));
  } catch (error) { console.error(String(error.message || error)); process.exitCode = 2; }
}
