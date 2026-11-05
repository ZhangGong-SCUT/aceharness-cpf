/**
 * TaskPersistence — 任务持久化层基类
 *
 * 提供通用的数据库初始化、CRUD、查询逻辑。
 * 子类通过实现抽象方法定义各任务类型的表结构和字段映射：
 *
 *   PortingPersistence        → porting_tasks           (22 字段)
 *   CodeCheckPersistence      → codecheck_tasks         (17 字段)
 *   FlutterLibraryCheckPersistence → flutterlibrarycheck_tasks (36 字段)
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from './logger.js';

const logger = createLogger('TaskPersistence');

// ─── TaskPersistence 基类 ─────────────────────────────────────────────────────

export class TaskPersistence {
    /**
     * @param {string} dbPath - 数据库文件绝对路径
     */
    constructor(dbPath) {
        /** @type {import('better-sqlite3').Database|null} */
        this._db = null;
        /** @type {string} */
        this._dbPath = dbPath;
    }

    /**
     * 初始化数据库：建目录、建表、运行迁移
     */
    initialize() {
        logger.info('初始化任务数据库', { path: this._dbPath, table: this._getTableName() });

        const dbDir = path.dirname(this._dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
            logger.info('创建数据库目录', { dir: dbDir });
        }

        this._db = new Database(this._dbPath);

        // ─── 并发优化：启用 WAL 模式 + busy_timeout ────────────────────────────
        // WAL 模式：读写不互斥，大幅减少锁竞争（默认 DELETE 模式写入时全库加锁）
        // busy_timeout：并发写入时等待 5s 而非立即抛 SQLITE_BUSY 错误
        // synchronous=NORMAL：WAL 模式下安全且更快（默认 FULL 每次写入都 fsync）
        this._db.pragma('journal_mode = WAL');
        this._db.pragma('busy_timeout = 5000');
        this._db.pragma('synchronous = NORMAL');

        this._db.exec(this._getTableSchema());
        this._runMigrations();

        logger.info('任务数据库初始化完成', { table: this._getTableName(), mode: 'WAL' });
    }

    /**
     * 关闭数据库连接
     */
    close() {
        if (this._db) {
            this._db.close();
            this._db = null;
            logger.info('任务数据库连接已关闭', { table: this._getTableName() });
        }
    }

    // ─── 子类必须实现 ──────────────────────────────────────────────────────────

    /** @returns {string} 表名 */
    _getTableName() { throw new Error(`${this.constructor.name} 未实现 _getTableName()`); }

    /** @returns {string} 建表 SQL（含索引） */
    _getTableSchema() { throw new Error(`${this.constructor.name} 未实现 _getTableSchema()`); }

    /** @returns {string[]} 终止状态列表 */
    _getTerminalStages() { throw new Error(`${this.constructor.name} 未实现 _getTerminalStages()`); }

    /** @returns {string[]} patch() 允许更新的字段列表 */
    _getAllowedPatchFields() { throw new Error(`${this.constructor.name} 未实现 _getAllowedPatchFields()`); }

    /** 创建任务记录 */
    create(task) { throw new Error(`${this.constructor.name} 未实现 create()`); }

    /** 将数据库行映射为任务对象 */
    _rowToTask(row) { throw new Error(`${this.constructor.name} 未实现 _rowToTask()`); }

    // ─── 子类可选覆盖 ──────────────────────────────────────────────────────────

    /** 执行数据库迁移（默认无操作，子类可覆盖实现自动迁移） */
    _runMigrations() {}

    // ─── 通用 CRUD ──────────────────────────────────────────────────────────────

    get(taskId) {
        const row = this._db.prepare(`SELECT * FROM ${this._getTableName()} WHERE taskId = ?`).get(taskId);
        return row ? this._rowToTask(row) : null;
    }

    list() {
        return this._db.prepare(`SELECT * FROM ${this._getTableName()} ORDER BY createdAt DESC`).all()
            .map(row => this._rowToTask(row));
    }

    /**
     * 从 SQLite 直接查询最近 limit 条任务（按 createdAt 降序）
     * 避免全量加载到内存，适用于分页列表 API
     * @param {number} limit - 最大返回条数
     * @returns {TaskRecord[]}
     */
    listRecent(limit = 100) {
        return this._db.prepare(
            `SELECT * FROM ${this._getTableName()} ORDER BY createdAt DESC LIMIT ?`
        ).all(limit).map(row => this._rowToTask(row));
    }

    /**
     * 分页查询任务（按 createdAt 降序）
     * @param {number} page - 页码，从 1 开始
     * @param {number} pageSize - 每页条数
     * @returns {TaskRecord[]}
     */
    listPage(page = 1, pageSize = 20) {
        const offset = (page - 1) * pageSize;
        return this._db.prepare(
            `SELECT * FROM ${this._getTableName()} ORDER BY createdAt DESC LIMIT ? OFFSET ?`
        ).all(pageSize, offset).map(row => this._rowToTask(row));
    }

    /**
     * 按提交人分页查询（A10：用户条件先下沉到数据库，再排序分页，
     * 避免"全站最近 N 条再过滤"把用户自己的较早任务挤掉）
     * @param {string} ownerUsername - 提交人用户名
     * @param {number} limit
     * @param {number} offset
     * @returns {TaskRecord[]}
     */
    listRecentByOwner(ownerUsername, limit = 100, offset = 0) {
        return this._db.prepare(
            `SELECT * FROM ${this._getTableName()} WHERE ownerUsername = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?`
        ).all(ownerUsername, limit, offset).map(row => this._rowToTask(row));
    }

    /**
     * 按提交人统计任务总数（A10）
     * @param {string} ownerUsername
     * @returns {number}
     */
    countByOwner(ownerUsername) {
        const row = this._db.prepare(
            `SELECT COUNT(*) as total FROM ${this._getTableName()} WHERE ownerUsername = ?`
        ).get(ownerUsername);
        return row ? row.total : 0;
    }

    /**
     * 按父任务查询直接子任务（A11：迭代链展开走持久化查询，不依赖内存缓存预热）
     * @param {string} parentTaskId
     * @returns {TaskRecord[]}
     */
    listByParent(parentTaskId) {
        return this._db.prepare(
            `SELECT * FROM ${this._getTableName()} WHERE parentTaskId = ? ORDER BY createdAt ASC`
        ).all(parentTaskId).map(row => this._rowToTask(row));
    }

    /**
     * 获取任务总数（不加载任务数据，仅 COUNT）
     * @returns {number}
     */
    count() {
        const row = this._db.prepare(
            `SELECT COUNT(*) as total FROM ${this._getTableName()}`
        ).get();
        return row ? row.total : 0;
    }

    delete(taskId) {
        this._db.prepare(`DELETE FROM ${this._getTableName()} WHERE taskId = ?`).run(taskId);
        logger.debug('任务已删除', { taskId });
    }

    /**
     * 动态更新任务字段，仅更新 _getAllowedPatchFields() 中声明的字段
     * @param {string} taskId
     * @param {object} patchData
     */
    patch(taskId, patchData) {
        const allowedFields = this._getAllowedPatchFields();
        const updates = [];
        const values = [];

        for (const [key, value] of Object.entries(patchData)) {
            if (allowedFields.includes(key)) {
                updates.push(`${key} = ?`);
                if (key === 'metadata') {
                    values.push(this._serMeta(value));
                } else if (key === 'error') {
                    values.push(this._serErr(value));
                } else {
                    values.push(value ?? null);
                }
            }
        }

        if (updates.length === 0) {
            logger.warn('patch: 无有效字段', { taskId, fields: Object.keys(patchData) });
            return;
        }

        updates.push('updatedAt = ?');
        values.push(new Date().toISOString());
        values.push(taskId);

        this._db.prepare(
            `UPDATE ${this._getTableName()} SET ${updates.join(', ')} WHERE taskId = ?`
        ).run(...values);

        logger.debug('任务已更新', { taskId, fields: Object.keys(patchData) });
    }

    // ─── 查询操作 ──────────────────────────────────────────────────────────────

    listIncomplete() {
        const terminal = this._getTerminalStages();
        return this._db.prepare(
            `SELECT * FROM ${this._getTableName()} WHERE stage NOT IN (${terminal.map(() => '?').join(',')}) ORDER BY createdAt ASC`
        ).all(...terminal).map(row => this._rowToTask(row));
    }

    listByStage(stage) {
        return this._db.prepare(
            `SELECT * FROM ${this._getTableName()} WHERE stage = ? ORDER BY createdAt DESC`
        ).all(stage).map(row => this._rowToTask(row));
    }

    listByTimeRange(startTime, endTime) {
        return this._db.prepare(
            `SELECT * FROM ${this._getTableName()} WHERE createdAt >= ? AND createdAt <= ? ORDER BY createdAt DESC`
        ).all(startTime, endTime).map(row => this._rowToTask(row));
    }

    countByStage() {
        return this._db.prepare(
            `SELECT stage, COUNT(*) as count FROM ${this._getTableName()} GROUP BY stage`
        ).all();
    }

    // ─── 工具方法（供子类使用）────────────────────────────────────────────────

    _serErr(e) { return JSON.stringify(e ?? null); }
    _desErr(raw) {
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return { code: 'unknown', message: raw }; }
    }
    _serMeta(m) { return JSON.stringify(m ?? {}); }
    _desMeta(raw) {
        if (!raw) return {};
        try { return JSON.parse(raw); } catch { return {}; }
    }
}