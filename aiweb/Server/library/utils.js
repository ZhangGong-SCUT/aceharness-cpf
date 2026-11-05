/**
 * 通用工具函数
 * - StageError：带 code 的业务错误类
 * - AppError：统一应用错误类
 * - delay：延迟 Promise
 * - withRetry：带重试的异步执行
 * - validateLibraryName：库名称白名单校验
 * - sanitizePath：文件路径安全校验（防目录穿越）
 */

import path from 'node:path';

// ─── 统一错误处理框架 ────────────────────────────────────────────────────────────

/**
 * 业务阶段错误（用于任务执行过程中）
 */
export class StageError extends Error {
    /**
     * @param {string} code    - 错误码，如 'analysis_failed' | 'porting_failed' | 'timeout'
     * @param {string} message - 人类可读的错误描述
     * @param {object} [meta]  - 额外元数据（如 sessionId、taskId）
     */
    constructor(code, message, meta = {}) {
        super(message);
        this.name = 'StageError';
        this.code = code;
        this.meta = meta;
        this.timestamp = new Date().toISOString();
    }

    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            meta: this.meta,
            timestamp: this.timestamp,
        };
    }
}

/**
 * 统一应用错误类（用于 HTTP API 层）
 * 
 * 错误码规范：
 * - E4xx：客户端错误（参数校验失败、权限不足等）
 * - E5xx：服务端错误（系统异常、依赖服务不可用等）
 * 
 * 预定义错误码：
 * - E400_VALIDATION：参数校验失败
 * - E401_UNAUTHORIZED：未认证
 * - E403_FORBIDDEN：权限不足
 * - E404_NOT_FOUND：资源不存在
 * - E429_QUEUE_FULL：队列已满
 * - E500_SYSTEM：系统内部错误
 * - E503_SERVICE_UNAVAILABLE：依赖服务不可用
 */
export class AppError extends Error {
    /**
     * @param {string} errorCode  - 错误码（格式：Exxx_XXX）
     * @param {string} message    - 人类可读的错误描述
     * @param {number} [httpStatus=500] - HTTP 状态码
     * @param {object} [details]  - 详细错误信息
     */
    constructor(errorCode, message, httpStatus = 500, details = {}) {
        super(message);
        this.name = 'AppError';
        this.errorCode = errorCode;
        this.httpStatus = httpStatus;
        this.details = details;
        this.timestamp = new Date().toISOString();

        // 根据 errorCode 自动推断 httpStatus（如果未明确指定）
        if (httpStatus === 500 && errorCode.startsWith('E')) {
            const codeNum = parseInt(errorCode.substring(1, 4));
            if (codeNum >= 400 && codeNum < 600) {
                this.httpStatus = codeNum;
            }
        }
    }

    toJSON() {
        return {
            success: false,
            errorCode: this.errorCode,
            message: this.message,
            httpStatus: this.httpStatus,
            details: this.details,
            timestamp: this.timestamp,
        };
    }

    // ─── 预定义工厂方法 ────────────────────────────────────────────────
    
    static validation(message, details = {}) {
        return new AppError('E400_VALIDATION', message, 400, details);
    }

    static unauthorized(message = '未认证，请先登录') {
        return new AppError('E401_UNAUTHORIZED', message, 401);
    }

    static forbidden(message = '权限不足') {
        return new AppError('E403_FORBIDDEN', message, 403);
    }

    static notFound(resource, message) {
        return new AppError('E404_NOT_FOUND', message || `资源不存在：${resource}`, 404, { resource });
    }

    static queueFull(message, queueStatus) {
        return new AppError('E429_QUEUE_FULL', message, 429, { queueStatus });
    }

    static system(message, details = {}) {
        return new AppError('E500_SYSTEM', message, 500, details);
    }

    static serviceUnavailable(service, message) {
        return new AppError('E503_SERVICE_UNAVAILABLE', message || `依赖服务 ${service} 不可用`, 503, { service });
    }
}

// ─── 异步工具 ──────────────────────────────────────────────────────────────────

