/**
 * 诊断产物瘦身。
 * 工作区里的 demo 编译缓存（build、oh_modules、.dart_tool）一次分析大约 3GB，
 * 结束后不再需要。报告和补丁在 outputs/。仓库目录 repo/ 里也有名为 build 的源码目录，不能扫进去。
 * hilog/logcat 只保留开头和结尾，避免一份全量日志占几百 MB。
 */
import { lstat, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;
const SCRATCH_DIR_NAMES = new Set([
  'build', '.dart_tool', 'oh_modules', 'node_modules', '.gradle', '.hvigor', 'Pods', '.cxx', 'ephemeral', 'DerivedData',
]);
const LOG_FILE = /(?:hilog|logcat).*\.(?:txt|log)$/i;

export function logMaxBytes(env = process.env) {
  const raw = Number(env.ACE_DIAGNOSIS_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw >= 1024 ? Math.floor(raw) : DEFAULT_LOG_MAX_BYTES;
}

export function compactLogBuffer(input, maxBytes = DEFAULT_LOG_MAX_BYTES) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''));
  if (source.length <= maxBytes) return source;
  const marker = Buffer.from(`\n...[诊断归档已截断，原文件 ${source.length} 字节，保留开头和结尾]...\n`);
  if (marker.length >= maxBytes) return source.subarray(source.length - maxBytes);
  const room = maxBytes - marker.length;
  const head = Math.min(source.length, Math.max(1, Math.floor(room * 0.25)));
  const tail = Math.min(source.length - head, room - head);
  return Buffer.concat([source.subarray(0, head), marker, source.subarray(source.length - tail)]);
}

export async function compactOutputLogs(outputsDir, maxBytes = logMaxBytes()) {
  if (!outputsDir || !existsSync(outputsDir)) return [];
  const compacted = [];
  const walk = async (dir) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const child = join(dir, entry.name);
      let info;
      try { info = await lstat(child); }
      catch { continue; }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!info.isFile() || !LOG_FILE.test(entry.name) || info.size <= maxBytes) continue;
      const next = compactLogBuffer(await readFile(child), maxBytes);
      if (next.length < info.size) {
        await writeFile(child, next);
        compacted.push(child);
      }
    }
  };
  await walk(outputsDir);
  return compacted;
}

async function removeScratch(path, rel, removed) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    await unlink(path);
    removed.push(rel);
    return;
  }
  if (!info.isDirectory()) return;
  await rm(path, { recursive: true, force: true });
  removed.push(rel);
}

/** 删掉工作区里可再生成的编译缓存。不进 outputs/、repo/、repo-engine/，符号链接只解除、不跟着删。 */
export async function pruneDiagnosisScratch(workspaceDir) {
  const root = resolve(workspaceDir);
  const removed = [];
  const walk = async (dir, rel) => {
    if (rel === 'outputs' || rel === 'repo' || rel === 'repo-engine') return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (childRel === 'outputs' || childRel === 'repo' || childRel === 'repo-engine'
        || childRel.startsWith(`outputs${sep}`) || childRel.startsWith('outputs/')) continue;
      const child = join(dir, entry.name);
      let info;
      try { info = await lstat(child); }
      catch { continue; }
      const scratch = SCRATCH_DIR_NAMES.has(entry.name) || (rel === '' && entry.name === '.opencode');
      if (info.isSymbolicLink()) {
        if (scratch) await removeScratch(child, childRel, removed);
        continue;
      }
      if (!info.isDirectory()) continue;
      if (scratch) {
        await removeScratch(child, childRel, removed);
        continue;
      }
      await walk(child, childRel);
    }
  };
  await walk(root, '');
  return { removed };
}

function runStatus(stateFile) {
  try {
    const match = /^status:\s*(\S+)/m.exec(readFileSync(stateFile, 'utf8'));
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

/** 清掉已结束 issue 分析的编译缓存，并截断超大 hilog。运行中的不动。 */
export async function pruneEndedIssueArtifacts(aceHome = join(homedir(), '.aceharness')) {
  const workspaces = join(aceHome, 'run-workspaces');
  const runs = join(aceHome, 'runs');
  const summary = [];
  let names = [];
  try { names = await readdir(workspaces); }
  catch { names = []; }
  for (const name of names) {
    if (!/-ia-/.test(name)) continue;
    const status = runStatus(join(runs, name, 'state.yaml'));
    if (status && !['completed', 'failed', 'stopped', 'crashed', 'cancelled'].includes(status)) {
      summary.push({ runId: name, skipped: status });
      continue;
    }
    const removed = await pruneDiagnosisScratch(join(workspaces, name));
    const logs = [
      ...await compactOutputLogs(join(workspaces, name, 'outputs')),
      ...await compactOutputLogs(join(runs, name, 'outputs')),
    ];
    summary.push({ runId: name, status: status || 'unknown', removed: removed.removed.length, logs: logs.length });
  }
  return summary;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain && process.argv.includes('--prune-ended')) {
  const summary = await pruneEndedIssueArtifacts();
  const touched = summary.filter((item) => !item.skipped);
  console.log(JSON.stringify({
    runs: summary.length,
    pruned: touched.length,
    skipped: summary.filter((item) => item.skipped).map((item) => ({ runId: item.runId, status: item.skipped })),
    removedDirs: touched.reduce((sum, item) => sum + item.removed, 0),
    compactedLogs: touched.reduce((sum, item) => sum + item.logs, 0),
  }));
  for (const item of touched) console.log(`${item.runId}\t${item.status}\tremoved=${item.removed}\tlogs=${item.logs}`);
}
