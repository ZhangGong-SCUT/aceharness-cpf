/**
 * 定位当前系统的 Copilot CLI 可执行文件。
 *
 * @github/copilot-sdk 0.3.0 会把 @github/copilot/sdk 再往上两级，拼出
 * node_modules/@github/index.js。1.x 的 CLI 没有这个文件，真正的程序在
 * @github/copilot-<平台>-<架构> 里。
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

function linuxIsMusl() {
    try {
        const { isNonGlibcLinuxSync } = require('detect-libc');
        return Boolean(isNonGlibcLinuxSync());
    } catch {
        return false;
    }
}

/** @returns {string[]} 按优先顺序尝试的平台包名 */
export function copilotCliPackageNames(platform = process.platform, arch = process.arch, musl) {
    if (platform === 'linux') {
        const nonGlibc = musl ?? linuxIsMusl();
        const names = nonGlibc
            ? ['linuxmusl', 'linux']
            : ['linux'];
        return names.map((name) => `@github/copilot-${name}-${arch}`);
    }
    return [`@github/copilot-${platform}-${arch}`];
}

/**
 * @param {{ platform?: string, arch?: string, musl?: boolean, resolve?: (name: string) => string, exists?: (file: string) => boolean }} [options]
 * @returns {string}
 */
export function resolveBundledCopilotCli(options = {}) {
    const names = copilotCliPackageNames(options.platform, options.arch, options.musl);
    const resolve = options.resolve ?? ((name) => require.resolve(name));
    const exists = options.exists ?? existsSync;
    const misses = [];
    for (const name of names) {
        try {
            const file = resolve(name);
            if (file && exists(file)) return file;
            misses.push(file || name);
        } catch {
            misses.push(name);
        }
    }
    throw new Error(
        `找不到 Copilot CLI。已查找 ${misses.join('、')}。请安装 @github/copilot 里对应当前系统的平台包。`,
    );
}