/**
 * 延迟指定毫秒
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的异步执行
 * @param {() => Promise<T>} fn           - 要执行的异步函数
 * @param {number}           maxAttempts  - 最大尝试次数（含第一次）
 * @param {number}           delayMs      - 每次重试前的等待时间（ms）
 * @returns {Promise<T>}
 */
export async function withRetry(fn, maxAttempts = 3, delayMs = 1000) {
    let lastError;
    for (let i = 1; i <= maxAttempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (i < maxAttempts) await delay(delayMs);
        }
    }
    throw lastError;
}

// ─── 参数校验 ──────────────────────────────────────────────────────────────────

const LIBRARY_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 校验 libraryName 是否合法（白名单：字母、数字、-、_，长度 1-64）
 * @param {string} name
 * @returns {{ valid: boolean, message?: string }}
 */
export function validateLibraryName(name) {
    if (typeof name !== 'string' || name.length === 0) {
        return { valid: false, message: 'libraryName 不能为空' };
    }
    if (!LIBRARY_NAME_RE.test(name)) {
        return {
            valid: false,
            message: 'libraryName 包含非法字符，仅允许字母、数字、连字符（-）和下划线（_），长度 1-64',
        };
    }
    return { valid: true };
}

/**
 * 简单校验 URL 格式
 * @param {string} url
 * @returns {boolean}
 */
export function isValidUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'git:';
    } catch {
        return false;
    }
}

// ─── 时间戳生成 ───────────────────────────────────────────────────────────────

/**
 * 生成目录路径时间戳，格式 YYYYMMDDHHmm（如 202605211026）
 * 用于目录命名，避免同名任务产物被覆盖
 * @returns {string} 12 位时间戳字符串
 */
export function generateDirTimestamp() {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const MM = (now.getMonth() + 1).toString().padStart(2, '0');
    const dd = now.getDate().toString().padStart(2, '0');
    const HH = now.getHours().toString().padStart(2, '0');
    const mm = now.getMinutes().toString().padStart(2, '0');
    return `${yyyy}${MM}${dd}${HH}${mm}`;
}

// ─── PR 地址解析 ───────────────────────────────────────────────────────────────

/**
 * 解析 PR 地址，提取 owner、repo、prNumber 等信息
 * 支持格式：
 *   GitHub: https://github.com/{owner}/{repo}/pull/{prNumber}
 *   Gitee:  https://gitee.com/{owner}/{repo}/pulls/{prNumber}
 *
 * @param {string} prUrl
 * @returns {{ owner: string, repo: string, prNumber: string, platform: string, repoUrl: string, dirName: string }}
 * @throws {Error} 若 URL 无法解析
 */
export function parsePrUrl(prUrl) {
    let parsed;
    try {
        parsed = new URL(prUrl);
    } catch {
        throw new Error(`无效的 PR URL：${prUrl}`);
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    // 期望格式: [owner, repo, 'pull'|'pulls', prNumber]
    if (parts.length < 4) {
        throw new Error(`无法从 URL 路径解析 owner/repo/prNumber：${prUrl}`);
    }

    const [owner, repo, , prNumber] = parts;
    if (!prNumber || !/^\d+$/.test(prNumber)) {
        throw new Error(`PR 编号解析失败（非数字）：${prUrl}`);
    }

    const platform = parsed.hostname.includes('github.com') ? 'github' : 'gitee';
    const repoUrl  = `${parsed.protocol}//${parsed.hostname}/${owner}/${repo}.git`;

    // 生成文件系统安全的目录名：owner_repo_pr{number}
    const safeOwner = owner.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeRepo  = repo.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dirName   = `${safeOwner}_${safeRepo}_pr${prNumber}`;

    return { owner, repo, prNumber, platform, repoUrl, dirName };
}

/**
 * 校验 PR URL 是否合法
 * @param {string} prUrl
 * @returns {{ valid: boolean, message?: string }}
 */
export function validatePrUrl(prUrl) {
    if (!prUrl || typeof prUrl !== 'string') {
        return { valid: false, message: 'prUrl 不能为空' };
    }
    try {
        const u = new URL(prUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return { valid: false, message: 'prUrl 必须是 http/https 协议' };
        }
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length < 4 || !/^\d+$/.test(parts[3])) {
            return {
                valid: false,
                message: '无法解析 PR URL，请确认格式：https://github.com/owner/repo/pull/123 或 https://gitee.com/owner/repo/pulls/123',
            };
        }
        return { valid: true };
    } catch {
        return { valid: false, message: 'prUrl 格式非法' };
    }
}

