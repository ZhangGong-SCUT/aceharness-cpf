import test from 'node:test';
import assert from 'node:assert/strict';
import { _buildCommentChangePairs } from '../prReview/client.js';

function patchOf(files) {
    return Object.entries(files).map(([name, added]) => [
        `diff --git a/${name} b/${name}`,
        `--- a/${name}`,
        `+++ b/${name}`,
        '@@ -1 +1,2 @@',
        ' context',
        ...added.map((line) => `+${line}`),
    ].join('\n')).join('\n');
}

const orientationPatch = patchOf({
    'flutter/src/main/ets/plugin/PlatformPlugin.ets': ['    return window.Orientation.PORTRAIT;'],
    'flutter/src/main/ets/embedding/engine/systemchannels/PlatformChannel.ets': ['    return window.Orientation.PORTRAIT;'],
    'flutter/src/ohosTest/ets/test/PlatformChannel.test.ets': ['    expect(actual).assertEqual(1);'],
});

test('同一处类型修改和回归单测挂到对应意见，没有代码的意见留空', () => {
    const pairs = _buildCommentChangePairs([
        { body: 'PlatformPlugin.ets 的签名改成 window.Orientation', path: '' },
        { body: '参考 ListenableEditingState.test.ets 补回归单测', path: '' },
        { body: '请真机核对方向读回，并修改 PR 描述里的 Test Plan 措辞', path: '' },
    ], orientationPatch);

    const extras = pairs.filter((pair) => pair.isExtra).map((pair) => pair.diffFile);
    assert.deepEqual(extras, []);
    assert.deepEqual(pairs[0].diffFiles.map((file) => file.split('/').pop()), [
        'PlatformPlugin.ets',
        'PlatformChannel.ets',
    ]);
    assert.deepEqual(pairs[1].diffFiles.map((file) => file.split('/').pop()), ['PlatformChannel.test.ets']);
    assert.equal(pairs[2].hasDiff, false);
});

test('一条意见正文点名的多个补丁文件都挂上', () => {
    const pairs = _buildCommentChangePairs([
        { body: '同时改 PlatformPlugin.ets 和 PlatformChannel.ets', path: '' },
    ], orientationPatch);
    assert.deepEqual(pairs[0].diffFiles.map((file) => file.split('/').pop()), [
        'PlatformPlugin.ets',
        'PlatformChannel.ets',
    ]);
    assert.equal(pairs.filter((pair) => pair.isExtra).length, 1);
    assert.equal(pairs.find((pair) => pair.isExtra).diffFile.endsWith('PlatformChannel.test.ets'), true);
});

test('没有文件名、只剩一个文件时仍兜底挂上', () => {
    const pairs = _buildCommentChangePairs([
        { body: '这里的返回值不对', path: '' },
    ], patchOf({ 'src/Only.ets': ['    return 1;'] }));
    assert.deepEqual(pairs[0].diffFiles, ['src/Only.ets']);
    assert.equal(pairs.some((pair) => pair.isExtra), false);
});

test('多条意见没有点名文件时，不把同一份修改挂到每一条', () => {
    const comments = Array.from({ length: 8 }, (_, i) => ({ body: `整体意见 ${i}`, path: '' }));
    const pairs = _buildCommentChangePairs(comments, patchOf({ 'src/Only.ets': ['    return 1;'] }));
    assert.equal(pairs.filter((pair) => pair.hasDiff && pair.comment).length, 0);
    assert.equal(pairs.filter((pair) => pair.isExtra).length, 1);
});

test('两条意见都要求补测试时，不把唯一的新测试文件猜给其中一条', () => {
    const pairs = _buildCommentChangePairs([
        { body: '补回归单测', path: '' },
        { body: '再补一组单测', path: '' },
    ], patchOf({ 'src/New.test.ets': ['    expect(1).assertEqual(1);'] }));
    assert.equal(pairs.filter((pair) => pair.hasDiff && pair.comment).length, 0);
    assert.equal(pairs.filter((pair) => pair.isExtra).length, 1);
});

test('门禁文件不挂到检视意见，也不进附加修改', () => {
    const file = 'src/Gate.ets';
    const pairs = _buildCommentChangePairs([
        { body: `修复 ${file}`, path: '' },
    ], patchOf({ [file]: ['    return 1;'] }), [{ path: file, message: '静态检查失败' }]);
    assert.equal(pairs[0].hasDiff, false);
    assert.equal(pairs[0].gateRelated, true);
    assert.equal(pairs.some((pair) => pair.isExtra), false);
    assert.equal(pairs.some((pair) => pair.isGate && pair.diffFile === file), true);
});
