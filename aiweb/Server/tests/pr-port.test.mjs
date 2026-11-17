import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePort, portInfo, simulatePick, splitDiff } from '../../../scripts/pr-port.mjs';
import { collectRepo } from '../../../scripts/pr-submit-collect.mjs';
import { portCheck, verifyPort } from '../prSubmit/service.js';
import { listDrafts, writeDraft } from '../prSubmit/store.js';

const ACE_PR = resolve(fileURLToPath(import.meta.url), '../../../../scripts/ace-pr.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function commitFile(cwd, file, text, message) {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'ace-pr-port-'));
  const saved = {
    ACE_HOME: process.env.ACE_HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  t.after(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.ACE_HOME = join(root, 'ace-home');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = join(root, 'empty.gitconfig');
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\temail = me@example.com\n\tname = me\n');
  return root;
}

const diff = (path, ...lines) => [
  `diff --git a/${path} b/${path}`,
  'index 1111111..2222222 100644',
  `--- a/${path}`,
  `+++ b/${path}`,
  '@@ -1,3 +1,3 @@',
  ...lines,
].join('\n');

test('逐文件比较源改动和目标改动：一致、有适配、目标没改、目标多改', () => {
  const source = [
    diff('a.dart', ' ctx', '-old()', '+fixed()'),
    diff('b.dart', '-x', '+y'),
    diff('c.dart', '-p', '+q'),
  ].join('\n');
  const target = [
    diff('a.dart', ' other ctx', '-old()', '+fixed()').replace('@@ -1,3 +1,3 @@', '@@ -40,3 +40,3 @@'),
    diff('b.dart', '-x', '+y2'),
    diff('d.dart', '-m', '+n'),
  ].join('\n');
  assert.deepEqual(splitDiff(source).map((file) => file.path), ['a.dart', 'b.dart', 'c.dart']);
  const { files, summary } = comparePort(source, target);
  assert.deepEqual(summary, { same: 1, adapted: 1, missing: 1, extra: 1 });
  assert.deepEqual(files.map((file) => [file.path, file.status]), [
    ['c.dart', 'missing'], ['d.dart', 'extra'], ['b.dart', 'adapted'], ['a.dart', 'same'],
  ]);
  assert.equal(files[0].target, '');
  assert.match(files[2].target, /\+y2/);
});

test('预演 cherry-pick 不碰工作区：干净、冲突、目标已包含', async (t) => {
  const root = sandbox(t);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  commitFile(repo, 'b.txt', 'base\n', 'base');
  git(repo, 'branch', 'release');
  git(repo, 'branch', 'conflict');
  git(repo, 'checkout', '-q', '-b', 'topic');
  commitFile(repo, 'a.txt', 'fixed\n', 'fix a');
  const fix = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'release');
  commitFile(repo, 'b.txt', 'release\n', 'release only');
  git(repo, 'checkout', '-q', 'conflict');
  commitFile(repo, 'a.txt', 'other\n', 'other a');
  git(repo, 'checkout', '-q', 'topic');

  const clean = await simulatePick(repo, 'release', [fix]);
  assert.equal(clean.ok, true);
  assert.equal(git(repo, 'show', `${clean.sha}:a.txt`), 'fixed');
  assert.equal(git(repo, 'show', `${clean.sha}:b.txt`), 'release');
  assert.equal(git(repo, 'rev-parse', `${clean.sha}^`), git(repo, 'rev-parse', 'release'));
  assert.match(git(repo, 'log', '-1', '--format=%B', clean.sha), new RegExp(`cherry picked from commit ${fix}`));

  const conflict = await simulatePick(repo, 'conflict', [fix]);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, '有冲突');
  assert.deepEqual(conflict.conflicts, ['a.txt']);
  assert.equal(conflict.conflictCommit, fix);

  const contained = await simulatePick(repo, clean.sha, [fix]);
  assert.equal(contained.ok, true);
  assert.equal(contained.sha, clean.sha);
  assert.deepEqual(contained.skipped, [fix]);

  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'topic');
});

