#!/usr/bin/env node
/**
 * 运行时配置漂移检测与显式同步（R07）。
 *
 * 背景：工作流运行时读的是 ~/.aceharness/configs/<name>，仓库 configs/<name> 是模板。
 * 历史上运行时副本靠 copyMissingRecursive 建立，之后模板更新不会自动生效，产生静默漂移
 * （2026-10-13 复核发现 cpf-ohos-diagnosis.yaml 运行时 c4864399 ≠ 模板 3cab82b3）。
 *
 * 原则：
 *  - 绝不静默覆盖：默认 --check 只报告；--apply 必须显式给出文件名（不支持批量）。
 *  - --apply 前为运行时副本做时间戳备份，可回滚。
 *  - 正在运行的 run 通过 configs/manifest.json 快照与运行时副本隔离（恢复时读快照），
 *    但若有活跃 run 仍引用旧 hash，--apply 会给出警告要求确认。
 *
 * 用法：
 *  node scripts/sync-runtime-config.mjs                  # check 全部模板
 *  node scripts/sync-runtime-config.mjs --check cpf-ohos-diagnosis.yaml
 *  node scripts/sync-runtime-config.mjs --apply cpf-ohos-diagnosis.yaml [--yes]
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeRoot } from './runtime-root.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const TEMPLATE_DIR = join(REPO_ROOT, 'configs');
const RUNTIME_DIR = process.env.ACEHARN_CONFIGS_DIR || join(runtimeRoot(), 'configs');
const RUNS_DIR = process.env.ACEHARN_RUNS_DIR || join(runtimeRoot(), 'runs');

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function listTemplates() {
  return readdirSync(TEMPLATE_DIR).filter((n) => /\.ya?ml$/i.test(n)).sort();
}

function driftReport(names) {
  return names.map((name) => {
    const template = join(TEMPLATE_DIR, name);
    const runtime = join(RUNTIME_DIR, name);
    const templateHash = existsSync(template) ? sha256(template) : null;
    const runtimeHash = existsSync(runtime) ? sha256(runtime) : null;
    const state = !templateHash ? 'missing-template'
      : !runtimeHash ? 'missing-runtime'
      : templateHash === runtimeHash ? 'same' : 'drifted';
    return { name, templateHash, runtimeHash, state, template, runtime };
  });
}

/** 扫描活跃 run（state.yaml 非终态）中引用该配置的 manifest，返回仍在用旧 hash 的 run 列表 */
function activeRunsUsing(name) {
  const hits = [];
  let runDirs = [];
  try { runDirs = readdirSync(RUNDS_SAFE(RUNS_DIR)); } catch { return hits; }
  for (const dir of runDirs) {
    const manifestPath = join(RUNS_DIR, dir, 'configs', 'manifest.json');
    const statePath = join(RUNS_DIR, dir, 'state.yaml');
    try {
      if (!existsSync(manifestPath) || !existsSync(statePath)) continue;
      const stateText = readFileSync(statePath, 'utf-8');
      if (/^status:\s*(completed|failed|stopped|cancelled)/m.test(stateText)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const entry = (manifest.configs || []).find((c) => c.file === name);
      if (entry) hits.push({ run: dir, sha256: entry.sha256 });
    } catch { /* 单个 run 解析失败不影响整体报告 */ }
  }
  return hits;
}
function RUNDS_SAFE(p) { return p; }

function main() {
  const args = process.argv.slice(2);
  const applyMode = args.includes('--apply');
  const assumeYes = args.includes('--yes');
  const target = args.find((a, i) => !a.startsWith('--') && (args[i - 1] === '--apply' || args[i - 1] === '--check'))
    || args.find((a) => !a.startsWith('--') && /\.ya?ml$/i.test(a));

  if (applyMode && !target) {
    console.error('[sync-config] --apply 必须显式指定单个配置文件名（不支持批量，防止误覆盖用户定制）');
    process.exit(2);
  }

  const names = target ? [target] : listTemplates();
  const report = driftReport(names);

  if (!applyMode) {
    let drifted = 0;
    for (const row of report) {
      const t = row.templateHash ? row.templateHash.slice(0, 12) : '-';
      const r = row.runtimeHash ? row.runtimeHash.slice(0, 12) : '-';
      console.log(`[sync-config] ${row.state.padEnd(17)} ${row.name}  template=${t} runtime=${r}`);
      if (row.state === 'drifted') drifted += 1;
      if (row.state === 'drifted') {
        const actives = activeRunsUsing(row.name).filter((a) => a.sha256 === row.runtimeHash);
        for (const a of actives) console.log(`[sync-config]   ↳ 活跃 run ${a.run} 仍使用运行时旧 hash ${a.sha256.slice(0, 12)}（其恢复快照不受影响）`);
      }
    }
    if (report.some((r) => r.state === 'missing-runtime')) {
      console.log('[sync-config] 提示：missing-runtime 的模板将在下次启动时由 copyMissingRecursive 建立，无需手动同步');
    }
    process.exit(drifted ? 1 : 0);
  }

  // --apply：单个文件、显式确认、先备份
  const row = report[0];
  if (row.state === 'same') { console.log(`[sync-config] ${row.name} 已一致，无需同步`); return; }
  if (row.state === 'missing-template') { console.error(`[sync-config] 模板不存在：${row.template}`); process.exit(2); }
  const actives = activeRunsUsing(row.name).filter((a) => a.sha256 === row.runtimeHash);
  if (actives.length && !assumeYes) {
    console.error(`[sync-config] 拒绝：${actives.length} 个活跃 run 仍引用运行时旧配置（${actives.map((a) => a.run).join(', ')}）。`);
    console.error('[sync-config] 这些 run 的恢复快照不受影响；如确认只影响新 run，请加 --yes 重试。');
    process.exit(3);
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+/, '');
  const backup = join(RUNTIME_DIR, `${row.name}.bak-${stamp}`);
  if (existsSync(row.runtime)) copyFileSync(row.runtime, backup);
  mkdirSync(RUNTIME_DIR, { recursive: true });
  copyFileSync(row.template, row.runtime);
  const after = sha256(row.runtime);
  console.log(`[sync-config] 已同步 ${row.name}: ${String(row.runtimeHash).slice(0, 12)} → ${after.slice(0, 12)}`);
  if (existsSync(backup)) console.log(`[sync-config] 备份: ${backup}`);
  writeFileSync(join(RUNTIME_DIR, '.sync-log'),
    `${new Date().toISOString()} apply ${row.name} ${row.runtimeHash || '-'} -> ${after} backup=${existsSync(backup) ? basename(backup) : '-'}\n`,
    { flag: 'a' });
}

main();
