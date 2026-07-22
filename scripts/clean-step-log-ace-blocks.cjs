#!/usr/bin/env node
/**
 * 一次性清理脚本：剥离 ~/.aceharness/runs 下面 outputs/step-logs 目录里所有
 *  .md 文件中残留的 <ace-process>...</ace-process> 工具调用标签，
 * 让归档文件只保留 Agent 的真实文本输出。
 *
 * 触发原因：历史版本的 externalizeStepLogOutput 在写入磁盘前未过滤内部标签，
 * 导致 reporter / fixer 等步骤的 step log 头部出现大量形如：
 *   <ace-process>{"toolName":"read",...}</ace-process>
 * 的不可读字符。本脚本在已修复 externalizeStepLogOutput 之后，用于把脏文件
 * 离线清洗一遍。
 *
 * 用法：
 *   node scripts/clean-step-log-ace-blocks.cjs                # 清理所有 run
 *   node scripts/clean-step-log-ace-blocks.cjs <runId> [...]   # 清理指定 run
 *   node scripts/clean-step-log-ace-blocks.cjs --dry-run      # 只扫描不写
 */
const { readdir, readFile, writeFile, stat } = require('fs/promises');
const { resolve, join } = require('path');
const { existsSync } = require('fs');
const os = require('os');
const path = require('path');

const ACE_PROCESS_RE = /<ace-process>[\s\S]*?<\/ace-process>/g;

function stripAceBlocks(content) {
  return content
    .replace(ACE_PROCESS_RE, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
}

function defaultRunsDir() {
  const home = os.homedir();
  // 与 src/lib/core/app-paths.ts 中 getWorkspaceRunsDir() 的默认实现保持一致
  return process.env.ACEHARNESS_RUNS_DIR || join(home, '.aceharness', 'runs');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const runIds = args.filter((a) => !a.startsWith('--'));
  return { dryRun, runIds };
}

async function listRunIds(runsDir) {
  if (!existsSync(runsDir)) return [];
  const entries = await readdir(runsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('run-'))
    .map((e) => e.name);
}

async function cleanRun(runId, runsDir, { dryRun }) {
  const stepLogsDir = join(runsDir, runId, 'outputs', 'step-logs');
  if (!existsSync(stepLogsDir)) {
    return { runId, scanned: 0, cleaned: 0, skipped: 0, totalBytesSaved: 0 };
  }

  const files = await readdir(stepLogsDir);
  const targets = files.filter((f) => f.endsWith('.md') || f.endsWith('.txt'));
  let cleaned = 0;
  let skipped = 0;
  let totalBytesSaved = 0;

  for (const file of targets) {
    const filePath = join(stepLogsDir, file);
    const st = await stat(filePath);
    if (st.size === 0) {
      skipped += 1;
      continue;
    }
    const original = await readFile(filePath, 'utf-8');
    if (!ACE_PROCESS_RE.test(original)) {
      ACE_PROCESS_RE.lastIndex = 0;
      skipped += 1;
      continue;
    }
    ACE_PROCESS_RE.lastIndex = 0;
    const next = stripAceBlocks(original);
    const saved = Buffer.byteLength(original, 'utf-8') - Buffer.byteLength(next, 'utf-8');
    if (saved <= 0) {
      skipped += 1;
      continue;
    }
    if (!dryRun) {
      await writeFile(filePath, next, 'utf-8');
    }
    cleaned += 1;
    totalBytesSaved += saved;
  }

  return { runId, scanned: targets.length, cleaned, skipped, totalBytesSaved };
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

async function main() {
  const { dryRun, runIds } = parseArgs(process.argv);
  const runsDir = defaultRunsDir();
  const ids = runIds.length > 0 ? runIds : await listRunIds(runsDir);
  if (ids.length === 0) {
    console.log(`[clean-step-logs] runs 目录为空: ${runsDir}`);
    return;
  }

  console.log(`[clean-step-logs] runs dir: ${runsDir}`);
  console.log(`[clean-step-logs] mode: ${dryRun ? 'dry-run' : 'write'}`);
  console.log(`[clean-step-logs] targets: ${ids.length} run(s)`);

  let totalScanned = 0;
  let totalCleaned = 0;
  let totalSkipped = 0;
  let totalBytesSaved = 0;
  for (const runId of ids) {
    try {
      const result = await cleanRun(runId, runsDir, { dryRun });
      totalScanned += result.scanned;
      totalCleaned += result.cleaned;
      totalSkipped += result.skipped;
      totalBytesSaved += result.totalBytesSaved;
      if (result.scanned > 0) {
        const flag = result.cleaned > 0 ? '🧹' : '✓';
        console.log(
          `  ${flag} ${runId}: scanned=${result.scanned} cleaned=${result.cleaned} skipped=${result.skipped} saved=${formatBytes(result.totalBytesSaved)}`,
        );
      }
    } catch (err) {
      console.error(`  ✗ ${runId}: ${err && err.message ? err.message : err}`);
    }
  }

  console.log('');
  console.log(`[clean-step-logs] done. scanned=${totalScanned} cleaned=${totalCleaned} skipped=${totalSkipped} saved=${formatBytes(totalBytesSaved)}`);
}

main().catch((err) => {
  console.error('[clean-step-logs] fatal:', err);
  process.exit(1);
});
