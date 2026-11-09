/**
 * Run 产物读取 — 直接读本地磁盘（与 AceHarness 同机部署）
 *
 * 两个数据源：
 *  1. 工作目录 {home}/run-{runId}/outputs/    —— 截图、hilog、logcat、patch、HAR 等运行产物
 *  2. 归档目录 {home}/.aceharness/runs/{runId}/outputs/ —— step-logs/*.md 步骤日志等
 *
 * 对外统一 ref 标识："work/<相对路径>" 与 "arch/<相对路径>"，
 * 读取时强制校验路径不逃逸对应 outputs 目录（防目录穿越）。
 */

import { aceDataDir, aceRunsDir, aceRuntimeRoot } from '../library/aceRuntime.js';
import { readdirSync, statSync, lstatSync, readFileSync, existsSync, realpathSync, openSync, closeSync, fstatSync, readlinkSync, constants } from 'node:fs';
import { join, resolve, relative, isAbsolute, extname, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

const IMAGE_MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
};

const TEXT_EXTS = new Set([
    '.md', '.txt', '.log', '.json', '.patch', '.diff', '.yaml', '.yml',
    '.ets', '.ts', '.js', '.dart', '.xml', '.html', '.css', '.gradle', '.properties', '.json5',
]);

/** 单文件读取上限（超过则拒绝，防止误读超大文件拖垮服务） */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** 工作目录 outputs。优先用 run 自己记下的 workingDirectory，而不是家目录下同名空目录。 */
function readRecordedWorkingDirectory(runId) {
    try {
        const yaml = readFileSync(join(aceRunsDir(), runId, 'state.yaml'), 'utf8');
        const match = /^workingDirectory:\s*(\S+)\s*$/m.exec(yaml);
        return match ? match[1] : '';
    } catch {
        return '';
    }
}

function workOutputsDir(runId) {
    const recorded = readRecordedWorkingDirectory(runId);
    const candidates = [
        recorded ? join(recorded, 'outputs') : '',
        join(aceRuntimeRoot(), 'run-workspaces', runId, 'outputs'),
        join(homedir(), runId, 'outputs'),
    ].filter(Boolean);
    return candidates.find((dir) => existsSync(dir)) || candidates[0];
}

/** 归档目录 outputs */
function archOutputsDir(runId) {
    return join(aceRunsDir(), runId, 'outputs');
}

/**
 * 可信根由服务端自己决定，不用本次解析出来的产物目录当信任来源。
 * 否则 outputs 被换成外部链接时，链接目标会变成新的可信根。
 * 家目录覆盖默认的 ~/.aceharness；ACE_HOME、%APPDATA%\\ACEHarness、$XDG_DATA_HOME/aceharness
 * 可能在别的盘或家目录外面，运行时根必须单独计入。
 */
function trustRoots() {
    const roots = [];
    const configured = process.env.ISSUEANALYSIS_TRUST_ROOT?.trim();
    roots.push(configured ? resolve(configured) : homedir());
    const runtime = aceRuntimeRoot();
    if (runtime && !roots.includes(runtime)) roots.push(runtime);
    return roots;
}

/** macOS 的 realpath("/dev/fd/N") 会原样返回 /dev/fd/N，不能当成文件真实路径。 */
function isFdDevicePath(filePath) {
    return typeof filePath === 'string' && /^\/(?:dev\/fd|proc\/self\/fd)\/\d+$/.test(filePath);
}

