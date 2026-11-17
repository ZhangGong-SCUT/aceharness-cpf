#!/usr/bin/env node
/**
 * ace pr — 读取当前仓库，写成 PR 草稿并打开工作台。不推送、不创建 PR。
 * 有未提交改动时先让用户挑文件 commit；没有跟踪分支时帮用户选对比基准。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runtimeRoot } from './runtime-root.mjs';
import { collectRepo, currentBranch, repoRoot, upstreamRef } from './pr-submit-collect.mjs';
import {
  commitSelected,
  formatChangeList,
  parseIndexList,
  repoUsesSignoff,
  suggestMessage,
  workingChanges,
} from './pr-commit-assist.mjs';
import { aheadCount, baseCandidates, refExists, saveBase, savedBase, searchRemoteRefs } from './pr-base-pick.mjs';
import { ensureGroup, run, savePortInfo, simulatePick } from './pr-port.mjs';

function parseArgs(argv) {
  let start = argv[0] === 'pr' || argv[0] === 'submit-pr' ? 1 : 0;
  const opts = {
    open: true, help: false, commit: false, noCommit: false, message: '', include: [], base: '', signoff: false,
    port: false, target: '', dir: '', remote: '', yes: false, fetch: true,
  };
  if (argv[start] === 'port') {
    opts.port = true;
    start += 1;
  }
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} 需要一个值`);
      i += 1;
      return next;
    };
    if (arg === '--no-open') opts.open = false;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--commit') opts.commit = true;
    else if (arg === '--no-commit') opts.noCommit = true;
    else if (arg === '-m' || arg === '--message') opts.message = value();
    else if (arg === '--include') opts.include.push(value());
    else if (arg === '--base') opts.base = value();
    else if (arg === '-s' || arg === '--signoff') opts.signoff = true;
    else if (opts.port && arg === '--dir') opts.dir = value();
    else if (opts.port && arg === '--remote') opts.remote = value();
    else if (opts.port && (arg === '-y' || arg === '--yes')) opts.yes = true;
    else if (opts.port && arg === '--no-fetch') opts.fetch = false;
    else if (opts.port && !arg.startsWith('-') && !opts.target) opts.target = arg;
    else throw new Error(`不认识的参数：${arg}（ace pr --help 查看用法）`);
  }
  return opts;
}

const HELP = [
  '用法:',
  '  ace pr                    为当前仓库生成 PR 草稿并打开工作台',
  '',
  '有未提交改动时:',
  '  在终端里运行会列出文件让你挑选，确认后只把选中的文件提交成一个本地 commit。',
  '  --commit -m "提交信息"     不交互：提交已修改的已跟踪文件（自动排除补丁、产物、密钥、本地编译配置等）',
  '  --include <路径>           额外提交这个文件或目录（可重复），新文件需要用它明确加入',
  '  -s, --signoff              提交时加 Signed-off-by（仓库最近的 commit 带署名时会自动加）',
  '  --no-commit                不提交，直接生成草稿',
  '',
  '对比基准:',
  '  --base <远程分支>          指定 PR 的对比基准，如 origin/oh-3.35.7-release，会记到这个分支上，下次自动沿用',
  '                             没有跟踪分支时会自动找当前分支是从哪个远程分支拉出来的',
  '',
  '  --no-open                  只生成草稿并打印地址，不打开浏览器',
  '',
  '移植到其他分支:',
  '  ace pr port <目标分支>     把当前分支的 commit 移植到另一个分支（如 oh-3.41.9-dev）：在旁边新建独立目录',
  '                             （git worktree）并 cherry-pick，有冲突留给你解决，当前目录不受影响。',
  '                             改完、编译验证后在那个目录里运行 ace pr，到工作台完成「移植核对」再提交。',
  '  --dir <目录>               移植目录，默认 <仓库目录>-ports/<目标分支>',
  '  --remote <远程>            目标分支所在的远程，默认取对比基准的远程',
  '  -y, --yes                  不再询问确认',
  '  --no-fetch                 不先获取最新的目标分支',
  '',
  'commit 只在本地，撤销用 git reset --soft HEAD~1。',
  '命令不会推送代码，也不会创建 Issue 或 PR；确认发生在工作台的「PR 提交」页。',
].join('\n');

let rl = null;
let closed = false;
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function ask(question) {
  if (closed) return null;
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('close', () => { closed = true; });
  }
  try {
    return (await rl.question(question)).trim();
  } catch {
    return null;
  }
}

function log(text) {
  console.log(`[ACE] ${text}`);
}

class Quit extends Error {}

async function confirm(question) {
  const answer = await ask(`${question} (y/N) `);
  return /^(y|yes|是)$/i.test(answer || '');
}

function markIncluded(changes, include) {
  for (const raw of include) {
    const want = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    const hits = changes.filter((item) => {
      const path = item.path.replace(/\/$/, '');
      return path === want || path.startsWith(`${want}/`) || want.startsWith(`${path}/`);
    });
    if (!hits.length) throw new Error(`--include ${raw} 不在未提交的文件里`);
    for (const item of hits) item.selected = true;
  }
}

async function interactiveCommit(root, branch, changes, opts) {
  log(`工作区有 ${changes.length} 个未提交的文件。选这次修复要提交的（标 ← 的默认不选）：`);
  for (;;) {
    console.log(formatChangeList(changes));
    const picked = changes.filter((item) => item.selected).length;
    const answer = await ask(`已选 ${picked} 个。回车确认；输入编号切换（如 2 5-7）；a 只选建议项；n 跳过不提交；q 退出：`);
    if (answer === null || /^q$/i.test(answer)) throw new Quit('已退出，没有提交');
    if (/^n$/i.test(answer)) return null;
    if (/^a$/i.test(answer)) {
      for (const item of changes) item.selected = item.tracked && !item.risk;
      continue;
    }
    if (answer === '') {
      if (!picked) {
        log('没有选中任何文件。输入编号选择，或输入 n 跳过。');
        continue;
      }
      break;
    }
    const indexes = parseIndexList(answer, changes.length);
    if (!indexes) {
      log(`没看懂「${answer}」，编号范围是 1-${changes.length}。`);
      continue;
    }
    for (const index of indexes) changes[index].selected = !changes[index].selected;
  }
  const risky = changes.filter((item) => item.selected && item.risk);
  if (risky.length) {
    log('下面这些文件被标成不建议提交：');
    for (const item of risky) console.log(`    ${item.path}   ← ${item.risk}`);
    if (!await confirm('确定一起提交吗？')) throw new Quit('已取消，没有提交');
  }
  const suggested = opts.message || suggestMessage(changes, branch);
  let message = await ask(`提交信息${suggested ? `（回车用「${suggested}」）` : ''}：`);
  if (message === null) throw new Quit('已退出，没有提交');
  message = message || suggested;
  while (!message) {
    message = await ask('提交信息不能为空，请输入：');
    if (message === null) throw new Quit('已退出，没有提交');
  }
  return message;
}

async function prepareCommit(root, branch, opts) {
  const changes = await workingChanges(root);
  if (!changes.length) return;
  if (opts.noCommit) {
    log(`工作区有 ${changes.length} 个未提交的文件，按 --no-commit 不提交，它们不会进入 PR。`);
    return;
  }
  markIncluded(changes, opts.include);
  let message = '';
  if (interactive && !opts.commit) {
    message = await interactiveCommit(root, branch, changes, opts);
    if (message === null) {
      log('跳过提交，未提交的文件不会进入 PR。');
      return;
    }
  } else if (opts.commit) {
    if (!opts.message) throw new Error('不交互提交需要 -m "提交信息"');
    if (!changes.some((item) => item.selected)) {
      throw new Error('没有可以自动提交的文件（新文件和标记为不建议提交的文件需要用 --include 明确加入）');
    }
    message = opts.message;
  } else {
    log(`工作区有 ${changes.length} 个未提交的文件，它们不会进入 PR。要一起提交，在终端里直接运行 ace pr，或加 --commit -m "提交信息"。`);
    return;
  }
  const signoff = opts.signoff || await repoUsesSignoff(root);
  const { sha, count } = await commitSelected(root, changes, message, { signoff });
  log(`已提交 ${count} 个文件，本地 commit ${sha}${signoff ? '（带 Signed-off-by）' : ''}。撤销用 git reset --soft HEAD~1`);
  const left = changes.filter((item) => !item.selected);
  if (left.length) log(`还有 ${left.length} 个文件没提交，不会进入 PR：${left.slice(0, 5).map((item) => item.path).join('、')}${left.length > 5 ? ' 等' : ''}`);
}

async function pickBase(root, branch, candidates, reason) {
  log(reason);
  if (candidates.length) {
    candidates.forEach((item, index) => {
      const note = item.source === 'editor' ? '，编辑器记录的分叉基准' : '';
      console.log(`  ${index + 1}) ${item.ref}   领先 ${item.ahead} 个 commit${note}`);
    });
  }
  for (;;) {
    const hint = candidates.length ? '回车选 1；输入编号；' : '';
    const answer = await ask(`${hint}或输入远程分支名搜索（如 oh-3.35.7）；q 退出：`);
    if (answer === null || /^q$/i.test(answer)) throw new Quit('已退出，没有生成草稿');
    let ref = '';
    if (answer === '' && candidates.length) ref = candidates[0].ref;
    else if (/^\d+$/.test(answer) && candidates[Number(answer) - 1]) ref = candidates[Number(answer) - 1].ref;
    else if (answer && await refExists(root, answer)) ref = answer;
    else if (answer) {
      const hits = await searchRemoteRefs(root, answer);
      if (!hits.length) {
        log(`没有包含「${answer}」的远程分支。远程分支不全的话，先 git fetch。`);
        continue;
      }
      candidates = await Promise.all(hits.map(async (hit) => ({ ref: hit, source: 'search', ahead: await aheadCount(root, hit) })));
      candidates.forEach((item, index) => console.log(`  ${index + 1}) ${item.ref}   领先 ${item.ahead} 个 commit`));
      continue;
    }
    if (!ref) continue;
    const ahead = await aheadCount(root, ref);
    if (ahead > 30 && !await confirm(`当前分支比 ${ref} 多 ${ahead} 个 commit，基准可能选错了。仍然用它吗？`)) continue;
    return ref;
  }
}

async function resolveBase(root, branch, opts) {
  if (opts.base) {
    if (!await refExists(root, opts.base)) throw new Error(`找不到远程分支 ${opts.base}，先 git fetch 或检查名字（格式如 origin/oh-3.35.7-release）`);
    await saveBase(root, branch, opts.base);
    return { ref: opts.base, source: 'chosen' };
  }
  const upstream = await upstreamRef(root);
  if (upstream && await aheadCount(root, upstream) > 0) return { ref: upstream, source: 'upstream' };
  const saved = await savedBase(root, branch);
  if (saved) {
    log(`沿用上次为 ${branch} 选的对比基准 ${saved}（换基准用 --base）`);
    return { ref: saved, source: 'saved' };
  }
  const candidates = await baseCandidates(root, branch);
  const reason = upstream
    ? `跟踪分支 ${upstream} 已经包含当前全部 commit（像是推过的特性分支），请选这次 PR 的对比基准：`
    : `${branch} 没有设置跟踪分支，请选它是从哪个远程分支拉出来的（PR 只包含比它多出的 commit）：`;
  if (interactive) {
    const ref = await pickBase(root, branch, candidates, reason);
    await saveBase(root, branch, ref);
    log(`对比基准 ${ref}，已记到 ${branch} 上，下次自动沿用`);
    return { ref, source: 'chosen' };
  }
  if (candidates.length) {
    log(`自动选择对比基准 ${candidates[0].ref}（领先 ${candidates[0].ahead} 个 commit），不对就用 --base 指定`);
    return { ref: candidates[0].ref, source: 'auto' };
  }
  if (upstream) return { ref: upstream, source: 'upstream' };
  log('没有找到对比基准，草稿里不会有 commit。用 --base origin/<分支> 指定。');
  return { ref: '', source: '' };
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function openBrowser(url) {
  let command = 'xdg-open';
  let args = [url];
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
  }
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => log(`请在浏览器中打开 ${url}`));
  child.unref();
}

async function gitText(cwd, args) {
  const result = await run(cwd, args);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(0, 400));
  return result.stdout.trim();
}

async function worktreeOf(root, branch) {
  const list = await gitText(root, ['worktree', 'list', '--porcelain']);
  for (const block of list.split('\n\n')) {
    if (block.includes(`branch refs/heads/${branch}`)) return block.split('\n')[0].replace(/^worktree /, '');
  }
  return '';
}

async function runPort(opts) {
  if (!opts.target) throw new Error('用法：ace pr port <目标分支>，例如 ace pr port oh-3.41.9-dev');
  const root = await repoRoot(process.cwd());
  const branch = await currentBranch(root);
  const base = await resolveBase(root, branch, opts);
  if (!base.ref) throw new Error('没有对比基准，无法确定要移植哪些 commit。用 --base origin/<分支> 指定');
  const remote = opts.remote || base.ref.split('/')[0];
  const remotes = (await gitText(root, ['remote'])).split('\n');
  if (!remotes.includes(remote)) throw new Error(`没有名为 ${remote} 的远程，用 --remote 指定目标分支所在的远程`);
  const target = opts.target.startsWith(`${remote}/`) ? opts.target.slice(remote.length + 1) : opts.target;
  if (target === base.ref.slice(remote.length + 1)) throw new Error(`${target} 就是当前分支的对比基准，不需要移植`);
  const shas = (await gitText(root, ['rev-list', '--reverse', `${base.ref}..HEAD`])).split('\n').filter(Boolean);
  if (!shas.length) throw new Error(`当前分支相对 ${base.ref} 没有 commit，没有可以移植的内容`);
  const pending = await workingChanges(root);
  if (pending.length) log(`当前目录还有 ${pending.length} 个未提交的文件，它们不会被移植。需要的话先运行 ace pr 提交。`);

  const targetRef = `${remote}/${target}`;
  if (opts.fetch) {
    log(`正在获取 ${targetRef}…`);
    const fetched = await run(root, ['fetch', '--no-tags', remote, `+refs/heads/${target}:refs/remotes/${targetRef}`]);
    if (fetched.code !== 0) throw new Error(`获取 ${targetRef} 失败：${(fetched.stderr || fetched.stdout).trim().slice(0, 300)}`);
  }
  if (!await refExists(root, targetRef)) throw new Error(`找不到 ${targetRef}，检查分支名`);

  const portBranch = `${branch}-port-${target}`.replace(/[^\w./-]+/g, '-');
  if ((await run(root, ['check-ref-format', '--branch', portBranch])).code !== 0) throw new Error(`无法用 ${portBranch} 作分支名`);
  if ((await run(root, ['show-ref', '--verify', '--quiet', `refs/heads/${portBranch}`])).code === 0) {
    const existing = await worktreeOf(root, portBranch);
    log(`已经移植过：分支 ${portBranch}${existing ? `，目录 ${existing}` : ''}`);
    log(existing ? `继续在那里修改：cd ${existing}` : `用 git worktree add <目录> ${portBranch} 重新检出`);
    return 0;
  }
  const dir = opts.dir ? resolve(opts.dir) : join(dirname(root), `${basename(root)}-ports`, target.replace(/[^\w.-]+/g, '-'));
  if (existsSync(dir)) throw new Error(`目录已存在：${dir}，用 --dir 换一个位置`);

  const preview = await simulatePick(root, targetRef, shas);
  if (!preview.ok && preview.reason !== '有冲突') throw new Error(`${preview.reason}（${preview.conflictCommit.slice(0, 8)}），请手动移植`);
  log(`把 ${branch} 的 ${shas.length} 个 commit 移植到 ${targetRef}：`);
  for (const line of (await gitText(root, ['log', '--reverse', '--format=  %h %s', `${base.ref}..HEAD`])).split('\n')) console.log(line);
  log(preview.ok
    ? '预演 cherry-pick：没有冲突。仍然需要你检查是否要按目标分支适配，并编译验证。'
    : `预演 cherry-pick：有冲突，需要你解决（${preview.conflicts.slice(0, 5).join('、')}${preview.conflicts.length > 5 ? ' 等' : ''}）。`);
  log(`移植目录 ${dir}`);
  log(`移植分支 ${portBranch}（基于 ${targetRef}）`);
  if (interactive && !opts.yes && !await confirm('创建移植目录并应用这些 commit？')) throw new Quit('已取消，没有创建移植目录');

  const group = await ensureGroup(root, branch);
  const sourceBase = await gitText(root, ['merge-base', base.ref, 'HEAD']);
  const sourceHead = await gitText(root, ['rev-parse', 'HEAD']);
  log('正在创建移植目录（大仓库检出文件需要一些时间）…');
  await mkdir(dirname(dir), { recursive: true });
  await gitText(root, ['worktree', 'add', '-b', portBranch, dir, targetRef]);
  await savePortInfo(root, portBranch, { group, fromBranch: branch, sourceBase, sourceHead, targetBranch: target, baseRef: targetRef });
  const picked = await run(dir, ['cherry-pick', '-x', ...shas]);
  if (picked.code !== 0) {
    const conflicts = (await gitText(dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
    log(`cherry-pick 停在冲突上，${conflicts.length} 个文件需要解决：`);
    for (const file of conflicts) console.log(`    ${file}`);
    log('解决后：git add <文件>，再 git cherry-pick --continue；全部完成后按下面的步骤继续。');
  } else {
    log(`已在移植目录应用 ${shas.length} 个 commit。`);
  }
  log('接下来：');
  console.log(`    cd ${dir}`);
  console.log('    # 按目标分支适配代码、编译验证，需要改的直接 commit');
  console.log('    ace pr        # 生成草稿，在工作台「移植核对」确认无误后提交');
  return 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts.port) return runPort(opts);
  const root = await repoRoot(process.cwd());
  const branch = await currentBranch(root);
  await prepareCommit(root, branch, opts);
  const base = await resolveBase(root, branch, opts);
  await ensureGroup(root, branch);
  const draft = await collectRepo(root, '', { baseRef: base.ref, baseSource: base.source });

  const dir = join(runtimeRoot(), 'pr-drafts');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${draft.id}.json`);
  const temporary = join(dir, `.${draft.id}.tmp`);
  await writeFile(temporary, JSON.stringify(draft, null, 2));
  await rename(temporary, file);

  const port = Number(process.env.AIWEB_PORT) || 8080;
  const url = `http://127.0.0.1:${port}/?draft=${encodeURIComponent(draft.id)}#p-prsubmit`;
  log(`已生成 PR 草稿 ${draft.id}`);
  log(`仓库 ${draft.repoPath}`);
  log(`分支 ${draft.headBranch}${draft.trackingRef ? `，对比 ${draft.trackingRef}` : '，没有对比基准'}`);
  log(`commit ${draft.commits.length} 个${draft.dirty ? `，另有 ${draft.dirtyFiles.length} 个未提交的文件不会进入 PR` : ''}`);
  if (draft.port) log(`移植自 ${draft.port.fromBranch}，提交前需要在工作台完成「移植核对」`);
  log(url);
  if (!(await portOpen(port))) {
    log('工作台还没在这个端口监听。先运行 ace aiweb，再用上面的地址打开。');
    return 0;
  }
  if (opts.open) openBrowser(url);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof Quit) {
    log(error.message);
    process.exitCode = 0;
  } else {
    console.error(`[ACE] ${error.message || error}`);
    process.exitCode = 1;
  }
} finally {
  rl?.close();
}
