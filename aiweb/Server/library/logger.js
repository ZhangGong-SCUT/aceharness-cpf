/**
 * 结构化日志封装（改进版）
 * 
 * 改进点：
 * 1. 日志文件持久化（按日期分割）
 * 2. 请求追踪（requestId）
 * 3. 性能计时（time/end）
 * 4. 日志格式配置（支持 JSON 格式）
 * 5. 异步批量写入（setImmediate flush，避免阻塞 Event Loop）
 * 
 * 格式：[时间戳] [级别] [模块] [requestId] 消息 {元数据JSON}
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import config from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// ─── 北京时间格式化工具 ────────────────────────────────────────────────────────
/**
 * 将 Date 对象转换为北京时间 ISO 格式字符串
 * @param {Date} date - Date 对象
 * @returns {string} - 北京时间字符串，格式如 "2026-05-18T14:46:59.708+08:00"
 */
function toBeijingTime(date = new Date()) {
    // 北京时间 = UTC + 8小时
    const beijingOffset = 8 * 60; // 8小时，单位分钟
    const beijingTime = new Date(date.getTime() + beijingOffset * 60 * 1000);
    
    // 格式化为 ISO 样式，但使用 +08:00 时区标识
    const iso = beijingTime.toISOString();
    return iso.replace('Z', '+08:00');
}
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

// ─── 日志文件配置 ────────────────────────────────────────────────────────────────
// 所有模块日志统一写入 issueanalysis/logs/
const DEFAULT_LOG_DIR = process.env.LOG_DIR || path.join(config.issueanalysisRoot, 'logs');
const LOG_FORMAT = process.env.LOG_FORMAT || 'text';  // 'text' 或 'json'
const LOG_MAX_SIZE = parseInt(process.env.LOG_MAX_SIZE || '10485760');  // 10 MB
const LOG_MAX_FILES = parseInt(process.env.LOG_MAX_FILES || '30');     // 保留 30 天

// ─── 模块日志目录管理 ────────────────────────────────────────────────────────
function getModuleLogDir(moduleName) {
    // 统一使用 issueanalysis 日志目录
    const logDir = process.env.LOG_DIR || path.join(config.issueanalysisRoot, 'logs');
    
    // 确保日志目录存在
    try {
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    } catch {
        // 创建失败时仅输出到 console
    }
    
    return logDir;
}

// ─── 改进：当前日志文件路径（支持模块化）────────────────────────────────────────
function getLogFilePath(logDir) {
    const date = new Date().toISOString().split('T')[0];  // YYYY-MM-DD
    return path.join(logDir, `server-${date}.log`);
}

// ─── 异步批量写入（支持模块化日志队列）─────────────────────────────────────
const _moduleLogQueues = new Map(); // 每个模块独立的日志队列
const _flushScheduled = new Map();  // 每个模块的 flush 调度标记
const _rotating = new Map();        // 每个模块的轮转标记

/**
 * 获取模块的日志队列
 */
function getModuleQueue(logDir) {
    if (!_moduleLogQueues.has(logDir)) {
        _moduleLogQueues.set(logDir, []);
        _flushScheduled.set(logDir, false);
        _rotating.set(logDir, false);
    }
    return {
        queue: _moduleLogQueues.get(logDir),
        scheduled: _flushScheduled.get(logDir),
        rotating: _rotating.get(logDir)
    };
}

/**
 * 调度一次异步 flush（同一 tick 内多次调用只 schedule 一次）
 */
function _scheduleFlush(logDir) {
    const state = getModuleQueue(logDir);
    if (state.scheduled || state.rotating) return;
    _flushScheduled.set(logDir, true);
    setImmediate(() => _flush(logDir));
}

async function _flush(logDir) {
    _flushScheduled.set(logDir, false);
    const queue = _moduleLogQueues.get(logDir) || [];
    if (queue.length === 0) return;

    const lines = queue.splice(0).join('\n') + '\n';
    const logFile = getLogFilePath(logDir);

    try {
        // 检查文件大小，超过限制时轮转
        try {
            const stats = await fsp.stat(logFile);
            if (stats.size > LOG_MAX_SIZE) {
                _rotating.set(logDir, true);
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const rotatedFile = path.join(logDir, `server-${timestamp}.log`);
                await fsp.rename(logFile, rotatedFile);
                _cleanOldLogs(logDir);  // fire-and-forget
                _rotating.set(logDir, false);
            }
        } catch {
            // 文件不存在或 stat 失败，直接写入即可
        }

        await fsp.appendFile(logFile, lines, 'utf8');
    } catch {
        // 写入失败时忽略（避免日志系统崩溃整个服务）
    }
}

