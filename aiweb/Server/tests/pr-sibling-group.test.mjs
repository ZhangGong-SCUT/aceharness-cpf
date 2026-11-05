// 同主题跨分支可视化验收：同一问题的不同分支/仓库必须被归组并标注（不再只在"部分已检视"时才显示）。
// 用例数据取自真实 PR 总览（PR2242/2241/2240/1579/1580 等），见 run-1791946826207 快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import { branchSlug, siblingGroupKey, groupSiblingPrs } from '../prReview/client.js';

const pr = (number, repo, author, title, headRef, labels = []) => ({
    number, repo, repoFull: `CPF-Flutter/${repo}`, author, title, headRef, labels,
});

// 真实数据：同作者 z2036709353，分支 slug 都是 fix/platformchannel-reply（仅版本后缀不同），
// 标题措辞不一，且横跨 flutter_flutter 与 flutter_engine 两仓 —— 旧实现全部漏组。
const platformchannelPrs = () => [
    pr(2242, 'flutter_flutter', 'z2036709353', '[3.44.9] fix(PlatformChannel): reply for SystemSound.play and haptic failures', 'fix/platformchannel-reply-3.44.9', ['AI已检视', 'dco检查成功']),
    pr(2241, 'flutter_flutter', 'z2036709353', '[3.41.9] fix(PlatformChannel): reply for SystemSound.play and haptic failures', 'fix/platformchannel-reply-3.41.9', ['AI已检视', 'dco检查成功', '静态检查失败']),
    pr(2240, 'flutter_flutter', 'z2036709353', '[3.35.7] fix(PlatformChannel): reply when SystemSound.play is unimplemented', 'fix/platformchannel-reply-3.35.7', ['AI已检视', 'dco检查成功']),
    pr(1580, 'flutter_engine', 'z2036709353', '[3.27.4] fix(PlatformChannel): reply for sound, haptic failures, and system UI mode', 'fix/platformchannel-reply-3.27.4', ['AI已检视', 'dco检查成功']),
    pr(1579, 'flutter_engine', 'z2036709353', '[3.22.3] fix(PlatformChannel): reply for sound, haptic failures, and system UI mode', 'fix/platformchannel-reply-3.22.3', ['AI已检视', 'dco检查成功']),
];

test('branchSlug：去掉末尾版本段/预发布后缀，非版本结尾保持不变', () => {
    assert.equal(branchSlug('fix/platformchannel-reply-3.44.9'), 'fix/platformchannel-reply');
    assert.equal(branchSlug('fix/ohos-preferred-locales-3.44'), 'fix/ohos-preferred-locales');
    assert.equal(branchSlug('oh-3.41.9-dev'), 'oh');
    assert.equal(branchSlug('dev'), 'dev');
    assert.equal(branchSlug('fix/341-switch-ime'), 'fix/341-switch-ime');
    assert.equal(branchSlug(''), '');
});

test('同问题不同分支（标题不同、跨两仓）：全部 5 个归为一组', () => {
    const prs = platformchannelPrs();
    groupSiblingPrs(prs);
    for (const p of prs) {
        assert.ok(p.siblingGroup, `#${p.number} 应带上 siblingGroup`);
        assert.equal(p.siblingGroup.total, 5);
        assert.equal(p.siblingGroup.matchBy, 'branch');
        assert.deepEqual(p.siblingGroup.numbers, [1579, 1580, 2240, 2241, 2242]);
        assert.equal(p.siblingGroup.repos.length, 2);
    }
});

test('全部已检视也照样可视化（旧实现只在"部分已检视"时才写 siblingGroup）', () => {
    const prs = platformchannelPrs();
    groupSiblingPrs(prs);
    assert.equal(prs[0].siblingGroup.inconsistent, false);
    assert.equal(prs[0].siblingGroup.reviewedCount, 5);
    assert.equal(prs[0].siblingGroup.unreviewedCount, 0);
});

test('部分已检视：标 inconsistent 并给出未检视分支编号', () => {
    const prs = platformchannelPrs();
    prs[4].labels = ['dco检查成功']; // #1579 去掉 AI已检视
    groupSiblingPrs(prs);
    assert.equal(prs[4].siblingGroup.inconsistent, true);
    assert.deepEqual(prs[4].siblingGroup.unreviewedNumbers, [1579]);
    assert.deepEqual(prs[4].siblingGroup.reviewedNumbers, [1580, 2240, 2241, 2242]);
});

test('分支 slug 不同但标题（去版本前缀）相同的同仓 PR 仍归为一组', () => {
    const prs = [
        pr(1580, 'flutter_flutter', 'AndCJ', '【3.41】Fixed the issue with input status when switching input methods', 'fix/341-switch-ime', ['AI已检视']),
        pr(1579, 'flutter_flutter', 'AndCJ', '【3.35】Fixed the issue with input status when switching input methods', 'fix/335-switch-ime', []),
    ];
    groupSiblingPrs(prs);
    assert.ok(prs[0].siblingGroup);
    assert.equal(prs[0].siblingGroup.matchBy, 'title');
    assert.equal(prs[0].siblingGroup.total, 2);
    assert.equal(prs[0].siblingGroup.inconsistent, true);
});

test('不同作者 / 基础分支名 / 无关标题 不误合并', () => {
    const prs = [
        pr(1, 'flutter_flutter', 'alice', 'Fix alpha thing', 'fix/shared-slug-1.0', ['AI已检视']),
        pr(2, 'flutter_flutter', 'bob', 'Fix beta thing', 'fix/shared-slug-1.1', ['AI已检视']),
        pr(3, 'flutter_flutter', 'alice', 'Fix gamma issue', 'oh-3.44.9-dev', ['AI已检视']),
        pr(4, 'flutter_flutter', 'alice', 'Fix delta issue', 'oh-3.25.1-dev', ['AI已检视']),
    ];
    groupSiblingPrs(prs);
    for (const p of prs) assert.equal(p.siblingGroup, undefined, `#${p.number} 不应被归组`);
});

test('siblingGroupKey 仍去掉开头版本前缀', () => {
    assert.equal(siblingGroupKey('[3.44.9] fix: x'), 'fix: x');
    assert.equal(siblingGroupKey('【3.41】fix: x'), 'fix: x');
    assert.equal(siblingGroupKey('（3.41）fix: x'), 'fix: x');
});
