/**
 * 多分支移植：同一个问题在不同目标分支上的改动归为一组。
 * - 预演 cherry-pick（git merge-tree，不检出工作区）
 * - 逐文件对比源分支的改动和目标分支上的改动，供人工核对
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export function run(cwd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function git(cwd, args, env) {
  const result = await run(cwd, args, env);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(0, 400) || `git ${args[0]} 退出 ${result.code}`);
  return result.stdout;
}

async function configGet(root, key) {
  const result = await run(root, ['config', '--get', key]);
  return result.code === 0 ? result.stdout.trim() : '';
}

export function newGroupId() {
  return `prg-${randomBytes(4).toString('hex')}`;
}

export function isGroupId(id) {
  return /^prg-[a-f0-9]{8}$/.test(String(id || ''));
}

export async function groupOf(root, branch) {
  const id = await configGet(root, `branch.${branch}.aceGroup`);
  return isGroupId(id) ? id : '';
}

export async function ensureGroup(root, branch) {
  const existing = await groupOf(root, branch);
  if (existing) return existing;
  const id = newGroupId();
  await git(root, ['config', `branch.${branch}.aceGroup`, id]);
  return id;
}

/** ace pr port 记在移植分支上的来源；不是移植分支时返回 null。 */
export async function portInfo(root, branch) {
  const [fromBranch, range, targetBranch] = await Promise.all([
    configGet(root, `branch.${branch}.acePortFrom`),
    configGet(root, `branch.${branch}.acePortSource`),
    configGet(root, `branch.${branch}.acePortTarget`),
  ]);
  const match = range.match(/^([0-9a-f]{7,64})\.\.([0-9a-f]{7,64})$/);
  if (!fromBranch || !match) return null;
  return { fromBranch, sourceBase: match[1], sourceHead: match[2], targetBranch };
}

export async function savePortInfo(root, branch, { group, fromBranch, sourceBase, sourceHead, targetBranch, baseRef }) {
  await git(root, ['config', `branch.${branch}.aceGroup`, group]);
  await git(root, ['config', `branch.${branch}.acePortFrom`, fromBranch]);
  await git(root, ['config', `branch.${branch}.acePortSource`, `${sourceBase}..${sourceHead}`]);
  await git(root, ['config', `branch.${branch}.acePortTarget`, targetBranch]);
  if (baseRef) await git(root, ['config', `branch.${branch}.acePrBase`, baseRef]);
}

/** 把 git diff 输出按文件切开。比较用 --no-renames，两侧路径相同。 */
export function splitDiff(text) {
  const files = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git a/')) {
      const rest = line.slice('diff --git a/'.length);
      const path = rest.slice(0, Math.max(0, (rest.length - 3) / 2));
      current = { path, lines: [line] };
      files.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return files.map((file) => ({ path: file.path, text: file.lines.join('\n').trimEnd() }));
}

/** 只保留增删的行（含顺序），忽略行号和上下文，用来判断两边改的是不是同一件事。 */
export function changeLines(fileText) {
  const out = [];
  let inHunk = false;
  for (const line of String(fileText || '').split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) {
      if (line.startsWith('Binary files ')) out.push('binary');
      else if (line.startsWith('index ') && line.includes('..')) out.push(`blob:${line.split(' ')[1].split('..')[1]}`);
      else if (line.startsWith('new mode ') || line.startsWith('deleted file mode') || line.startsWith('new file mode')) out.push(line);
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) out.push(line);
  }
  if (!out.includes('binary')) return out.filter((line) => !line.startsWith('blob:'));
  return out;
}

const ORDER = { missing: 0, extra: 1, adapted: 2, same: 3 };

export function comparePort(sourceDiff, targetDiff) {
  const source = new Map(splitDiff(sourceDiff).map((file) => [file.path, file.text]));
  const target = new Map(splitDiff(targetDiff).map((file) => [file.path, file.text]));
  const paths = [...new Set([...source.keys(), ...target.keys()])];
  const files = paths.map((path) => {
    const a = source.get(path);
    const b = target.get(path);
    let status = 'same';
    if (a === undefined) status = 'extra';
    else if (b === undefined) status = 'missing';
    else if (changeLines(a).join('\n') !== changeLines(b).join('\n')) status = 'adapted';
    return { path, status, source: a || '', target: b || '' };
  }).sort((x, y) => ORDER[x.status] - ORDER[y.status] || x.path.localeCompare(y.path));
  const summary = { same: 0, adapted: 0, missing: 0, extra: 0 };
  for (const file of files) summary[file.status] += 1;
  return { files, summary };
}

export async function rangeDiff(root, from, to) {
  return git(root, ['diff', '--no-color', '--no-ext-diff', '--no-renames', `${from}..${to}`]);
}

async function identityEnv(root, author) {
  const env = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: author.date,
  };
  if (!await configGet(root, 'user.email')) {
    env.GIT_COMMITTER_NAME = author.name;
    env.GIT_COMMITTER_EMAIL = author.email;
  }
  return env;
}

/**
 * 在 onto 上依次预演 cherry-pick -x，不碰工作区。
 * 成功返回新 commit；冲突返回冲突文件和出冲突的 commit。
 */
export async function simulatePick(root, onto, shas) {
  let current = (await git(root, ['rev-parse', `${onto}^{commit}`])).trim();
  const skipped = [];
  for (const sha of shas) {
    const parents = (await git(root, ['rev-list', '--parents', '-n', '1', sha])).trim().split(' ').slice(1);
    if (parents.length !== 1) {
      return { ok: false, conflicts: [], conflictCommit: sha, reason: parents.length ? '合并 commit 不能自动移植' : '第一个 commit 不能移植' };
    }
    const merged = await run(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${parents[0]}`, current, sha]);
    const lines = merged.stdout.split('\n');
    if (merged.code === 1) {
      return { ok: false, conflicts: lines.slice(1).filter(Boolean), conflictCommit: sha, reason: '有冲突' };
    }
    if (merged.code !== 0) throw new Error((merged.stderr || merged.stdout).trim().slice(0, 400));
    const tree = lines[0].trim();
    if (tree === (await git(root, ['rev-parse', `${current}^{tree}`])).trim()) {
      skipped.push(sha);
      continue;
    }
    const [name, email, date, ...body] = (await git(root, ['log', '-1', '--format=%an%x00%ae%x00%aI%x00%B', sha])).split('\0');
    const message = `${body.join('\0').trim()}\n\n(cherry picked from commit ${sha})`;
    current = (await git(root, ['commit-tree', tree, '-p', current, '-m', message], await identityEnv(root, { name, email, date }))).trim();
  }
  return { ok: true, sha: current, skipped };
}