// ─── 仓库地址解析 ───────────────────────────────────────────────────────────────

/**
 * 解析仓库地址，提取 owner、repo、branch、commit、subpath 等信息
 * 支持格式：
 *   标准 Git URL：https://github.com/{owner}/{repo}.git 或 https://github.com/{owner}/{repo}
 *   Web 页面 URL（带分支）：https://gitcode.com/{owner}/{repo}/tree/{branch}
 *   Web 页面 URL（带分支和子路径）：https://gitcode.com/{owner}/{repo}/tree/{branch}/{subpath}
 *   Web 页面 URL（带 commit）：https://github.com/{owner}/{repo}/blob/{commitHash}
 *   Web 页面 URL（带 commit 和子路径）：https://github.com/{owner}/{repo}/blob/{commitHash}/{subpath}
 *   GitHub Commit 页面：https://github.com/{owner}/{repo}/commit/{commitHash}
 *
 * commit hash 识别规则：/tree/、/blob/、/commit/ 后的第一段，若匹配 [0-9a-f]{7,40}（7~40 位十六进制字符）则判定为 commit hash，否则为分支名
 * branch 和 commit 互斥：按分支 checkout 时 commit 为 null，按 commit checkout 时 branch 为 null
 *
 * 示例：
 *   https://github.com/openharmony-sig/flutter_inappwebview.git
 *   → { owner: 'openharmony-sig', repo: 'flutter_inappwebview', branch: null, commit: null, checkoutMode: null, subpath: null, repoName: 'openharmony-sig_flutter_inappwebview' }
 *
 *   https://gitcode.com/openharmony-sig/flutter_inappwebview/tree/br_v6.1.5_ohos_dev
 *   → { ..., branch: 'br_v6.1.5_ohos_dev', commit: null, checkoutMode: 'branch', subpath: null, repoName: 'openharmony-sig_flutter_inappwebview_br_v6_1_5_ohos_dev' }
 *
 *   https://gitcode.com/openharmony-tpc/openharmony_tpc_samples/tree/master/vap
 *   → { ..., branch: 'master', commit: null, checkoutMode: 'branch', subpath: 'vap', repoName: 'openharmony-tpc_openharmony_tpc_samples_master_vap' }
 *
 *   https://github.com/TencentCloud/cos-sdk-react-native-plugin/blob/913e7da456a6
 *   → { ..., branch: null, commit: '913e7da456a6', checkoutMode: 'commit', subpath: null, repoName: 'TencentCloud_cos-sdk-react-native-plugin_c913e7da' }
 *
 *   https://github.com/TencentCloud/cos-sdk-react-native-plugin/blob/913e7da456a6/src
 *   → { ..., branch: null, commit: '913e7da456a6', checkoutMode: 'commit', subpath: 'src', repoName: 'TencentCloud_cos-sdk-react-native-plugin_c913e7da_src' }
 *
 *   https://github.com/org/repo/commit/913e7da456a6
 *   → { ..., branch: null, commit: '913e7da456a6', checkoutMode: 'commit', subpath: null, repoName: 'org_repo_c913e7da' }
 *
 * @param {string} repoUrl
 * @returns {{ owner: string, repo: string, platform: string, branch: string|null, commit: string|null, checkoutMode: string|null, subpath: string|null, repoName: string, baseUrl: string }}
 * @throws {Error} 若 URL 无法解析
 */
