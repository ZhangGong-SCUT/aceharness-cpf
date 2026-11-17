#!/usr/bin/env node
/**
 * Next/Turbopack 把异步外部模块按 specifier 命名，例如
 * server/chunks/[externals]_node:fs_promises_<hash>._.js。
 * macOS 和 Linux 允许文件名里的冒号，加载器路径和磁盘文件一致。
 * Windows 不允许冒号：Next 或 tar 会把冒号写成 U+F03A（0xF000 + ':'），
 * 加载器仍请求带冒号的路径，于是出现
 * Failed to load chunk ... from module ...。
 * 这里把文件名改成各系统都能用的形式，并同步改写 .next 里的引用。
 */
const fs = require('fs');
const path = require('path');
const ILLEGAL_ASCII = '<>:"|?*';
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.map', '.css', '.html', '.txt', '.svg']);
function decodeWindowsChunkName(name) {
    let out = '';
    for (const ch of name) {
        const code = ch.codePointAt(0);
        if (code >= 0xF000 && code <= 0xF07F) {
            const ascii = String.fromCharCode(code - 0xF000);
            if (ILLEGAL_ASCII.includes(ascii)) {
                out += ascii;
                continue;
            }
        }
        out += ch;
    }
    return out;
}
function portableChunkName(name) {
    const decoded = decodeWindowsChunkName(name);
    const replaced = decoded.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
    return replaced || '_';
}
function walk(dir, files, dirs) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
            continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            dirs.push(full);
            walk(full, files, dirs);
        }
        else if (entry.isFile()) {
            files.push(full);
        }
    }
}
function sanitizeNextOutput(root, options = {}) {
    if (!root || !fs.existsSync(root))
        return 0;
    const files = [];
    const dirs = [];
    // 开发缓存不属于生产运行产物；build 前后的旧 dev chunk 可能同时含原名和安全名。
    // 仅清理将被生产服务加载的输出，保留冲突检测，避免删除/覆盖开发中的编译文件。
    const skipDev = options.skipDev ?? true;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
            continue;
        const full = path.join(root, entry.name);
        if (skipDev && entry.isDirectory() && entry.name === 'dev')
            continue;
        if (entry.isDirectory()) {
            dirs.push(full);
            walk(full, files, dirs);
        }
        else if (entry.isFile()) {
            files.push(full);
        }
    }
    for (const dir of dirs) {
        const base = path.basename(dir);
        if (portableChunkName(base) !== base) {
            throw new Error(`[sanitize-next-chunks] 目录名无法在 Windows 使用: ${dir}`);
        }
    }
    const plans = [];
    for (const file of files) {
        const base = path.basename(file);
        const next = portableChunkName(base);
        if (next === base)
            continue;
        plans.push({ file, base, next, dir: path.dirname(file) });
    }
    if (!plans.length)
        return 0;
    const taken = new Set(files);
    for (const plan of plans) {
        const dest = path.join(plan.dir, plan.next);
        if (taken.has(dest)) {
            throw new Error(`[sanitize-next-chunks] 重命名冲突: ${plan.base} -> ${plan.next}`);
        }
        taken.add(dest);
    }
    const replacements = new Map();
    for (const plan of plans) {
        const decoded = decodeWindowsChunkName(plan.base);
        const oldNames = new Set([
            plan.base,
            decoded,
            encodeURIComponent(plan.base),
            encodeURIComponent(decoded),
        ]);
        for (const oldName of oldNames) {
            const neu = oldName === plan.base || oldName === decoded
                ? plan.next
                : encodeURIComponent(plan.next);
            if (oldName !== neu)
                replacements.set(oldName, neu);
        }
    }
    const needles = [...replacements.keys()].sort((a, b) => b.length - a.length);
    for (const file of files) {
        if (!TEXT_EXT.has(path.extname(file).toLowerCase()))
            continue;
        const original = fs.readFileSync(file, 'utf8');
        let text = original;
        for (const needle of needles) {
            if (!text.includes(needle))
                continue;
            text = text.split(needle).join(replacements.get(needle));
        }
        if (text !== original)
            fs.writeFileSync(file, text);
    }
    for (const plan of plans) {
        fs.renameSync(plan.file, path.join(plan.dir, plan.next));
    }
    console.log(`[sanitize-next-chunks] 已重命名 ${plans.length} 个 Windows 无法加载的 chunk`);
    return plans.length;
}
module.exports = { sanitizeNextOutput, portableChunkName, decodeWindowsChunkName };
if (require.main === module) {
    const root = path.resolve(__dirname, '..', '.next');
    const count = sanitizeNextOutput(root);
    if (!count)
        console.log('[sanitize-next-chunks] 没有需要重命名的 chunk');
}