test('ace pr port 在独立目录里移植，适配后的草稿必须核对并写说明', async (t) => {
  const root = sandbox(t);
  const upstream = join(root, 'upstream.git');
  git(root, 'init', '-q', '--bare', upstream);
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'locale.dart'), 'String pick(l) {\n  return l;\n}\n');
  commitFile(seed, 'other.dart', 'base\n', 'base');
  git(seed, 'push', '-q', upstream, 'main');
  git(seed, 'checkout', '-q', '-b', 'br_3.41_dev');
  commitFile(seed, 'other.dart', 'release\n', 'release line');
  git(seed, 'push', '-q', upstream, 'br_3.41_dev');

  const work = join(root, 'flutter');
  git(root, 'clone', '-q', upstream, work);
  git(work, 'checkout', '-q', '-b', 'fix-locale', 'origin/main');
  git(work, 'branch', '--set-upstream-to', 'origin/main');
  commitFile(work, 'locale.dart', 'String pick(l) {\n  return l.isEmpty ? system() : l;\n}\n', '修复空语言时的 locale 回退');
  const sourceHead = git(work, 'rev-parse', 'HEAD');

  const cli = (...args) => spawnSync(process.execPath, [ACE_PR, 'pr', ...args], { cwd: work, encoding: 'utf8', env: process.env });
  const same = cli('port', 'main', '-y');
  assert.equal(same.status, 1);
  assert.match(same.stderr, /就是当前分支的对比基准/);

  const done = cli('port', 'br_3.41_dev', '-y');
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /预演 cherry-pick：没有冲突/);
  const dir = join(root, 'flutter-ports', 'br_3.41_dev');
  assert.equal(existsSync(join(dir, 'locale.dart')), true);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix-locale-port-br_3.41_dev');
  assert.match(readFileSync(join(dir, 'locale.dart'), 'utf8'), /system\(\)/);
  assert.equal(readFileSync(join(dir, 'other.dart'), 'utf8'), 'release\n');
  assert.equal(git(work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix-locale');
  assert.equal(git(work, 'status', '--porcelain'), '');

  const group = git(work, 'config', 'branch.fix-locale.aceGroup');
  assert.match(group, /^prg-[a-f0-9]{8}$/);
  assert.equal(git(work, 'config', 'branch.fix-locale-port-br_3.41_dev.aceGroup'), group);
  const info = await portInfo(dir, 'fix-locale-port-br_3.41_dev');
  assert.equal(info.fromBranch, 'fix-locale');
  assert.equal(info.sourceHead, sourceHead);
  assert.equal(info.targetBranch, 'br_3.41_dev');

  const again = cli('port', 'br_3.41_dev', '-y');
  assert.equal(again.status, 0);
  assert.match(again.stdout, /已经移植过/);

  commitFile(dir, 'locale.dart', 'String pick(l) {\n  return l.isEmpty ? systemLocale() : l;\n}\n', '3.41 上接口叫 systemLocale');
  const draft = await collectRepo(dir, 'prd-0000a001', { baseRef: 'origin/br_3.41_dev', baseSource: 'saved' });
  assert.equal(draft.groupId, group);
  assert.equal(draft.trackingBranch, 'br_3.41_dev');
  assert.equal(draft.port.fromBranch, 'fix-locale');
  assert.equal(draft.commits.length, 2);
  assert.equal(draft.title, '修复空语言时的 locale 回退', 'PR 标题沿用源分支，不用适配 commit 的标题');

  const check = await portCheck(draft);
  assert.equal(check.kind, 'port');
  assert.equal(check.from, 'fix-locale');
  assert.equal(check.to, 'br_3.41_dev');
  assert.deepEqual(check.summary, { same: 0, adapted: 1, missing: 0, extra: 0 });
  assert.match(check.files[0].source, /\+  return l\.isEmpty \? system\(\) : l;/);
  assert.match(check.files[0].target, /systemLocale/);
  await assert.rejects(() => verifyPort(draft, '', check.key, ' ', 'me'), /请写一句说明/);
  await verifyPort(draft, '', check.key, '3.41 上接口改名为 systemLocale，已编译验证', 'me');
  assert.equal((await portCheck(draft)).verification.note, '3.41 上接口改名为 systemLocale，已编译验证');

  await writeDraft({ ...draft, createdAt: new Date().toISOString() });
  const [listed] = await listDrafts();
  assert.equal(listed.groupId, group);
  assert.deepEqual(listed.port, { fromBranch: 'fix-locale', verified: true });

  commitFile(dir, 'locale.dart', 'String pick(l) {\n  return l;\n}\n', 'oops');
  const changed = await collectRepo(dir, 'prd-0000a002', { baseRef: 'origin/br_3.41_dev', baseSource: 'saved' });
  assert.equal((await portCheck(changed)).verification, null);
});

test('移植时有冲突：目录照样建好，停在冲突上让人解决', (t) => {
  const root = sandbox(t);
  const upstream = join(root, 'upstream.git');
  git(root, 'init', '-q', '--bare', upstream);
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  commitFile(seed, 'a.txt', 'base\n', 'base');
  git(seed, 'push', '-q', upstream, 'main');
  git(seed, 'checkout', '-q', '-b', 'oh-3.35');
  commitFile(seed, 'a.txt', 'old api\n', 'old api');
  git(seed, 'push', '-q', upstream, 'oh-3.35');

  const work = join(root, 'repo');
  git(root, 'clone', '-q', upstream, work);
  git(work, 'checkout', '-q', '-b', 'fix', 'origin/main');
  git(work, 'branch', '--set-upstream-to', 'origin/main');
  commitFile(work, 'a.txt', 'fixed\n', 'fix');

  const dir = join(root, 'elsewhere');
  const result = spawnSync(process.execPath, [ACE_PR, 'pr', 'port', 'origin/oh-3.35', '--dir', dir, '-y'], { cwd: work, encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /预演 cherry-pick：有冲突，需要你解决（a\.txt）/);
  assert.match(result.stdout, /cherry-pick 停在冲突上，1 个文件需要解决/);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix-port-oh-3.35');
  assert.match(git(dir, 'status', '--porcelain'), /^UU a\.txt/m);
  assert.equal(git(work, 'status', '--porcelain'), '');
});