/** 异步清理超过数量限制的旧日志（支持模块化）*/
async function _cleanOldLogs(logDir) {
    try {
        const entries = await fsp.readdir(logDir);
        const files = entries
            .filter(f => f.startsWith('server-') && f.endsWith('.log'))
            .sort();

        const toDelete = files.slice(0, Math.max(0, files.length - LOG_MAX_FILES));
        await Promise.allSettled(toDelete.map(f => fsp.unlink(path.join(logDir, f))));
    } catch {
        // 清理失败时忽略
    }
}

/**
 * 将一行日志加入写入队列（支持模块化）
 * @param {string} line - 日志内容
 * @param {string} logDir - 日志目录路径
 */
function writeToFile(line, logDir) {
    const queue = _moduleLogQueues.get(logDir) || [];
    queue.push(line);
    _moduleLogQueues.set(logDir, queue);
    _scheduleFlush(logDir);
}

// ─── 改进：核心日志函数（支持模块化日志路径）────────────────────────────────────
function log(level, module, message, meta, requestId = null, logDir = DEFAULT_LOG_DIR) {
    if ((LEVELS[level] ?? 99) > currentLevel) return;

    const ts = toBeijingTime();  // 使用北京时间
    const levelTag = level.toUpperCase().padEnd(5);
    
    // ─── 改进：支持 JSON 格式 ────────────────────────────────────────────────
    if (LOG_FORMAT === 'json') {
        const logObj = {
            timestamp: ts,
            level: level,
            module: module,
            requestId: requestId,
            message: message,
            meta: meta || {},
            logDir: logDir,
        };
        const line = JSON.stringify(logObj);
        
        console.log(line);
        writeToFile(line, logDir);
        return;
    }
    
    // ─── 文本格式 ────────────────────────────────────────────────────────────────
    let line = `${ts} [${levelTag}] [${module}]`;
    if (requestId) {
        line += ` [${requestId}]`;
    }
    line += ` ${message}`;
    if (meta !== undefined) {
        try {
            line += ' ' + JSON.stringify(meta);
        } catch {
            line += ' [unserializable meta]';
        }
    }

    if (level === 'error') {
        console.error(line);
    } else if (level === 'warn') {
        console.warn(line);
    } else {
        console.log(line);
    }
    
    // ─── 改进：写入日志文件（支持模块化）───────────────────────────────────────
    writeToFile(line, logDir);
}

// ─── 改进：性能计时器 ────────────────────────────────────────────────────────
const timers = new Map();

/**
 * 创建绑定模块名称的 logger 实例（自动选择模块日志目录）
 * @param {string} module - 模块名称，如 'PortingOrchestrator'
 * @returns {Object} logger 实例，包含 logDir 信息
 */
export function createLogger(module) {
    // ─── 改进：根据模块名称自动选择日志目录 ────────────────────────────────────────
    const logDir = getModuleLogDir(module);
    
    return {
        // ─── 新增：暴露 logDir 信息（便于调试）───────────────────────────────────────
        logDir: logDir,
        module: module,
        
        // ─── 日志方法（自动传入模块日志目录）───────────────────────────────────────
        error: (msg, meta, requestId) => log('error', module, msg, meta, requestId, logDir),
        warn:  (msg, meta, requestId) => log('warn',  module, msg, meta, requestId, logDir),
        info:  (msg, meta, requestId) => log('info',  module, msg, meta, requestId, logDir),
        debug: (msg, meta, requestId) => log('debug', module, msg, meta, requestId, logDir),
        
        // ─── 改进：性能计时 ────────────────────────────────────────────────
        time: (label, requestId) => {
            timers.set(`${module}:${label}`, { start: Date.now(), requestId, logDir });
        },
        timeEnd: (label, requestId) => {
            const key = `${module}:${label}`;
            const timer = timers.get(key);
            if (timer) {
                const duration = Date.now() - timer.start;
                log('info', module, `${label} 完成`, { duration: `${duration}ms` }, requestId || timer.requestId, timer.logDir || logDir);
                timers.delete(key);
            }
        },
        
        // ─── 改进：请求追踪 ────────────────────────────────────────────────
        withRequestId: (requestId) => {
            return {
                error: (msg, meta) => log('error', module, msg, meta, requestId, logDir),
                warn:  (msg, meta) => log('warn',  module, msg, meta, requestId, logDir),
                info:  (msg, meta) => log('info',  module, msg, meta, requestId, logDir),
                debug: (msg, meta) => log('debug', module, msg, meta, requestId, logDir),
                time:  (label) => timers.set(`${module}:${label}`, { start: Date.now(), requestId, logDir }),
                timeEnd: (label) => {
                    const key = `${module}:${label}`;
                    const timer = timers.get(key);
                    if (timer) {
                        const duration = Date.now() - timer.start;
                        log('info', module, `${label} 完成`, { duration: `${duration}ms` }, requestId, timer.logDir || logDir);
                        timers.delete(key);
                    }
                },
            };
        },
    };
}

// 默认 logger（未指定模块时使用）
export default createLogger('Server');
