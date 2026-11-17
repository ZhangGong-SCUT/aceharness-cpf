import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copilotCliPackageNames, resolveBundledCopilotCli } from '../cli/copilot/resolveCliPath.js';

test('三种系统各自对应平台包，不会拼出 @github/index.js', () => {
    assert.deepEqual(copilotCliPackageNames('darwin', 'arm64'), ['@github/copilot-darwin-arm64']);
    assert.deepEqual(copilotCliPackageNames('win32', 'x64'), ['@github/copilot-win32-x64']);
    assert.deepEqual(copilotCliPackageNames('linux', 'x64', false), ['@github/copilot-linux-x64']);
    assert.deepEqual(copilotCliPackageNames('linux', 'arm64', true), [
        '@github/copilot-linuxmusl-arm64',
        '@github/copilot-linux-arm64',
    ]);
});

test('解析结果必须是已存在的平台可执行文件', () => {
    const file = resolveBundledCopilotCli();
    assert.equal(existsSync(file), true);
    assert.match(file, /[/\\]@github[/\\]copilot-[^/\\]+[/\\]copilot$/);
    assert.doesNotMatch(file, /[/\\]@github[/\\]index\.js$/);
});

test('平台包都不在时说明查找过的包名', () => {
    assert.throws(
        () => resolveBundledCopilotCli({
            platform: 'win32',
            arch: 'arm64',
            resolve: () => { throw new Error('missing'); },
        }),
        /@github\/copilot-win32-arm64/,
    );
});

test('musl 包缺失时回退到 glibc 包', () => {
    const file = resolveBundledCopilotCli({
        platform: 'linux',
        arch: 'x64',
        musl: true,
        resolve: (name) => {
            if (name.endsWith('linuxmusl-x64')) throw new Error('missing');
            return 'C:\\copilot\\copilot';
        },
        exists: (candidate) => candidate === 'C:\\copilot\\copilot',
    });
    assert.equal(file, 'C:\\copilot\\copilot');
});
