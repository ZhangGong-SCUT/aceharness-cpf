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

import { imageIsNearBlack } from './blank-image.js';
import { aceDataDir, aceRunsDir, aceRuntimeRoot } from '../library/aceRuntime.js';
import { readWorkingDirectory } from '../library/runPath.js';
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

/** 修复验证结论里点名的图才进入「修复验证」画廊。过程截图（息屏、锁屏）不展示。 */
const FIX_IMAGE_NAME = /^fix/i;
const EVIDENCE_MARKDOWN = [
    '修复验证-修复方案对抗验证.md',
    '报告沉淀-生成诊断报告.md',
];
const REPRO_MARKDOWN = [
    '复现验证-复现效果对抗验证.md',
];

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
        return readWorkingDirectory(yaml);
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

/**
 * macOS APFS 的 /Users 是 firmlink。/proc 或 /dev/fd 有时给出
 * /System/Volumes/Data/Users/...，realpath 不会把它折回 /Users/...。
 * 比较前去掉这个固定前缀，两边仍指向同一份文件。
 */
function canonicalPath(filePath) {
    const prefix = '/System/Volumes/Data';
    if (typeof filePath === 'string' && filePath.startsWith(`${prefix}/`)) {
        return filePath.slice(prefix.length);
    }
    return filePath;
}

function pathInside(candidate, base) {
    let file = canonicalPath(candidate);
    let root = canonicalPath(base);
    if (process.platform === 'win32') {
        file = file.toLowerCase();
        root = root.toLowerCase();
    }
    return file === root || file.startsWith(root + sep);
}

