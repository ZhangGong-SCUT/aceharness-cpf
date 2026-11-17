#!/usr/bin/env node
/** 将本机已保存的真实 gate-source.json 转为脱敏、可压缩重放的模拟器剧本。 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ALLOWED_LABELS = new Set([
  'AI已检视', 'dco检查成功', 'dco检查失败', '静态检查成功', '静态检查失败',
  '编译成功', '编译失败', '冒烟测试成功', '冒烟测试失败', '测试成功', '测试失败',
]);
const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}
function usage() {
  throw new Error('用法: node import-real-gate-scenario.mjs --source <gate-source.json> --id <kebab-id> --expected-phase <phase> --output <scenario.json> [--comment-id <start-build评论ID>] [--time-scale 0.0001]');
}
function sanitizeText(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s<>'")\]]+/gi, '[redacted-url]')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}
function authorOf(comment) {
  const login = String(comment?.user?.login || comment?.user?.username || '').trim();
  return /openharmony_ci|dcp|cpf-manager/i.test(login) ? login : 'redacted-author';
}
function event(comment, startMs) {
  return {
    source_comment_id: String(comment.id || ''),
    source_created_at: String(comment.created_at || ''),
    atMs: Math.max(0, Date.parse(String(comment.created_at)) - startMs),
    who: authorOf(comment),
    comment: sanitizeText(comment.body),
    // 默认只唤醒最终事件；可在重放测试中单独调整，不冒充线上 webhook 投递记录。
    webhook: false,
  };
}

const sourcePath = arg('--source');
const id = arg('--id');
const expectedPhase = arg('--expected-phase');
const output = arg('--output');
if (!sourcePath || !id || !expectedPhase || !output) usage();
if (!/^[a-z0-9-]+$/.test(id)) throw new Error('--id 只能使用小写字母、数字和连字符');
const timeScale = Number(arg('--time-scale', '0.0001'));
if (!(timeScale > 0 && timeScale <= 1)) throw new Error('--time-scale 必须在 (0, 1] 内');
const source = JSON.parse(await readFile(resolve(sourcePath), 'utf8'));
const allComments = [...(source.issueComments || []), ...(source.pullComments || [])]
  .filter((item) => String(item.comment_type || 'pr_comment') === 'pr_comment');
const startCandidates = allComments.filter((item) => /^\s*start\s+build\s*$/i.test(String(item.body || '')));
const requestedId = arg('--comment-id');
const start = requestedId
  ? startCandidates.find((item) => String(item.id) === requestedId)
  : startCandidates.find((item) => allComments.some((other) => (
    Date.parse(String(other.created_at)) >= Date.parse(String(item.created_at))
    && /openharmony_ci|dcp/i.test(authorOf(other)) && /门禁构建开始/.test(String(other.body || ''))
  )));
if (!start) throw new Error('没有找到带 CI 门禁开始回应的 start build；请用 --comment-id 明确选择');
const startMs = Date.parse(String(start.created_at));
if (!Number.isFinite(startMs)) throw new Error('start build 缺少有效 created_at');
const selected = allComments.filter((item) => Date.parse(String(item.created_at)) >= startMs);
const before = allComments.filter((item) => Date.parse(String(item.created_at)) < startMs);
const ciEvents = selected.filter((item) => /openharmony_ci|dcp/i.test(authorOf(item)) && !/^\s*start\s+build\s*$/i.test(String(item.body || '')));
if (!ciEvents.some((item) => /门禁构建开始/.test(String(item.body || '')))) throw new Error('选定 start build 后没有门禁构建开始评论');
const script = ciEvents.map((item) => event(item, startMs));
if (script.length) script[script.length - 1].webhook = true;
const labels = (source.pull?.labels || []).map((item) => String(item.name || item.label || item)).filter((name) => ALLOWED_LABELS.has(name));
const resultLabels = labels.filter((name) => /成功|失败/.test(name));
const last = script[script.length - 1];
if (last) last.labels = resultLabels;
const result = {
  schema_version: 1,
  id,
  kind: 'real_replay',
  description: '真实监控快照的脱敏重放；不访问真实 GitCode/DCP，不执行编译或测试。',
  source: {
    evidence: 'local gate-source.json (pull comments + final PR labels)',
    repository: `${source.owner}/${source.repo}#${source.number}`,
    snapshot_at: String(source.checked_at || ''),
    start_build_comment_id: String(start.id || ''),
    excluded_non_ci_comments_after_start: selected.length - ciEvents.length - 1,
    limitations: [
      '评论正文和时间来自真实快照；URL、邮箱及普通作者身份已脱敏。',
      '仅保存最终标签快照，结果标签附在最后一个门禁事件，不能据此声称知道标签的真实变更时刻。',
      'webhook 仅用于本地重放测试，不是对线上 webhook 投递次数和顺序的记录。',
    ],
  },
  pr: {
    owner: source.owner, repo: source.repo, number: Number(source.number),
    author: 'replay-author', head_repo: 'replay-author/replay-fork', head_ref: 'replay-branch',
    head_sha: 'a'.repeat(40), base_ref: source.pull?.base?.ref || 'master',
  },
  timeScale,
  seed: {
    labels: [],
    comments: before.map((item) => ({
      ...event(item, startMs),
      atMs: Date.parse(String(item.created_at)) - startMs,
    })),
  },
  script,
  expected: { phase: expectedPhase },
};
await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(resolve(output), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ id, output: resolve(output), source: result.source.repository, events: script.length, seed_comments: result.seed.comments.length, labels: resultLabels, expected: result.expected }, null, 2)}\n`);