function openedFdPath(fd) {
    const candidates = process.platform === 'darwin'
        ? [`/dev/fd/${fd}`]
        : [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`];
    for (const candidate of candidates) {
        try {
            const linked = readlinkSync(candidate);
            if (linked && !isFdDevicePath(linked)) return linked;
        } catch { /* macOS 的 /dev/fd 往往不是符号链接 */ }
        try {
            const resolved = realpathSync(candidate);
            if (resolved && !isFdDevicePath(resolved)) return resolved;
        } catch { /* 这个平台没有这条 fd 路径 */ }
    }
    return null;
}

/**
 * E01：解析产物目录的真实路径，要求其位于服务端可信根内，且从可信根到该目录的
 * 每一级组件都是真实目录（lstat 逐级校验，任何一级是符号链接即拒绝）。
 * 这样 outputs（或 run 目录、.aceharness 链路上的中间目录）被替换成外部链接时会被拒绝，
 * 而不是把外部目标当作新的可信根。返回 null 表示不可信，由调用方拒绝读取。
 */
function trustedRealBase(baseDir, extraRoots = []) {
    const roots = [...trustRoots(), ...extraRoots].filter(Boolean);
    for (const rawRoot of roots) {
        const found = trustedRealBaseUnder(rawRoot, baseDir);
        if (found) return found;
    }
    return null;
}

function trustedRealBaseUnder(rawRoot, baseDir) {
    const target = resolve(baseDir);
    const rel = relative(resolve(rawRoot), target);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    let root;
    try { root = realpathSync(rawRoot); } catch { return null; }
    if (rel === '') return root;
    let cur = root;
    for (const part of rel.split(sep)) {
        if (!part || part === '.') continue;
        cur = join(cur, part);
        let st;
        try { st = lstatSync(cur); } catch { return null; }
        if (st.isSymbolicLink()) return null;   // E01：base 链路上不接受符号链接
        if (!st.isDirectory()) return null;
    }
    return cur;
}

function _listDirRecursive(dir, baseDir, depth, out) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'oh_modules') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            if (depth < 2) _listDirRecursive(full, baseDir, depth + 1, out);
        } else if (e.isFile()) {
            let st;
            try {
                st = statSync(full);
            } catch { continue; }
            out.push({
                name: e.name,
                rel: resolve(full).slice(resolve(baseDir).length + 1),
                size: st.size,
                mtime: st.mtime.toISOString(),
            });
        }
    }
}

function _classify(item, prefix, baseDir) {
    const ext = extname(item.name).toLowerCase();
    let md5 = null;
    if (IMAGE_MIME[ext] && item.size <= 8 * 1024 * 1024) {
        // E01/E02：摘要读取与下载共用同一套边界检查（可信根 + 非阻塞打开 + 普通文件判定），
        // 避免"列表可用而下载被拒"（或反之）的策略不一致，也避免列表阶段被 FIFO 阻塞。
        try {
            md5 = crypto.createHash('md5').update(readWithinTrustedBase(baseDir, item.rel).buffer).digest('hex').slice(0, 12);
        } catch { md5 = null; }
    }
    const base = { ref: `${prefix}/${item.rel}`, name: item.name, size: item.size, mtime: item.mtime, md5 };
    if (IMAGE_MIME[ext]) return { kind: 'image', ...base };
    if (ext === '.md') return { kind: 'markdown', ...base };
    if (ext === '.patch' || ext === '.diff') return { kind: 'patch', ...base };
    if (ext === '.har' || ext === '.hap' || ext === '.so' || ext === '.zip' || ext === '.apk') return { kind: 'binary', ...base };
    if (TEXT_EXTS.has(ext)) return { kind: 'text', ...base };
    return { kind: 'binary', ...base };
}

/**
 * 列出 run 的所有产物（工作目录 + 归档 step-logs）
 * @param {string} runId
 * @returns {{ runId: string, images: array, logs: array, files: array, steps: array }}
 */
export function listRunArtifacts(runId) {
    const images = [];
    const logs = [];
    const files = [];
    const steps = [];

    // 1. 工作目录产物（截图/日志/补丁/HAR）
    const workDir = workOutputsDir(runId);
    if (existsSync(workDir)) {
        const out = [];
        _listDirRecursive(workDir, workDir, 0, out);
        for (const item of out) {
            const c = _classify(item, 'work', workDir);
            if (c.kind === 'image') images.push(c);
            else if (c.kind === 'markdown') logs.push(c);
            else files.push(c);
        }
    }

    // 2. 归档目录：step-logs（截断版）+ 顶层完整版步骤输出（saveProcessOutput）
    const archDir = archOutputsDir(runId);
    const stepLogsDir = join(archDir, 'step-logs');
    if (existsSync(stepLogsDir)) {
        const out = [];
        _listDirRecursive(stepLogsDir, stepLogsDir, 0, out);
        for (const item of out) {
            steps.push({ ref: `arch/step-logs/${item.rel}`, name: item.name, size: item.size, mtime: item.mtime });
        }
    }
    if (existsSync(archDir)) {
        const out = [];
        _listDirRecursive(archDir, archDir, 1, out);
        for (const item of out) {
            // 只要顶层完整版 md；过滤 step-logs 子目录与时间戳存档副本（内容重复）
            if (extname(item.name).toLowerCase() !== '.md') continue;
            if (/^\d{4}-\d{2}-\d{2}T/.test(item.name)) continue;
            if (item.rel.includes(sep)) continue;
            logs.push({ kind: 'markdown', ref: `arch/${item.rel}`, name: item.name, size: item.size, mtime: item.mtime });
        }
    }

    const byTime = (a, b) => new Date(a.mtime) - new Date(b.mtime);
    images.sort(byTime);
    logs.sort(byTime);
    files.sort(byTime);
    steps.sort(byTime);
    return { runId, images, logs, files, steps };
}

/**
 * 在可信产物目录内安全读取一个相对路径。
 * 下载接口与列表摘要（md5）共用同一套边界检查，避免两处策略不一致。
 * @param {string} baseDir - 产物目录（未解析路径）
 * @param {string} rel - 目录内相对路径
 * @returns {{ buffer: Buffer, name: string, ext: string }}
 */
function readWithinTrustedBase(baseDir, rel, extraRoots = []) {
    if (typeof rel !== 'string' || rel.includes('\0')) {
        throw new Error('ref 不合法');
    }
    if (!existsSync(baseDir)) {
        const err = new Error('文件不存在');
        err.code = 'ENOENT';
        throw err;
    }
    // E01：可信根由服务端确定（家目录或 ISSUEANALYSIS_TRUST_ROOT，以及运行时根），
    // 且 base 链路上的每一级都必须是真实目录。
    // run 自己写入 state.yaml 的 workingDirectory 可以作为附加可信根。
    const realBase = trustedRealBase(baseDir, extraRoots);
    if (!realBase) {
        throw new Error('路径不合法：产物目录不在可信根内');
    }
    const full = resolve(realBase, rel);
    if (!(full === realBase || full.startsWith(realBase + sep))) {
        throw new Error('路径不合法');
    }
    if (!existsSync(full)) {
        const err = new Error('文件不存在');
        err.code = 'ENOENT';
        throw err;
    }
    // R01：base 内某目录若是指向外部的符号链接，realpath 会还原出界外路径
    const realFull = realpathSync(full);
    if (!realFull.startsWith(realBase + sep)) {
        throw new Error('路径不合法');
    }

    // E02：以 O_NONBLOCK 打开——无写入端的 FIFO 若按阻塞方式打开会一直等待，
    // 同步调用会挂起整个事件循环；O_NONBLOCK 让 open 立即返回，再由 fstat 判定类型
    // （普通文件读取不受 O_NONBLOCK 影响）。
    // Q03/B03/C01：以"已打开 fd 的实际目标"为准校验归属（O_NOFOLLOW 挡末级链接，
    // /proc/self/fd 内核路径挡祖先目录切换，realpath+dev/ino 复查作纵深防御）。
    const fd = openSync(realFull, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const st = fstatSync(fd);
        if (!st.isFile()) {
            throw new Error('路径不合法：不是普通文件');
        }
        let actualPath = openedFdPath(fd);
        if (actualPath === null) {
            // macOS 读不到 fd 的真实路径（/dev/fd/N 不会解析到文件）。
            // 此时用已打开 fd 的 dev/ino 对照 realFull：realFull 在打开前已经限制在可信产物目录内。
            const current = statSync(realFull);
            if (!current.isFile() || current.dev !== st.dev || current.ino !== st.ino) {
                throw new Error('路径校验与读取不一致');
            }
        } else {
            // 已删除文件带 " (deleted)" 后缀：去掉后仍按原路径校验归属
            const normalized = actualPath.endsWith(' (deleted)')
                ? actualPath.slice(0, -' (deleted)'.length)
                : actualPath;
            let comparable = normalized;
            try { comparable = realpathSync(normalized); } catch { /* 已删除文件无法再解析，沿用内核记录的路径 */ }
            if (!(comparable === realFull || comparable === realBase || comparable.startsWith(realBase + sep))) {
                throw new Error('路径不合法：打开对象不在产物目录内');
            }
        }
        // 路径复查：/proc 可用时的纵深防御；显式降级时则是唯一校验。
        try {
            const recheck = realpathSync(realFull);
            const rst = statSync(recheck);
            if (recheck !== realFull || rst.dev !== st.dev || rst.ino !== st.ino) {
                throw new Error('路径校验与读取不一致');
            }
        } catch (e) {
            // 读取途中文件被正常清理：fd 已由归属校验（/proc 或显式降级路径）确权，放行
            if (e.code !== 'ENOENT') throw e;
        }
        if (st.size > MAX_FILE_BYTES) {
            throw new Error(`文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB，上限 64MB）`);
        }
        return {
            buffer: readFileSync(fd),
            name: basename(realFull),
            ext: extname(realFull).toLowerCase(),
        };
    } finally {
        closeSync(fd);
    }
}

/**
 * 读取单个产物文件
 * @param {string} runId
 * @param {string} ref - "work/<rel>" 或 "arch/<rel>"
 * @returns {{ kind: 'image'|'text'|'binary', buffer?: Buffer, contentType: string, name: string }}
 */
export function readRunArtifact(runId, ref) {
    if (!ref || typeof ref !== 'string' || ref.includes('\0')) {
        throw new Error('ref 不合法');
    }
    let baseDir;
    let rel;
    let extraRoots = [];
    if (ref.startsWith('work/')) {
        const recorded = readRecordedWorkingDirectory(runId);
        if (recorded) extraRoots = [recorded];
        baseDir = workOutputsDir(runId);
        rel = ref.slice(5);
    } else if (ref.startsWith('arch/')) {
        baseDir = archOutputsDir(runId);
        rel = ref.slice(5);
    } else {
        throw new Error('ref 必须以 work/ 或 arch/ 开头');
    }

    const { buffer, name, ext } = readWithinTrustedBase(baseDir, rel, extraRoots);
    if (IMAGE_MIME[ext]) {
        return { kind: 'image', buffer, contentType: IMAGE_MIME[ext], name };
    }
    if (TEXT_EXTS.has(ext)) {
        return { kind: 'text', buffer, contentType: 'text/plain; charset=utf-8', name };
    }
    return { kind: 'binary', buffer, contentType: 'application/octet-stream', name };
}
