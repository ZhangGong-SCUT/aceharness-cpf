import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyChanges,
  commitSelected,
  parseIndexList,
  parsePorcelainZ,
  suggestMessage,
  workingChanges,
} from '../../../scripts/pr-commit-assist.mjs';
import { baseCandidates, savedBase } from '../../../scripts/pr-base-pick.mjs';
import { collectRepo } from '../../../scripts/pr-submit-collect.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const acePr = fileURLToPath(new URL('../../../scripts/ace-pr.mjs', import.meta.url));

function isolateGit(t, root) {
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'ACE_HOME'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.GIT_CONFIG_GLOBAL = join(root, 'empty.gitconfig');
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'me';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'me@example.com';
  process.env.ACE_HOME = join(root, 'ace-home');
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd, file, text, message) {
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

test('解析 porcelain -z：重命名、空格和中文文件名', () => {
  const raw = ' M a b.txt\0R  new.dart\0old.dart\0?? 0001-x_副本.patch\0 D gone.c\0';
  assert.deepEqual(parsePorcelainZ(raw), [
    { x: ' ', y: 'M', path: 'a b.txt', orig: '' },
    { x: 'R', y: ' ', path: 'new.dart', orig: 'old.dart' },
    { x: '?', y: '?', path: '0001-x_副本.patch', orig: '' },
    { x: ' ', y: 'D', path: 'gone.c', orig: '' },
  ]);
});

test('用真实场景的 15 个文件分类：只默认选中这次修复的源码', () => {
  const tracked = [
    'engine/src/.gn',
    'engine/src/build/config/compiler/BUILD.gn',
    'engine/src/flutter/shell/platform/ohos/flutter_embedding/flutter/src/main/ets/embedding/engine/FlutterNapi.ets',
    'engine/src/flutter/shell/platform/ohos/platform_message_handler_ohos.cpp',
    'engine/src/flutter/tools/gn',
    'packages/flutter/lib/src/widgets/element_path.dart',
    'packages/flutter/lib/src/widgets/platform_view.dart',
    'pubspec.lock',
  ];
  const untracked = [
    '0001-feat-ohos-report-tapped-widget-s-visible-text-to-XCo.patch',
    '0001-feat-ohos-report-tapped-widget-s-visible-text-to-XCo_副本.patch',
    'agent-artifacts/',
    'engine/amerate',
    'examples/platform_channel/ohos/',
    'examples/platform_view/ohos/',
    'packages/flutter/test/widgets/platform_view_creation_params_test.dart',
  ];
  const raw = [...tracked.map((p) => ` M ${p}`), ...untracked.map((p) => `?? ${p}`)].join('\0');
  const changes = classifyChanges(parsePorcelainZ(raw));
  assert.deepEqual(changes.filter((c) => c.selected).map((c) => c.path.split('/').pop()), [
    'FlutterNapi.ets', 'platform_message_handler_ohos.cpp', 'element_path.dart', 'platform_view.dart',
  ]);
  const risk = Object.fromEntries(changes.map((c) => [c.path, c.risk]));
  assert.match(risk['engine/src/.gn'], /编译配置/);
  assert.match(risk['engine/src/build/config/compiler/BUILD.gn'], /编译配置/);
  assert.match(risk['engine/src/flutter/tools/gn'], /编译配置/);
  assert.match(risk['pubspec.lock'], /锁文件/);
  assert.match(risk[untracked[0]], /补丁/);
  assert.match(risk[untracked[1]], /补丁|副本/);
  assert.match(risk['agent-artifacts/'], /AI 或工具产物/);
  assert.equal(risk['packages/flutter/test/widgets/platform_view_creation_params_test.dart'], '', '新测试文件没有风险，只是未跟踪');
  assert.equal(changes.find((c) => c.path.endsWith('_test.dart')).selected, false, '新文件要明确选择');
});

test('密钥、签名配置、产物和冲突文件不会默认选中', () => {
  const raw = [
    ' M ohos/build-profile.json5', ' M ohos/sign/release.p12', '?? .env.local', '?? build/app.hap',
    ' M build/config/BUILD.gn', 'UU lib/conflict.dart', ' M lib/ok.dart', '?? debug.log',
  ].join('\0');
  const changes = classifyChanges(parsePorcelainZ(raw));
  assert.deepEqual(changes.filter((c) => c.selected).map((c) => c.path), ['lib/ok.dart']);
  assert.match(changes[0].risk, /签名配置/);
  assert.match(changes[1].risk, /证书/);
  assert.match(changes[2].risk, /密钥|令牌/);
  assert.match(changes[3].risk, /编译产物/);
  assert.match(changes[5].risk, /冲突/);
});

test('编号输入和默认提交信息', () => {
  assert.deepEqual(parseIndexList('2 5-7，9', 10), [1, 4, 5, 6, 8]);
  assert.equal(parseIndexList('0', 3), null);
  assert.equal(parseIndexList('4', 3), null);
  assert.equal(parseIndexList('x', 3), null);
  const changes = [{ path: 'lib/a.dart', selected: true }, { path: 'lib/b.dart', selected: true }, { path: 'c', selected: false }];
  assert.equal(suggestMessage(changes, 'build-962f0a48'), 'fix(ohos): 修改 a.dart 等 2 个文件');
  assert.equal(suggestMessage(changes, 'fix/locale-fallback'), 'fix: locale fallback');
});

test('只提交选中的文件：已暂存的无关改动和未选文件保持原样', async (t) => {
  const root = mkdtempSync(join(here, 'commit-assist-'));
  isolateGit(t, root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'keep.txt', 'base\n', 'base');
  writeFileSync(join(repo, 'staged-other.txt'), 'x\n');
  git(repo, 'add', 'staged-other.txt');
  commit(repo, 'gone.txt', 'bye\n', 'add gone');
  writeFileSync(join(repo, 'keep.txt'), 'changed\n');
  rmSync(join(repo, 'gone.txt'));
  writeFileSync(join(repo, 'new file.dart'), 'new\n');
  writeFileSync(join(repo, 'fix.patch'), 'patch\n');

  const changes = await workingChanges(repo);
  for (const item of changes) item.selected = ['keep.txt', 'gone.txt', 'new file.dart'].includes(item.path);
  const result = await commitSelected(repo, changes, 'fix: 只提交选中的', { signoff: true });
  assert.equal(result.count, 3);
  const shown = git(repo, 'show', '--name-status', '--format=%B', 'HEAD');
  assert.match(shown, /fix: 只提交选中的/);
  assert.match(shown, /Signed-off-by: me <me@example.com>/);
  assert.match(shown, /M\tkeep\.txt/);
  assert.match(shown, /D\tgone\.txt/);
  assert.match(shown, /A\tnew file\.dart/);
  assert.doesNotMatch(shown, /fix\.patch|staged-other/);
  const left = git(repo, 'status', '--porcelain');
  assert.match(left, /\?\? fix\.patch/);
});

test('没有跟踪分支时找到分叉的远程分支，排除推过的同名特性分支', async (t) => {
  const root = mkdtempSync(join(here, 'base-pick-'));
  isolateGit(t, root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', 'https://gitcode.com/CPF-Flutter/demo.git');
  git(repo, 'remote', 'add', 'myfork', 'https://gitcode.com/me/demo.git');
  commit(repo, 'a.txt', '1\n', 'c1');
  const c2 = commit(repo, 'a.txt', '2\n', 'c2');
  git(repo, 'update-ref', 'refs/remotes/myfork/main', c2);
  const c3 = commit(repo, 'a.txt', '3\n', 'c3 上游又往前走了');
  git(repo, 'update-ref', 'refs/remotes/origin/main', c3);
  git(repo, 'update-ref', 'refs/remotes/origin/oh-3.41.9-dev', c2);
  git(repo, 'checkout', '-q', '-b', 'build-xyz', c2);
  commit(repo, 'b.txt', 'f1\n', 'feat: 第一步');
  const head = commit(repo, 'b.txt', 'f2\n', 'feat: 第二步');
  git(repo, 'update-ref', 'refs/remotes/myfork/build-xyz', head);

  const candidates = await baseCandidates(repo, 'build-xyz');
  assert.deepEqual(candidates.map((c) => [c.ref, c.ahead]), [
    ['origin/main', 2], ['origin/oh-3.41.9-dev', 2], ['myfork/main', 2],
  ]);
  git(repo, 'config', 'branch.build-xyz.vscode-merge-base', 'origin/oh-3.41.9-dev');
  const withEditor = await baseCandidates(repo, 'build-xyz');
  assert.equal(withEditor[0].ref, 'origin/oh-3.41.9-dev');
  assert.equal(withEditor[0].source, 'editor');

  const draft = await collectRepo(repo, 'prd-00000001', { baseRef: 'origin/oh-3.41.9-dev', baseSource: 'chosen' });
  assert.deepEqual(draft.commits.map((c) => c.subject), ['feat: 第一步', 'feat: 第二步']);
  assert.equal(draft.trackingBranch, 'oh-3.41.9-dev');
  assert.equal(draft.baseSource, 'chosen');
  assert.equal(draft.suggestedTarget, 'CPF-Flutter/demo');
});

function runAcePr(cwd, ...args) {
  const result = spawnSync(process.execPath, [acePr, '--no-open', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, AIWEB_PORT: '9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function latestDraft(root) {
  const dir = join(root, 'ace-home', 'pr-drafts');
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  const drafts = files.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  return drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

test('ace pr 命令：不交互提交、自动选基准、--base 记住并沿用', async (t) => {
  const root = mkdtempSync(join(here, 'ace-pr-cli-'));
  isolateGit(t, root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', 'https://gitcode.com/CPF-Flutter/demo.git');
  const c1 = commit(repo, 'lib/a.dart', 'a\n', 'base');
  git(repo, 'update-ref', 'refs/remotes/origin/oh-3.35.7-release', c1);
  commit(repo, 'lib/a.dart', 'a2\n', 'upstream moved');
  git(repo, 'update-ref', 'refs/remotes/origin/oh-3.35.7-release', git(repo, 'rev-parse', 'HEAD'));
  git(repo, 'checkout', '-q', '-b', 'build-962f0a48', c1);
  writeFileSync(join(repo, 'lib/a.dart'), 'fixed\n');
  writeFileSync(join(repo, 'lib/new.dart'), 'new\n');
  writeFileSync(join(repo, 'fix.patch'), 'p\n');

  let run = runAcePr(repo, '--commit');
  assert.equal(run.code, 1);
  assert.match(run.out, /需要 -m/);

  run = runAcePr(repo, '--commit', '-m', 'fix: locale 回退', '--include', 'lib/new.dart');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /已提交 2 个文件/);
  assert.match(run.out, /还有 1 个文件没提交，不会进入 PR：fix\.patch/);
  assert.match(run.out, /自动选择对比基准 origin\/oh-3\.35\.7-release（领先 1 个 commit）/);
  assert.match(run.out, /工作台还没在这个端口监听/);
  let draft = latestDraft(root);
  assert.deepEqual(draft.commits.map((c) => c.subject), ['fix: locale 回退']);
  assert.deepEqual(draft.files.map((f) => f.path).sort(), ['lib/a.dart', 'lib/new.dart']);
  assert.equal(draft.baseSource, 'auto');
  assert.equal(draft.trackingBranch, 'oh-3.35.7-release');
  assert.equal(draft.suggestedTarget, 'CPF-Flutter/demo');
  assert.deepEqual(draft.dirtyFiles, ['fix.patch']);
  assert.equal(await savedBase(repo, 'build-962f0a48'), '', '自动选择不写配置');

  run = runAcePr(repo, '--base', 'origin/nope');
  assert.equal(run.code, 1);
  assert.match(run.out, /找不到远程分支 origin\/nope/);

  run = runAcePr(repo, '--base', 'origin/oh-3.35.7-release');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /工作区有 1 个未提交的文件，它们不会进入 PR/);
  assert.equal(await savedBase(repo, 'build-962f0a48'), 'origin/oh-3.35.7-release');

  run = runAcePr(repo, '--no-commit');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /沿用上次为 build-962f0a48 选的对比基准 origin\/oh-3\.35\.7-release/);
  draft = latestDraft(root);
  assert.equal(draft.baseSource, 'saved');
  assert.equal(draft.commits.length, 1);
  assert.ok(existsSync(join(repo, 'fix.patch')));
});
