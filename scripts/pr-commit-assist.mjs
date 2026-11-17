/**
 * ace pr 的提交辅助：列出未提交文件、标出不该进 PR 的文件，只提交用户选中的。
 */
import { spawn } from 'node:child_process';

export function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout).trim().slice(0, 800) || `git ${args[0]} 退出 ${code}`));
    });
  });
}

export function parsePorcelainZ(text) {
  const parts = String(text || '').split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const item = parts[i];
    if (item.length < 4) continue;
    const x = item[0];
    const y = item[1];
    const entry = { x, y, path: item.slice(3), orig: '' };
    if (x === 'R' || x === 'C') {
      entry.orig = parts[i + 1] || '';
      i += 1;
    }
    entries.push(entry);
  }
  return entries;
}

const SECRET_EXT = /\.(p12|pfx|cer|crt|p7b|jks|keystore|pem|key)$/i;
const PATCH_EXT = /\.(patch|diff|orig|rej)$/i;
const COPY_NAME = /副本|(^|[\s_.-])copy([\s_.-]|$)| \(\d+\)(\.|$)/i;
const TOOL_DIR = /(^|\/)(agent-artifacts|\.ace|\.cursor|\.claude|\.opencode|\.codex)(\/|$)/;
const BUILD_OUTPUT = /(^|\/)(build|out|\.dart_tool|oh_modules|node_modules|\.hvigor|\.cxx|\.idea|\.vscode)(\/|$)|\.(hap|har|hsp|so|o|a|log|tmp)$|(^|\/)\.DS_Store$/i;
const LOCK_FILE = /(^|\/)(pubspec\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|oh-package-lock\.json5)$/;
const GN_CONFIG = /(^|\/)(\.gn|[^/]*\.gn|[^/]*\.gni|tools\/gn)$/;

export function riskOf(path, tracked) {
  const p = String(path || '').replace(/\/$/, '');
  const base = p.split('/').pop() || '';
  if (SECRET_EXT.test(p) || /^\.env(\.|$)/.test(base) || base === 'local.properties' || /token|secret|password/i.test(base)) {
    return '可能含证书、密钥或令牌';
  }
  if (base === 'build-profile.json5') return '签名配置，可能含证书路径和密码';
  if (PATCH_EXT.test(p)) return '补丁或冲突残留文件';
  if (COPY_NAME.test(base)) return '副本文件';
  if (TOOL_DIR.test(p)) return 'AI 或工具产物';
  if (GN_CONFIG.test(p)) return '编译配置，确认不是本地调试改动';
  if (LOCK_FILE.test(p)) return '依赖锁文件';
  if (!tracked && BUILD_OUTPUT.test(p)) return '编译产物或本地文件';
  return '';
}

export function classifyChanges(entries) {
  return entries.map((entry) => {
    const untracked = entry.x === '?';
    const code = untracked ? '?' : (entry.x !== ' ' ? entry.x : entry.y);
    const kind = untracked ? '新增' : ({ D: '删除', A: '新增', R: '重命名', C: '复制', U: '冲突' }[code] || '修改');
    const risk = entry.x === 'U' || entry.y === 'U' ? '有未解决的冲突' : riskOf(entry.path, !untracked);
    return {
      path: entry.path,
      orig: entry.orig,
      tracked: !untracked,
      kind,
      risk,
      selected: !untracked && !risk,
    };
  });
}

export async function workingChanges(root) {
  return classifyChanges(parsePorcelainZ(await git(root, ['status', '--porcelain=v1', '-z'])));
}

/** "2 5-7, 9" → [1, 4, 5, 6, 8]（0 起始）；越界或无法识别返回 null。 */
export function parseIndexList(input, count) {
  const out = new Set();
  for (const token of String(input || '').split(/[\s,，]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)(?:-(\d+))?$/);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : from;
    if (from < 1 || to > count || from > to) return null;
    for (let i = from; i <= to; i += 1) out.add(i - 1);
  }
  return [...out];
}

export function suggestMessage(changes, branch) {
  const picked = changes.filter((item) => item.selected);
  const named = String(branch || '').match(/^(feat|fix|refactor|perf|docs|test|chore)[/_-](.+)$/i);
  if (named) return `${named[1].toLowerCase()}: ${named[2].replace(/[/_-]+/g, ' ').trim()}`;
  const first = picked[0]?.path.replace(/\/$/, '').split('/').pop() || '';
  if (!first) return '';
  return picked.length > 1 ? `fix(ohos): 修改 ${first} 等 ${picked.length} 个文件` : `fix(ohos): 修改 ${first}`;
}

export async function repoUsesSignoff(root) {
  try {
    return /^Signed-off-by:/m.test(await git(root, ['log', '-n', '20', '--format=%B', 'HEAD']));
  } catch {
    return false;
  }
}

export function formatChangeList(changes) {
  const width = String(changes.length).length;
  return changes.map((item, index) => {
    const mark = item.selected ? '[x]' : '[ ]';
    const name = item.orig ? `${item.orig} → ${item.path}` : item.path;
    const tail = item.risk ? `   ← ${item.risk}` : (item.tracked ? '' : '   ← 未跟踪的新文件');
    return `  ${mark} ${String(index + 1).padStart(width)}  ${item.kind}  ${name}${tail}`;
  }).join('\n');
}

/** 只提交选中的路径；其他已暂存的改动保持原样，不会被带进这个 commit。 */
export async function commitSelected(root, changes, message, { signoff = false } = {}) {
  const picked = changes.filter((item) => item.selected);
  if (!picked.length) throw new Error('没有选中任何文件');
  const subject = String(message || '').trim();
  if (!subject) throw new Error('提交信息不能为空');
  const untracked = picked.filter((item) => !item.tracked).map((item) => item.path);
  if (untracked.length) await git(root, ['add', '--', ...untracked]);
  const paths = picked.flatMap((item) => (item.orig ? [item.orig, item.path] : [item.path]));
  const args = ['commit', '-q', '-m', subject];
  if (signoff) args.push('-s');
  args.push('--only', '--', ...paths);
  await git(root, args);
  const sha = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
  return { sha, count: picked.length };
}
