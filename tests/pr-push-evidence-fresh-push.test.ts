import { expect, test } from 'vitest';
import { evaluatePrPushEvidence } from '@/lib/workflow/pr-push-evidence';

/**
 * 真实快照回归：推送步骤在 push 后刷新门禁，但若未刷新，gate-check.json 仍是
 * 「推送前」的 head。此时 gate.head_sha 与本次 push.commit_sha 必然不同，
 * 不能据此判定 head_changed（否则合法推送被误判 → fail → 人工确认）。
 *
 * 两条快照取自线上卡住的 run（2026-10-14）：
 *   - run-1791979081332-pr2240-3a55742f  #2240 flutter_flutter
 *   - run-1791979727228-pr1579-a88d410a  #1579 flutter_engine
 */

const PR2240 = {
  // outputs/gate-check.json（等待门禁，11:58:03Z，早于推送 11:59:38Z）
  gate: {
    phase: 'user_fix', head_sha: '82235e8211f764cc4cfc8e1cc23db0ddeaee659f',
    checked_at: '2026-10-14T11:58:03.134Z', owner: 'CPF-Flutter', repo: 'flutter_flutter', number: '2240',
  },
  // outputs/push-result.json
  push: {
    push_status: 'success', commit_sha: '84ab26683bed3c726d6bd2c9af3e2f547f491ac7',
    remote_head_sha: '84ab26683bed3c726d6bd2c9af3e2f547f491ac7', pushed_at: '2026-10-14T11:59:38Z',
  },
  // outputs/pr-comment.json
  comment: {
    ok: true, endpoint: 'pulls', body: 'start build',
    comment_id: '95ed51de9b244febaa577cd9aef303211a05675a', posted_at: '2026-10-14T12:00:34Z',
  },
};

const PR1579 = {
  gate: {
    phase: 'user_fix', head_sha: '74affd0d8cd62360903ab6ab5c99f268691e0407',
    checked_at: '2026-10-14T12:08:48.763Z', owner: 'CPF-Flutter', repo: 'flutter_engine', number: '1579',
  },
  push: {
    push_status: 'success', commit_sha: '2289a5dd0bb84276ecb7ff7b283739151c10e2d0',
    remote_head_sha: '2289a5dd0bb84276ecb7ff7b283739151c10e2d0', pushed_at: '2026-10-14T12:10:15Z',
  },
  comment: {
    ok: true, endpoint: 'pulls', body: 'start build',
    comment_id: '150c51f708affc217f62bd51b34592b8ec825009', posted_at: '2026-10-14T12:12:26Z',
  },
};

test('推送前拍的门禁快照不会把合法推送判成 head_changed', () => {
  expect(evaluatePrPushEvidence(PR2240.push, PR2240.comment, PR2240.gate))
    .toMatchObject({ success: true, verified: true, reason: null });
  expect(evaluatePrPushEvidence(PR1579.push, PR1579.comment, PR1579.gate))
    .toMatchObject({ success: true, verified: true, reason: null });
});

test('推送后才拍的门禁快照如果 head 不是本次推送，仍判 head_changed', () => {
  const after = { ...PR2240.gate, checked_at: '2026-10-14T12:05:00.000Z' }; // 晚于 pushed_at
  expect(evaluatePrPushEvidence(PR2240.push, PR2240.comment, after))
    .toMatchObject({ verified: false, reason: 'head_changed' });
  // 同一快照若 head 等于本次推送（推送步骤已按新 head 刷新）则通过
  const refreshed = { ...after, head_sha: PR2240.push.commit_sha };
  expect(evaluatePrPushEvidence(PR2240.push, PR2240.comment, refreshed))
    .toMatchObject({ verified: true, reason: null });
});

test('推送凭据仍然逐项核验：未 ack、sha 不一致、时间早于推送都不得通过', () => {
  // start build 评论早于推送完成时间
  expect(evaluatePrPushEvidence(PR2240.push, { ...PR2240.comment, posted_at: '2026-10-14T11:58:00Z' }, PR2240.gate).verified).toBe(false);
  // 远端 head 与本地待推送 commit 不一致（工作区干净不等于推送完成）
  expect(evaluatePrPushEvidence({ ...PR2240.push, remote_head_sha: 'b'.repeat(40) }, PR2240.comment, PR2240.gate).verified).toBe(false);
  // 缺 pushed_at（不可变推送时间缺失）
  expect(evaluatePrPushEvidence({ ...PR2240.push, pushed_at: undefined }, PR2240.comment, PR2240.gate).verified).toBe(false);
});
