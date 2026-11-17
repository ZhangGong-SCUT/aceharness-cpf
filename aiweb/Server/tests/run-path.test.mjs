import test from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { isIsolatedRunDir, readWorkingDirectory } from '../library/runPath.js';

const runId = 'run-1794464498863-pr13-61bba307';

test('带空格的 Windows 路径按 yaml 实际写出的样子读回', () => {
    const dir = `C:\\Users\\Ada Lovelace\\AppData\\Roaming\\ACEHarness\\run-workspaces\\${runId}`;
    const yaml = '# Auto-generated run state\n' + stringify({ workingDirectory: dir }, { lineWidth: 0 });
    assert.equal(readWorkingDirectory(yaml), dir);
    assert.equal(isIsolatedRunDir(readWorkingDirectory(yaml), runId), true);
});

test('无空格的三种系统路径保持原样', () => {
    for (const dir of [
        `/Users/flutter/.aceharness/run-workspaces/${runId}`,
        `/home/flutter/.aceharness/run-workspaces/${runId}`,
        `C:\\Users\\Ada\\AppData\\Roaming\\ACEHarness\\run-workspaces\\${runId}`,
    ]) {
        const yaml = stringify({ workingDirectory: dir }, { lineWidth: 0 });
        assert.equal(readWorkingDirectory(yaml), dir);
        assert.equal(isIsolatedRunDir(dir, runId), true);
    }
});

test('双引号里的反斜杠会还原，单引号按字面保留', () => {
    const quoted = 'workingDirectory: "C:\\\\Users\\\\Ada Lovelace\\\\work\\\\' + runId + '"\n';
    assert.equal(
        readWorkingDirectory(quoted),
        `C:\\Users\\Ada Lovelace\\work\\${runId}`,
    );
    assert.equal(
        readWorkingDirectory(`workingDirectory: 'C:\\Users\\Ada Lovelace\\work\\${runId}'\n`),
        `C:\\Users\\Ada Lovelace\\work\\${runId}`,
    );
});

test('斜杠方向和末尾斜杠不影响隔离目录判断', () => {
    assert.equal(isIsolatedRunDir(`D:/work/${runId}/`, runId), true);
    assert.equal(isIsolatedRunDir(`D:\\work\\${runId}\\`, runId), true);
    assert.equal(isIsolatedRunDir(`D:\\work\\shared-template`, runId), false);
    assert.equal(isIsolatedRunDir(`D:\\work\\${runId}-extra`, runId), false);
    assert.equal(isIsolatedRunDir('', runId), false);
});

test('没有这个字段时得到空字符串', () => {
    assert.equal(readWorkingDirectory('status: running\n'), '');
    assert.equal(readWorkingDirectory('workingDirectory:\n'), '');
    assert.equal(readWorkingDirectory('workingDirectory: null\n'), '');
});