/** Unix 用 O_NONBLOCK 避免打开 FIFO 时卡住；Windows 没有这个标志。O_NOFOLLOW 挡末级符号链接。 */
function openArtifact(realFull) {
    const attempts = [constants.O_RDONLY];
    let flagged = constants.O_RDONLY;
    if (typeof constants.O_NOFOLLOW === 'number') flagged |= constants.O_NOFOLLOW;
    if (process.platform !== 'win32' && typeof constants.O_NONBLOCK === 'number') flagged |= constants.O_NONBLOCK;
    if (flagged !== constants.O_RDONLY) attempts.unshift(flagged);
    let lastError;
    for (const flags of attempts) {
        try {
            return openSync(realFull, flags);
        } catch (error) {
            lastError = error;
            if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
        }
    }
    throw lastError;
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

/** 从结论文本里抽出图片文件名。大小写不敏感，调用方按小写比较。 */
export function citedImageBasenames(text) {
    const names = new Set();
    for (const match of String(text || '').matchAll(/[\w.-]+\.(?:png|jpe?g|gif|webp|bmp)\b/gi)) {
        names.add(match[0].toLowerCase());
    }
    return names;
}

function readNamedMarkdown(dir, names) {
    if (!dir || !existsSync(dir)) return '';
    const chunks = [];
    for (const name of names) {
        const file = join(dir, name);
        if (!existsSync(file)) continue;
        try {
            chunks.push(readFileSync(file, 'utf8'));
        } catch { /* 单份结论读不到时继续看另一份 */ }
    }
    return chunks.join('\n');
}

/** 步骤日志和带时间戳的副本里才写了「看图工具不可用」。短结论往往只点文件名。 */
function readFixVerificationNotes(archDir) {
    if (!archDir || !existsSync(archDir)) return '';
    const chunks = [];
    const take = (file) => {
        try { chunks.push(readFileSync(file, 'utf8')); } catch { /* 单份读不到就跳过 */ }
    };
    const stepLogsDir = join(archDir, 'step-logs');
    if (existsSync(stepLogsDir)) {
        for (const name of readdirSync(stepLogsDir)) {
            if (!name.includes('修复验证') || !name.endsWith('.md') || name.endsWith('.raw')) continue;
            take(join(stepLogsDir, name));
        }
    }
    for (const name of readdirSync(archDir)) {
        if (/^\d{4}-\d{2}-\d{2}T/.test(name) && name.includes('修复验证') && name.endsWith('.md')) {
            take(join(archDir, name));
        }
    }
    return chunks.join('\n');
}

/** 修复验证写明没看图时，fix* 图不能当修复后证据。 */
export function fixShotsWereNotInspected(text) {
    return /look_at_image[^。\n]{0,120}不可用|screenshot_analysis\s*[:：=]\s*skipped_no_vision/.test(String(text || ''));
}

/** 连拍、点按定位、临时文件名。结论没点名、也没交给看图模型时，不进画廊。 */
const PROCESS_SHOT = /(?:^|\/)(?:s\d+-seq-|s\d+[a-z]\.|t\d\.|f\d\.|chk\.|now-state\.|tap-|keyboard-hidden\.|fresh-start\.|clean-start\.|recover\.)/i;

/** 从 look-at-image --image 参数里抽出真正打开过的文件名。 */
export function reviewedImageBasenames(text) {
    const names = new Set();
    const re = /--image(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/gi;
    for (const match of String(text || '').matchAll(re)) {
        const raw = match[1] || match[2] || match[3] || '';
        const base = raw.split(/[/\\]/).pop();
        if (/^[\w.-]+\.(?:png|jpe?g|gif|webp|bmp)$/i.test(base)) names.add(base.toLowerCase());
    }
    return names;
}

export function isProcessShotName(name) {
    return PROCESS_SHOT.test(String(name || '').toLowerCase());
}

/**
 * 画廊优先只放看图模型真正打开过的图。
 * 没有看图记录时，才退回结论点名的图；再没有，才放过非过程图。
 * 黑屏和结论明确作废的图在每一档都会去掉。
 */
export function selectGalleryImages(images, { reviewed, cited, rejected, blank }) {
    const nameOf = (image) => String(image.name || '').toLowerCase();
    const visible = (image) => !rejected.has(nameOf(image)) && !blank.has(nameOf(image));
    const reviewedHits = images.filter((image) => reviewed.has(nameOf(image)) && visible(image));
    if (reviewedHits.length) return reviewedHits;
    const citedHits = images.filter((image) => cited.has(nameOf(image)) && visible(image));
    if (citedHits.length) return citedHits;
    return images.filter((image) => visible(image) && !isProcessShotName(image.name));
}

/** 同一句里点了文件名又说黑屏、息屏或锁屏的图，不放进画廊。 */
export function rejectedBlackShotBasenames(text) {
    const names = new Set();
    for (const part of String(text || '').split(/[。\n]/)) {
        if (!/黑屏|息屏|锁屏/.test(part)) continue;
        for (const name of citedImageBasenames(part)) names.add(name);
    }
    return names;
}

/** 复现结论写明「非严格操作前」的图，不放进画廊。 */
export function rejectedBaselineBasenames(text) {
    const names = new Set();
    for (const part of String(text || '').split(/[。\n]/)) {
        if (!part.includes('非严格') || !part.includes('操作前')) continue;
        for (const name of citedImageBasenames(part)) names.add(name);
    }
    return names;
}

/**
 * 结论里点了至少一张 fix* 图时，修复验证只保留这些图。
 * 没有点名时原样返回，避免把未写文件名的旧运行画廊清空。
 */
export function filterFixVerificationImages(images, citedNames) {
    const allow = new Set([...citedNames].filter((name) => FIX_IMAGE_NAME.test(name)));
    if (allow.size === 0) return images;
    return images.filter((image) => {
        const name = String(image.name || '').toLowerCase();
        if (!FIX_IMAGE_NAME.test(name)) return true;
        return allow.has(name);
    });
}

function dedupeImagesByName(images) {
    const seen = new Set();
    const out = [];
    for (const image of images) {
        const key = String(image.name || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(image);
    }
    return out;
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

function readBoundedFiles(dir, accept) {
    if (!dir || !existsSync(dir)) return '';
    const chunks = [];
    let names;
    try { names = readdirSync(dir); } catch { return ''; }
    for (const name of names) {
        if (!accept(name)) continue;
        const file = join(dir, name);
        try {
            const st = statSync(file);
            if (!st.isFile() || st.size > 12 * 1024 * 1024) continue;
            chunks.push(readFileSync(file, 'utf8'));
        } catch { /* 单份读不到就跳过 */ }
    }
    return chunks.join('\n');
}

const blackCache = new Map();

function nearBlackNames(images, workDir, archDir) {
    const names = new Set();
    for (const image of images) {
        const ref = String(image.ref || '');
        const slash = ref.indexOf('/');
        if (slash < 1) continue;
        const base = ref.slice(0, slash) === 'arch' ? archDir : workDir;
        const rel = ref.slice(slash + 1);
        const key = image.md5 || '';
        if (key && blackCache.has(key)) {
            if (blackCache.get(key)) names.add(String(image.name || '').toLowerCase());
            continue;
        }
        let black = false;
        try {
            black = imageIsNearBlack(readWithinTrustedBase(base, rel).buffer);
        } catch { black = false; }
        if (key) blackCache.set(key, black);
        if (black) names.add(String(image.name || '').toLowerCase());
    }
    return names;
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
            if (item.rel.split(sep).includes('step-logs')) continue;
            if (/^\d{4}-\d{2}-\d{2}T/.test(item.name)) continue;
            const ext = extname(item.name).toLowerCase();
            // 归档目录里的截图也进画廊。工作区收尾后复现图往往只留在这里。
            if (IMAGE_MIME[ext]) {
                images.push(_classify(item, 'arch', archDir));
                continue;
            }
            // 只要顶层完整版 md；过滤 step-logs 子目录与时间戳存档副本（内容重复）
            if (ext !== '.md') continue;
            if (item.rel.includes(sep)) continue;
            logs.push({ kind: 'markdown', ref: `arch/${item.rel}`, name: item.name, size: item.size, mtime: item.mtime });
        }
    }

    const evidenceText = [
        readNamedMarkdown(workDir, EVIDENCE_MARKDOWN),
        readNamedMarkdown(archDir, EVIDENCE_MARKDOWN),
        readFixVerificationNotes(archDir),
    ].join('\n');
    const reviewText = [
        evidenceText,
        readBoundedFiles(workDir, (name) => name.endsWith('.md')),
        readBoundedFiles(archDir, (name) => name.endsWith('.md') || name.endsWith('.jsonl')),
        readBoundedFiles(join(aceRunsDir(), runId, 'streams'), (name) => name.endsWith('.md') || name.endsWith('.jsonl')),
    ].join('\n');
    const cited = citedImageBasenames(evidenceText);
    const reviewed = reviewedImageBasenames(reviewText);
    const rejected = new Set([
        ...rejectedBaselineBasenames(readNamedMarkdown(workDir, REPRO_MARKDOWN)),
        ...rejectedBaselineBasenames(readNamedMarkdown(archDir, REPRO_MARKDOWN)),
        ...rejectedBlackShotBasenames(evidenceText),
    ]);
    const dropUnseenFix = fixShotsWereNotInspected(evidenceText);
    const deduped = filterFixVerificationImages(dedupeImagesByName(images), cited)
        .filter((image) => !(dropUnseenFix && FIX_IMAGE_NAME.test(String(image.name || ''))));
    const chosen = selectGalleryImages(deduped, { reviewed, cited, rejected, blank: new Set() });
    const blank = nearBlackNames(chosen, workDir, archDir);
    const gallery = chosen.filter((image) => !blank.has(String(image.name || '').toLowerCase()));
    images.length = 0;
    images.push(...gallery);

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
    if (!pathInside(realFull, realBase)) {
        throw new Error('路径不合法');
    }

    // E02：以 O_NONBLOCK 打开——无写入端的 FIFO 若按阻塞方式打开会一直等待，
    // 同步调用会挂起整个事件循环；O_NONBLOCK 让 open 立即返回，再由 fstat 判定类型
    // （普通文件读取不受 O_NONBLOCK 影响）。
    // Q03/B03/C01：以"已打开 fd 的实际目标"为准校验归属（O_NOFOLLOW 挡末级链接，
    // /proc/self/fd 内核路径挡祖先目录切换，realpath+dev/ino 复查作纵深防御）。
    const fd = openArtifact(realFull);
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
            if (!pathInside(comparable, realFull) && !pathInside(comparable, realBase)) {
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