export function parseRepoUrl(repoUrl) {
    let parsed;
    try {
        // 支持 git:// 协议，转换为 https
        const normalizedUrl = repoUrl.startsWith('git://') 
            ? repoUrl.replace('git://', 'https://') 
            : repoUrl;
        parsed = new URL(normalizedUrl);
    } catch {
        throw new Error(`无效的仓库 URL：${repoUrl}`);
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    // 期望格式: [owner, repo] 或 [owner, repo.git] 或 [owner, repo, 'tree', branch, ...subpath]
    if (parts.length < 2) {
        throw new Error(`无法从 URL 路径解析 owner/repo：${repoUrl}`);
    }

    const [owner, repoRaw] = parts;
    // 移除 .git 后缀
    const repo = repoRaw.replace(/\.git$/, '');

    // 识别平台
    let platform;
    if (parsed.hostname.includes('github.com')) {
        platform = 'github';
    } else if (parsed.hostname.includes('gitee.com')) {
        platform = 'gitee';
    } else if (parsed.hostname.includes('gitcode.com')) {
        platform = 'gitcode';
    } else if (parsed.hostname.includes('gitlab')) {
        platform = 'gitlab';
    } else {
        platform = 'unknown';
    }

    // ─── 解析分支、commit 和子路径 ─────────────────────────────────────────────
    const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/;

    let branch = null;
    let commit = null;
    let checkoutMode = null;
    let subpath = null;
    let baseUrl = `${parsed.protocol}//${parsed.hostname}/${owner}/${repo}.git`;

    // 检查 /tree/、/blob/、/commit/ 路径段，取最先出现的
    let refIdx = -1;
    let refKeyword = null;
    for (const keyword of ['tree', 'blob', 'commit']) {
        const idx = parts.indexOf(keyword);
        if (idx !== -1 && (refIdx === -1 || idx < refIdx)) {
            refIdx = idx;
            refKeyword = keyword;
        }
    }

    if (refKeyword && refIdx !== -1 && refIdx + 1 < parts.length) {
        const refValue = parts[refIdx + 1];

        if (COMMIT_HASH_RE.test(refValue)) {
            commit = refValue;
            checkoutMode = 'commit';
        } else {
            branch = refValue;
            checkoutMode = 'branch';
        }

        if (refIdx + 2 < parts.length) {
            subpath = parts.slice(refIdx + 2).join('/');
        }
    }

    // ─── 生成文件系统安全的目录名 ───────────────────────────────────────
    const safeOwner = owner.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeRepo  = repo.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    // 目录名生成策略：包含分支名/commit hash 和子路径，避免冲突
    // 优先级：owner_repo → owner_repo_branch → owner_repo_commit → owner_repo_branch_subpath → owner_repo_commit_subpath → owner_repo_subpath
    let repoName;
    if (branch && subpath) {
        const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeSubpath = subpath.replace(/[^a-zA-Z0-9_-]/g, '_');
        repoName = `${safeOwner}_${safeRepo}_${safeBranch}_${safeSubpath}`;
    } else if (commit && subpath) {
        const safeCommit = commit.substring(0, 7);
        const safeSubpath = subpath.replace(/[^a-zA-Z0-9_-]/g, '_');
        repoName = `${safeOwner}_${safeRepo}_c${safeCommit}_${safeSubpath}`;
    } else if (branch) {
        const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, '_');
        repoName = `${safeOwner}_${safeRepo}_${safeBranch}`;
    } else if (commit) {
        const safeCommit = commit.substring(0, 7);
        repoName = `${safeOwner}_${safeRepo}_c${safeCommit}`;
    } else if (subpath) {
        const safeSubpath = subpath.replace(/[^a-zA-Z0-9_-]/g, '_');
        repoName = `${safeOwner}_${safeRepo}_${safeSubpath}`;
    } else {
        repoName = `${safeOwner}_${safeRepo}`;
    }

    return { owner, repo, platform, branch, commit, checkoutMode, subpath, repoName, baseUrl };
}

/**
 * 校验仓库 URL 是否合法
 * 支持格式：
 *   - 标准 Git URL：https://github.com/owner/repo.git
 *   - Web 页面 URL（带分支）：https://gitcode.com/owner/repo/tree/branch
 *   - Web 页面 URL（带分支和子路径）：https://gitcode.com/owner/repo/tree/branch/subpath
 *   - Web 页面 URL（带 commit）：https://github.com/owner/repo/blob/913e7da456a6
 *   - Web 页面 URL（带 commit 和子路径）：https://github.com/owner/repo/blob/913e7da456a6/src
 *   - GitHub Commit 页面：https://github.com/owner/repo/commit/913e7da456a6
 *
 * @param {string} repoUrl
 * @returns {{ valid: boolean, message?: string }}
 */
