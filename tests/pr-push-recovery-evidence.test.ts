import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecoverablePush } from '@/lib/workflow/pr-push-recovery';

/**
 * 真实快照回归（2026-10-14 卡在人工确认的两个 run）：
 *   - run-1791979081332-pr2240-3a55742f  #2240 flutter_flutter
 *   - run-1791979727228-pr1579-a88d410a  #1579 flutter_engine
 *
 * 这两次推送成功后，推送步骤既没刷新 gate-check.json（gate 仍是推送前 head），
 * 也没在 push-result.json 里写 branch/remote（只写了 push_target）。
 * 旧逻辑把前者判成 head_changed，又因理由白名单与 branch/remote 缺失而拒绝自愈，
 * 于是永久停在人工确认。修复后应可对账恢复。
 */

const workspace = vi.hoisted(() => ({ root: '' }));
vi.mock('@/lib/core/app-paths', () => ({ getWorkspaceRoot: () => workspace.root }));

const CONTEXT = `owner: CPF-Flutter\nrepo: flutter_flutter\nnumber: 2240\n`
  + `head_ref: fix/platformchannel-reply-3.35.7\nhead_repo: z2036709353/flutter_flutter\n`;

const PUSH = {
  push_status: 'success', attempted_at: '2026-10-14T11:58:32Z',
  commit_sha: '84ab26683bed3c726d6bd2c9af3e2f547f491ac7',
  remote_head_sha: '84ab26683bed3c726d6bd2c9af3e2f547f491ac7',
  pushed_at: '2026-10-14T11:59:38Z',
  push_target: 'z2036709353/flutter_flutter@fix/platformchannel-reply-3.35.7',
};
const COMMENT = { ok: true, endpoint: 'pulls', body: 'start build',
  comment_id: '95ed51de9b244febaa577cd9aef303211a05675a', posted_at: '2026-10-14T12:00:34.540Z' };
// 等待门禁写入 gate-check.json：早于推送（11:58:03Z < 11:59:38Z），head 为推送前基线
const GATE = { phase: 'user_fix', head_sha: '82235e8211f764cc4cfc8e1cc23db0ddeaee659f',
  checked_at: '2026-10-14T11:58:03.134Z' };
const AUDIT = { commit_sha: PUSH.commit_sha, remote_head_sha: PUSH.remote_head_sha,
  push_verified: true, build_comment_id: COMMENT.comment_id, verified: false,
  reason: 'head_changed', checked_at: '2026-10-14T12:06:50.163Z' };

const runId = 'run-1791979081332-pr2240-3a55742f';
let work = '';

beforeEach(async () => {
  workspace.root = await mkdtemp(join(tmpdir(), 'pr-recover-'));
  work = join(workspace.root, runId);
  await mkdir(join(work, 'outputs'), { recursive: true });
  for (const [name, data] of Object.entries({ 'push-result.json': PUSH, 'pr-comment.json': COMMENT,
    'gate-check.json': GATE, 'pr-push-audit.json': AUDIT })) {
    await writeFile(join(work, 'outputs', name), JSON.stringify(data));
  }
});
afterEach(async () => { await rm(workspace.root, { recursive: true, force: true }); });

const state = (over: any = {}) => ({ status: 'running', pendingHumanQuestionId: 'q', globalContext: CONTEXT,
  humanQuestions: [{ id: 'q', status: 'unanswered', previousState: '人工确认' }],
  stateHistory: [{ from: '推送并触发', to: '人工确认' }], ...over });

test('推送前门禁快照导致的假 head_changed，凭 push_target 绑定后可对账恢复', async () => {
  const recovered = await readRecoverablePush({ runId, workingDirectory: work, state: state() });
  expect(recovered).toBeTruthy();
  expect(recovered.questionId).toBe('q');
  expect(recovered.push.commit_sha).toBe(PUSH.commit_sha);
});

test('push_target 指向别的仓库/分支时不得恢复', async () => {
  await writeFile(join(work, 'outputs/push-result.json'),
    JSON.stringify({ ...PUSH, push_target: 'z2036709353/flutter_engine@fix/other-3.35.7' }));
  expect(await readRecoverablePush({ runId, workingDirectory: work, state: state() })).toBeNull();
});

test('门禁快照晚于推送且 head 不同（真 head_changed）仍拒绝恢复', async () => {
  await writeFile(join(work, 'outputs/gate-check.json'),
    JSON.stringify({ ...GATE, checked_at: '2026-10-14T12:05:00.000Z' }));
  expect(await readRecoverablePush({ runId, workingDirectory: work, state: state() })).toBeNull();
});

test('非推送并触发进入的人工确认、以及已验证的审计不参与恢复', async () => {
  expect(await readRecoverablePush({ runId, workingDirectory: work,
    state: state({ stateHistory: [{ from: '编译修复', to: '人工确认' }] }) })).toBeNull();
  await writeFile(join(work, 'outputs/pr-push-audit.json'),
    JSON.stringify({ ...AUDIT, verified: true, reason: null }));
  expect(await readRecoverablePush({ runId, workingDirectory: work, state: state() })).toBeNull();
});

test('push-result 无分支字段时改用门禁快照的 PR 身份绑定（真实 pr1579 形态）', async () => {
  await writeFile(join(work, 'outputs/push-result.json'), JSON.stringify({ ...PUSH, push_target: undefined }));
  await writeFile(join(work, 'outputs/gate-check.json'), JSON.stringify({ ...GATE, own_pr: true,
    head_repo: 'z2036709353/flutter_flutter', head_ref: 'fix/platformchannel-reply-3.35.7' }));
  expect(await readRecoverablePush({ runId, workingDirectory: work, state: state() })).toBeTruthy();
  await writeFile(join(work, 'outputs/gate-check.json'), JSON.stringify({ ...GATE, own_pr: true,
    head_repo: 'z2036709353/flutter_engine', head_ref: 'fix/platformchannel-reply-3.22.3' }));
  expect(await readRecoverablePush({ runId, workingDirectory: work, state: state() })).toBeNull();
});

test('完整 branch/remote 凭据仍按原绑定校验', async () => {
  await writeFile(join(work, 'outputs/push-result.json'), JSON.stringify({
    ...PUSH, push_target: undefined,
    branch: 'fix/platformchannel-reply-3.35.7',
    remote: 'https://z2036709353@gitcode.com/z2036709353/flutter_flutter.git',
  }));
  expect(await readRecoverablePush({ runId, workingDirectory: work, state: state() })).toBeTruthy();
  await writeFile(join(work, 'outputs/push-result.json'), JSON.stringify({
    ...PUSH, push_target: undefined,
    branch: 'fix/platformchannel-reply-3.35.7',
    remote: 'https://z2036709353@gitcode.com/z2036709353/flutter_engine.git',
  }));
  expect(await readRecoverablePush({ runId, workingDirectory: work, state: state() })).toBeNull();
});
