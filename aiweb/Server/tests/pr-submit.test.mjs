import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  forkRemote,
  headBranchFor,
  parseGitRemote,
  parseIssueRef,
  parseRemoteLines,
  prBody,
  skillPrBody,
  issueLabel,
  suggestedTarget,
  validateSubmitRequest,
} from '../../../scripts/pr-submit-plan.mjs';
import { collectRepo } from '../../../scripts/pr-submit-collect.mjs';
import { listDrafts, writeDraft } from '../prSubmit/store.js';
import { draftFileDiff, renamePaths } from '../prSubmit/service.js';

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  });
}

test('远程地址去掉凭据，并识别 https 与 git@', () => {
  assert.deepEqual(parseGitRemote('https://oauth2:secret@gitcode.com/CPF-Flutter/flutter_flutter.git'), {
    host: 'gitcode.com', owner: 'CPF-Flutter', repo: 'flutter_flutter',
  });
  assert.equal(parseGitRemote('git@gitcode.com:me/flutter_flutter.git').owner, 'me');
});

test('跟踪分支、fork 和 Issue 编号按提交规则判断', () => {
  const remotes = parseRemoteLines([
    'origin\thttps://gitcode.com/me/flutter_flutter.git (fetch) [blob:none]',
    'origin\thttps://gitcode.com/me/flutter_flutter.git (push)',
    'upstream\tgit@gitcode.com:CPF-Flutter/flutter_flutter.git (fetch)',
  ].join('\n'));
  assert.equal(suggestedTarget(remotes), 'CPF-Flutter/flutter_flutter');
  assert.equal(forkRemote(remotes, 'me', 'CPF-Flutter/flutter_flutter').name, 'origin');
  assert.equal(parseIssueRef('https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2787').number, '2787');
  assert.equal(prBody('修复空语言', '2787'), '修复空语言\n\n#2787');
  assert.equal(prBody('见 #2787', '2787'), '见 #2787');
  assert.equal(issueLabel('fix: locale'), 'bug');
  assert.equal(issueLabel('没有前缀'), '');
  const body = skillPrBody({ description: 'fix locale\n\nSigned-off-by: A <a@b>', issueNumber: '2787', base: 'oh-3.35.7-dev' });
  assert.match(body, /## Why are these changes being made\?/);
  assert.match(body, /oh-3\.35\.7-dev/);
  assert.match(body, /#2787\b/);
  assert.doesNotMatch(body, /Signed-off-by/);
  assert.equal(headBranchFor('prd-ab12cd34', 'br_3.41_dev'), 'submit/ab12cd34/br_3.41_dev');
});

test('空提交和非法分支不能确认；未提交文件不影响确认', () => {
  const draft = { status: 'draft', dirty: true, commits: [{ sha: 'abc', subject: 'fix' }] };
  const request = { target: 'CPF-Flutter/flutter_flutter', bases: ['br_3.41_dev'], title: '修复', issue: { mode: 'none' } };
  assert.equal(validateSubmitRequest(draft, request).ok, true, 'PR 只包含 commit，工作区剩下的文件不会被推送');
  const empty = validateSubmitRequest({ ...draft, commits: [] }, request);
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join(), /没有可提交的 commit/);
  const clean = { ...draft, dirty: false };
  const good = validateSubmitRequest(clean, {
    target: 'CPF-Flutter/flutter_flutter',
    bases: ['br_3.41_dev', 'oh-3.35.7-release', 'br_3.41_dev'],
    title: '修复',
    issue: { mode: 'existing', url: '#12' },
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.bases, ['br_3.41_dev', 'oh-3.35.7-release']);
  assert.equal(good.issue.number, '12');
  assert.equal(validateSubmitRequest(clean, {
    target: 'not a repo', bases: ['../main'], title: '', issue: { mode: 'create', title: '' },
  }).ok, false);
});

test('本地仓库能采集跟踪分支上的 commit，并记下未提交的文件', async () => {
  const dir = await mkdtemp(join(fileURLToPath(new URL('.', import.meta.url)), 'ace-pr-'));
  try {
    await git(dir, ['init', '-b', 'topic']);
    await git(dir, ['config', 'user.email', 'test@example.com']);
    await git(dir, ['config', 'user.name', 'test']);
    await writeFile(join(dir, 'a.txt'), 'one\n');
    await git(dir, ['add', 'a.txt']);
    await git(dir, ['commit', '-m', 'base']);
    await git(dir, ['remote', 'add', 'upstream', 'https://oauth2:secret@gitcode.com/CPF-Flutter/flutter_flutter.git']);
    await git(dir, ['update-ref', 'refs/remotes/upstream/base', 'HEAD']);
    await git(dir, ['branch', '--set-upstream-to', 'upstream/base']);
    await writeFile(join(dir, 'a.txt'), 'two\n');
    await git(dir, ['add', 'a.txt']);
    await git(dir, ['commit', '-m', '修复空语言']);
    const clean = await collectRepo(dir, 'prd-ab12cd34');
    assert.equal(clean.dirty, false);
    assert.equal(clean.commits.length, 1);
    assert.equal(clean.commits[0].subject, '修复空语言');
    assert.equal(clean.suggestedTarget, 'CPF-Flutter/flutter_flutter');
    assert.equal(clean.trackingBranch, 'base');
    assert.equal(JSON.stringify(clean).includes('secret'), false);
    await writeFile(join(dir, 'a.txt'), 'dirty\n');
    await writeFile(join(dir, '中文 副本.patch'), 'p\n');
    const dirty = await collectRepo(dir, 'prd-ab12cd34');
    assert.equal(dirty.dirty, true);
    assert.deepEqual(dirty.dirtyFiles, ['a.txt', '中文 副本.patch']);
    assert.equal(dirty.baseSource, 'upstream');
    assert.deepEqual(dirty.commits.map((c) => c.sha), clean.commits.map((c) => c.sha));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('单个文件 diff：只含已提交内容，支持重命名，拒绝草稿以外的路径', async () => {
  const dir = await mkdtemp(join(fileURLToPath(new URL('.', import.meta.url)), 'ace-pr-'));
  try {
    await git(dir, ['init', '-b', 'topic']);
    await git(dir, ['config', 'user.email', 'test@example.com']);
    await git(dir, ['config', 'user.name', 'test']);
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    await writeFile(join(dir, 'src', 'old.dart'), 'void main() {\n  print(1);\n  print(2);\n  print(3);\n}\n');
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', 'base']);
    await git(dir, ['remote', 'add', 'upstream', 'https://gitcode.com/CPF-Flutter/flutter_flutter.git']);
    await git(dir, ['update-ref', 'refs/remotes/upstream/base', 'HEAD']);
    await git(dir, ['branch', '--set-upstream-to', 'upstream/base']);
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\nthree\n');
    await git(dir, ['mv', 'src/old.dart', 'src/new.dart']);
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', '修改并重命名']);
    await writeFile(join(dir, 'a.txt'), 'not committed\n');

    const draft = await collectRepo(dir, 'prd-ab12cd34');
    const paths = draft.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['a.txt', 'src/{old.dart => new.dart}']);

    const a = await draftFileDiff(draft, 'a.txt');
    assert.equal(a.truncated, false);
    assert.match(a.diff, /^-two$/m);
    assert.match(a.diff, /^\+TWO$/m);
    assert.doesNotMatch(a.diff, /not committed/, '工作区未提交的改动不进 diff');

    const renamed = await draftFileDiff(draft, 'src/{old.dart => new.dart}');
    assert.match(renamed.diff, /rename from src\/old\.dart/);
    assert.match(renamed.diff, /rename to src\/new\.dart/);

    await assert.rejects(draftFileDiff(draft, '../etc/passwd'), /不在本次改动里/);
    await assert.rejects(draftFileDiff({ ...draft, headSha: '0'.repeat(40) }, 'a.txt'), /重新运行 ace pr/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('重命名路径拆成两侧真实路径', () => {
  assert.deepEqual(renamePaths('src/{old.dart => new.dart}'), ['src/old.dart', 'src/new.dart']);
  assert.deepEqual(renamePaths('lib/{ => sub}/a.dart'), ['lib/a.dart', 'lib/sub/a.dart']);
  assert.deepEqual(renamePaths('{a => b}/x.dart'), ['a/x.dart', 'b/x.dart']);
  assert.deepEqual(renamePaths('old.txt => new.txt'), ['old.txt', 'new.txt']);
  assert.deepEqual(renamePaths('普通 文件.dart'), ['普通 文件.dart']);
});

test('最近草稿按生成时间倒序，忽略无关文件', async () => {
  const home = await mkdtemp(join(fileURLToPath(new URL('.', import.meta.url)), 'ace-home-'));
  const previous = process.env.ACE_HOME;
  process.env.ACE_HOME = home;
  try {
    assert.deepEqual(await listDrafts(), []);
    await writeDraft({ id: 'prd-aaaaaaaa', createdAt: '2026-11-13T01:00:00.000Z', repoPath: '/w/a', headBranch: 'a', title: 'old', commits: [{}], dirty: false, results: null });
    await writeDraft({
      id: 'prd-bbbbbbbb', createdAt: '2026-11-13T02:00:00.000Z', status: 'partial', repoPath: '/w/b', headBranch: 'b', title: 'new', commits: [{}, {}], dirty: true,
      results: { pulls: [{ base: 'x', url: 'u', number: 1 }, { base: 'y', error: 'e' }] },
    });
    await writeFile(join(home, 'pr-drafts', 'notes.json'), '{}');
    await writeFile(join(home, 'pr-drafts', 'prd-cccccccc.json'), 'not json');
    const drafts = await listDrafts();
    assert.deepEqual(drafts.map((item) => item.id), ['prd-bbbbbbbb', 'prd-aaaaaaaa']);
    assert.deepEqual(drafts[0], {
      id: 'prd-bbbbbbbb', createdAt: '2026-11-13T02:00:00.000Z', status: 'partial', repoPath: '/w/b', headBranch: 'b', trackingBranch: '', groupId: '', port: null,
      title: 'new', commits: 2, dirty: true, pulls: 1, pullList: [{ base: 'x', number: 1, url: 'u' }],
    });
    assert.equal((await listDrafts(1)).length, 1);
  } finally {
    if (previous === undefined) delete process.env.ACE_HOME;
    else process.env.ACE_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
