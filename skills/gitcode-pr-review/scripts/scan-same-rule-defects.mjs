#!/usr/bin/env node
/**
 * 同规则扫雷：DCP codeCheck 一次只报一处缺陷，同一规则（如 G.TYP.04 建议字符串使用单引号）
 * 在 PR 自己改动的代码里往往多处存在，逐轮「报一行修一行」会浪费多轮 push + start build + CI。
 * 本脚本对 PR 的新增行（diff 里 + 的行）做同规则扫描，把同类问题一次找全，供静态修复一并列改。
 *
 * 用法：
 *   node scan-same-rule-defects.mjs --pr-url <PR_URL> --author <author> --defects outputs/dcp-codecheck-defects.json --out outputs
 * 输出：outputs/same-rule-candidates.json
 *   { ok, rules: [...], candidate_count, candidates: [{filepath, line, text, needs_escape}] }
 *   已被 DCP 报告过的行会排除（defects 里已有），只列「下一轮大概率会冒出来」的行。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveGitcodeToken } from './gitcode-token.mjs';

const API_ROOT = process.env.GITCODE_API_ROOT || 'https://gitcode.com/api/v5';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

function parsePrUrl(url) {
  const match = String(url || '').match(/https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/(?:pulls?|merge_requests)\/(\d+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, ''), number: match[3] };
}

/**
 * 解析单文件 patch（unified diff hunk 文本）为新增行列表。
 * hunk 头 `@@ -a,b +c,d @@`：c 是新文件起始行号；上下文行与 + 行推进行号，- 行不推进。
 */
export function parsePatchAddedLines(patchText) {
  const added = [];
  let fileLine = 0;
  for (const raw of String(patchText || '').split('\n')) {
    const hunk = raw.match(/^@@\s*-\d+(?:,\d+)?\s*\+(\d+)/);
    if (hunk) {
      fileLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      added.push({ line: fileLine, text: raw.slice(1) });
      fileLine += 1;
    } else if (raw.startsWith('-')) {
      // 删除行不推进新文件行号
    } else {
      fileLine += 1;
    }
  }
  return added;
}

const DOUBLE_QUOTE_STRING_RE = /"[^"\\\n]*(\\.[^"\\\n]*)*"/;

function isQuoteRule(ruleName) {
  return /单引号|singlequote|single quote/i.test(String(ruleName || ''));
}

function isNoiseLine(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^(\/\/|\/\*|\*)/.test(t)) return true; // 注释行（散文引号会误报）
  if (/^(import|export)\b/.test(t)) return true; // 模块语法
  if (/^@/.test(t)) return true; // 装饰器
  return false;
}

/**
 * 对新增行做引号规则扫描：含双引号字符串字面量的行是同类候选。
 * needs_escape：字符串内本身含单引号（如 "it's"），改写需转义，由 Agent 谨慎处理。
 */
export function findQuoteCandidates(addedLines) {
  const out = [];
  for (const item of addedLines || []) {
    if (isNoiseLine(item.text)) continue;
    const matches = String(item.text).match(new RegExp(DOUBLE_QUOTE_STRING_RE, 'g'));
    if (!matches) continue;
    out.push({
      line: item.line,
      text: item.text,
      needs_escape: matches.some((m) => m.includes("'")),
    });
  }
  return out;
}

async function fetchPullFiles(owner, repo, number, token) {
  const url = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/files?per_page=100${token ? `&access_token=${encodeURIComponent(token)}` : ''}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`拉取 PR files 失败 ${response.status}: ${text.slice(0, 200)}`);
  }
  const files = JSON.parse(text);
  return Array.isArray(files) ? files : [];
}

function patchTextOf(file) {
  const patch = file?.patch;
  if (typeof patch === 'string') return patch;
  if (patch && typeof patch === 'object') return String(patch.diff || '');
  return '';
}

async function main() {
  const prUrl = arg('--pr-url');
  const parsed = parsePrUrl(prUrl);
  const owner = arg('--owner', parsed?.owner || '');
  const repo = arg('--repo', parsed?.repo || '');
  const number = arg('--number', parsed?.number || '');
  const outDir = resolve(arg('--out', 'outputs'));
  const defectsPath = resolve(arg('--defects', 'outputs/dcp-codecheck-defects.json'));
  const token = arg('--token', resolveGitcodeToken(process.env, arg('--author')));

  if (!owner || !repo || !number) {
    throw new Error('缺少 owner/repo/number，或传入 --pr-url');
  }

  const defectsRaw = await readFile(defectsPath, 'utf8').catch(() => null);
  const defects = defectsRaw ? JSON.parse(defectsRaw) : { defects: [] };
  const reported = new Set(
    (defects.defects || []).map((d) => `${d.filepath}#${d.line}`),
  );
  const quoteRules = [...new Set(
    (defects.defects || [])
      .map((d) => String(d.rule || d.message || ''))
      .filter(isQuoteRule),
  )];

  const files = await fetchPullFiles(owner, repo, number, token);
  const candidates = [];
  if (quoteRules.length > 0) {
    for (const file of files) {
      const filepath = String(file.filename || file.file || file.path || '');
      if (!/\.(ets|ts)$/.test(filepath)) continue;
      const added = parsePatchAddedLines(patchTextOf(file));
      for (const cand of findQuoteCandidates(added)) {
        const key = `${filepath}#${cand.line}`;
        if (reported.has(key)) continue;
        candidates.push({ filepath, line: cand.line, text: cand.text, needs_escape: cand.needs_escape });
      }
    }
  }

  const result = {
    ok: true,
    scanned_at: new Date().toISOString(),
    rules: quoteRules,
    reported_count: reported.size,
    candidate_count: candidates.length,
    candidates,
    note: quoteRules.length === 0
      ? '缺陷里没有可确定性扫描的规则（当前支持引号类），candidates 为空'
      : '候选仅限 PR 新增行，已排除 DCP 已报告行；needs_escape 的行改写时注意转义',
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'same-rule-candidates.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isDirectRun = (() => {
  try {
    return resolve(process.argv[1] || '') === resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}
