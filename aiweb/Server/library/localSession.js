/**
 * 本机个人部署的管理员会话。
 * 调用方必须在 HTTP 入口同时校验 personal 部署和回环地址；此模块不提供网络边界。
 */
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aceDataDir, isActiveAdmin } from './aceRuntime.js';

let pendingSession = null;

function readRecords(file) {
    try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(value)) throw new Error('本机账号数据格式无效');
        return value;
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function findValidSession(verifyToken) {
    const users = readRecords(join(aceDataDir(), 'users.json'));
    const admins = new Map(users.filter(isActiveAdmin).map(user => [user.id, user]));
    const tokens = readRecords(join(aceDataDir(), 'tokens.json'));
    const candidates = tokens
        .filter(([, info]) => admins.has(info?.userId) && Number(info.expiry) > Date.now())
        .sort((a, b) => Number(b[1].expiry) - Number(a[1].expiry));
    for (const [token, info] of candidates) {
        try {
            const user = await verifyToken(token);
            if (user && admins.has(user.id) && isActiveAdmin(user)) {
                return { token, user, expiresAt: Number(info.expiry) };
            }
        } catch { /* 尝试下一份本机会话，不暴露凭证 */ }
    }
    return null;
}

async function acquireLock(file) {
    for (let attempt = 0; attempt < 20; attempt++) {
        try { return openSync(file, 'wx', 0o600); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
    throw new Error('本机会话正在恢复，请稍后重试');
}

/**
 * 个人部署的请求已经在 HTTP 边界限定为回环访问。令牌和账号均在本机，
 * 直接校验同一数据目录，避免每个列表/轮询请求都再等待一次 ACE HTTP 鉴权。
 * 仅返回本机管理员；其他部署和其他用户仍走 ACE 的鉴权接口。
 */
export function readLocalAdminUserByToken(token) {
    if (process.env.AIWEB_DEPLOYMENT !== 'personal' || typeof token !== 'string' || !token) return null;
    try {
        const dataDir = aceDataDir();
        const tokens = readRecords(join(dataDir, 'tokens.json'));
        const match = tokens.find(([value, info]) => value === token && Number(info?.expiry) > Date.now());
        if (!match) return null;
        const user = readRecords(join(dataDir, 'users.json')).find(item => item.id === match[1]?.userId);
        return isActiveAdmin(user) ? user : null;
    } catch { return null; }
}

/**
 * 优先复用仍被 ACE 认可的本机管理员令牌；过期后才补发，不需要账号密码。
 * 进程内合并并发；文件锁避免多个 AIWeb 进程同时覆盖令牌文件。
 */
export async function resolveLocalAdminSession(verifyToken) {
    if (process.env.AIWEB_DEPLOYMENT !== 'personal') throw new Error('当前部署需要登录');
    if (typeof verifyToken !== 'function') throw new Error('缺少本机会话校验器');
    if (pendingSession) return pendingSession;
    pendingSession = (async () => {
        const existing = await findValidSession(verifyToken);
        if (existing) return existing;
        const dataDir = aceDataDir();
        const lockFile = join(dataDir, '.local-session.lock');
        const fd = await acquireLock(lockFile);
        try {
            // 等锁期间另一进程可能已经恢复会话，必须再检查一次。
            const recovered = await findValidSession(verifyToken);
            if (recovered) return recovered;
            const users = readRecords(join(dataDir, 'users.json'));
            const admin = users.find(isActiveAdmin);
            if (!admin?.id) throw new Error('本机尚未初始化管理员账号，请先完成 ACE 初始化');
            const tokens = readRecords(join(dataDir, 'tokens.json'));
            const token = randomBytes(32).toString('hex');
            const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
            const live = tokens.filter(([, info]) => Number(info?.expiry) > Date.now());
            live.push([token, { userId: admin.id, expiry: expiresAt }]);
            const temporary = join(dataDir, `.tokens-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
            try {
                writeFileSync(temporary, JSON.stringify(live), { mode: 0o600 });
                renameSync(temporary, join(dataDir, 'tokens.json'));
            } finally {
                try { unlinkSync(temporary); } catch { /* 原子重命名后临时文件已不存在 */ }
            }
            const user = await verifyToken(token);
            if (!user || user.id !== admin.id || !isActiveAdmin(user)) {
                // ACE 拒绝时不留下无效凭证；只撤销刚写入的 token，不影响其他有效会话。
                const current = readRecords(join(dataDir, 'tokens.json'));
                const remaining = current.filter(([value]) => value !== token);
                const rollback = join(dataDir, `.tokens-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
                try {
                    writeFileSync(rollback, JSON.stringify(remaining), { mode: 0o600 });
                    renameSync(rollback, join(dataDir, 'tokens.json'));
                } finally {
                    try { unlinkSync(rollback); } catch { /* 原子重命名后临时文件已不存在 */ }
                }
                throw new Error('ACE 尚未接受本机会话，请确认 ACE 与 AIWeb 使用相同的 ACE_HOME');
            }
            return { token, user, expiresAt };
        } finally {
            closeSync(fd);
            try { unlinkSync(lockFile); } catch { /* 锁已释放 */ }
        }
    })().finally(() => { pendingSession = null; });
    return pendingSession;
}