export function validateRepoUrl(repoUrl) {
    if (!repoUrl || typeof repoUrl !== 'string') {
        return { valid: false, message: 'repoUrl 不能为空' };
    }
    try {
        const u = new URL(repoUrl.startsWith('git://') ? repoUrl.replace('git://', 'https://') : repoUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'git:') {
            return { valid: false, message: 'repoUrl 必须是 http/https/git 协议' };
        }
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length < 2) {
            return { valid: false, message: '无法解析仓库 URL，请确认格式：https://github.com/owner/repo 或 https://gitcode.com/owner/repo/tree/branch/subpath' };
        }

        // 如果包含 /tree/、/blob/、/commit/，额外验证 ref 是否存在
        for (const keyword of ['tree', 'blob', 'commit']) {
            const idx = parts.indexOf(keyword);
            if (idx !== -1 && idx + 1 >= parts.length) {
                return { valid: false, message: `URL 包含 /${keyword}/ 但未指定分支名称或 commit hash` };
            }
        }

        return { valid: true };
    } catch {
        return { valid: false, message: 'repoUrl 格式非法' };
    }
}

// ─── 文件路径安全校验 ───────────────────────────────────────────────────────────

/**
 * 文件路径安全校验（防目录穿越攻击）
 * 
 * 安全规则：
 * 1. 路径必须在允许的根目录内（防止 ../ 等穿越）
 * 2. 路径不能包含危险字符（如 ..、~、$、|、& 等）
 * 3. 路径不能以绝对路径开头（防止访问系统敏感目录）
 * 
 * @param {string} inputPath    - 用户输入的路径
 * @param {string} rootDir      - 允许的根目录（如 libraryRoot）
 * @returns {{ safe: boolean, resolvedPath: string | null, error?: string }}
 */
export function sanitizePath(inputPath, rootDir) {
    if (!inputPath || typeof inputPath !== 'string') {
        return { safe: false, resolvedPath: null, error: '路径不能为空' };
    }

    // 检查危险字符
    const dangerousPatterns = ['..', '~', '$', '|', '&', ';', '`', '\n', '\r'];
    for (const pattern of dangerousPatterns) {
        if (inputPath.includes(pattern)) {
            return {
                safe: false,
                resolvedPath: null,
                error: `路径包含危险字符 "${pattern}"`,
            };
        }
    }

    // 检查绝对路径（防止访问系统敏感目录）
    if (path.isAbsolute(inputPath)) {
        // 允许绝对路径，但必须校验是否在 rootDir 内
        const resolved = path.resolve(inputPath);
        if (!resolved.startsWith(rootDir)) {
            return {
                safe: false,
                resolvedPath: null,
                error: '路径穿越：尝试访问不允许的目录',
            };
        }
        return { safe: true, resolvedPath: resolved };
    }

    // 相对路径：拼接到 rootDir 并校验
    const resolved = path.resolve(rootDir, inputPath);

    // 确保最终路径仍在 rootDir 内
    if (!resolved.startsWith(rootDir)) {
        return {
            safe: false,
            resolvedPath: null,
            error: '路径穿越：尝试访问不允许的目录',
        };
    }

    return { safe: true, resolvedPath: resolved };
}

/**
 * 批量校验文件路径安全性
 * @param {string[]} inputPaths  - 待校验的路径列表
 * @param {string} rootDir       - 允许的根目录
 * @returns {{ safe: boolean, results: Array<{ path: string, safe: boolean, resolvedPath?: string, error?: string }> }}
 */
export function sanitizePaths(inputPaths, rootDir) {
    const results = inputPaths.map(p => {
        const result = sanitizePath(p, rootDir);
        return { path: p, ...result };
    });

    const allSafe = results.every(r => r.safe);
    return { safe: allSafe, results };
}
