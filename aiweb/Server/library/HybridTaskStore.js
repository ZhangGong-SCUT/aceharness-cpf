/**
 * HybridTaskStore — 混合任务存储层
 * 
 * 内存缓存 + SQLite 持久化双写策略
 * 
 * 特性：
 * 1. 内存优先：快速读取，避免频繁数据库查询
 * 2. 持久化兜底：进程重启后自动恢复
 * 3. 默认启用持久化：无需配置，自动保存任务数据
 * 4. 可选禁用：通过环境变量 TASK_PERSISTENCE=false 禁用（仅用于调试）
 * 5. 数据库分离：不同任务类型使用独立数据库文件
 * 
 * 使用场景：
 * - 生产环境：默认启用持久化，支持容灾恢复（推荐）
 * - 开发调试：设置 TASK_PERSISTENCE=false 禁用持久化，保持轻量
 */

import { IssueAnalysisPersistence } from './persistence/IssueAnalysisPersistence.js';
import config from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('HybridTaskStore');

// ─── HybridTaskStore 类 ───────────────────────────────────────────────────────────

export class HybridTaskStore {
    /**
     * @param {string} [dbName] - 数据库文件名（不含路径），如 'issueanalysis.db'
     *                            不同任务类型使用独立数据库，实现高内聚
     *                            数据库统一存储在 db 目录下的对应子目录
     */
    constructor(dbName = 'tasks.db') {
        // 根据数据库名称确定存储目录
        // issueanalysis.db -> db/issueanalysis/
        const dbDirMap = {
            'issueanalysis.db': 'issueanalysis',
        };
        const dbSubdir = dbDirMap[dbName] || 'issueanalysis';

        /** @type {Map<string, TaskRecord>} - 内存缓存 */
        this._tasks = new Map();

        /** @type {TaskPersistence|null} - 持久化层 */
        this._persistence = null;

        /** @type {boolean} - 是否启用持久化（默认启用，只有明确设置 TASK_PERSISTENCE=false 才会禁用） */
        this._enablePersistence = process.env.TASK_PERSISTENCE !== 'false';

        /** @type {string} - 数据库文件名 */
        this._dbName = dbName;

        /** @type {string} - 数据库存储子目录 */
        this._dbSubdir = dbSubdir;
    }

    /**
     * 初始化存储层（同步）
     * 
     * 恢复策略：
     * - 默认恢复所有任务（包括已完成），保留历史记录
     * - 可通过环境变量 RESTORE_COMPLETED=false 禁用已完成任务恢复（节省内存）
     */
    initialize() {
        if (!this._enablePersistence) {
            logger.info('任务存储：纯内存模式（未启用持久化）', { dbName: this._dbName });
            return;
        }

        // 根据 dbName 选择数据库根目录和对应的持久化子类
        const rootDirMap = {
            'issueanalysis.db': config.issueanalysisRoot,
        };
        const persistenceFactory = {
            'issueanalysis.db': (p) => new IssueAnalysisPersistence(p),
        };

        const dbRoot = rootDirMap[this._dbName] || config.issueanalysisRoot;
        const dbPath = `${dbRoot}/${this._dbName}`;
        const factory = persistenceFactory[this._dbName] || ((p) => new PortingPersistence(p));

        this._persistence = factory(dbPath);
        this._persistence.initialize();
        logger.info('任务存储：混合模式（内存+SQLite）', { dbPath, table: this._persistence._getTableName() });

        // ─── 改进：仅恢复未完成任务，已完成任务按需从 SQLite 加载 ──────────
        // 生产环境中已完成任务可能数百条，全量加载到内存会：
        // 1. 拖慢启动速度（每条任务需反序列化）
        // 2. 占用大量内存
        // 3. list() 返回全部任务导致 JSON 序列化阻塞事件循环
        // 已完成任务通过 listRecent() 从 SQLite 直接查询，无需常驻内存
        const restoreCompleted = process.env.RESTORE_COMPLETED === 'true';  // 默认 false

        const tasks = restoreCompleted 
            ? this._persistence.list()           // 恢复所有任务（仅调试用）
            : this._persistence.listIncomplete(); // 仅恢复未完成任务（生产默认）
        
        for (const task of tasks) {
            this._tasks.set(task.taskId, task);
        }

        if (tasks.length > 0) {
            logger.info('任务恢复完成', {
                count: tasks.length,
                restoreCompleted,
                summary: {
                    completed: tasks.filter(t => t.stage.includes('complete')).length,
                    running: tasks.filter(t => !t.stage.includes('complete') && t.stage !== 'failed' && t.stage !== 'cancelled').length,
                    failed: tasks.filter(t => t.stage === 'failed').length,
                    cancelled: tasks.filter(t => t.stage === 'cancelled').length,
                },
            });
        }
    }

    /**
     * 关闭持久化层
     */
    close() {
        if (this._persistence) {
            this._persistence.close();
        }
    }

    // ─── CRUD 操作 ───────────────────────────────────────────────────────────────

    /**
     * 创建并存储新任务记录（泛型方法）
     * 
     * 高内聚设计：接收任意任务字段，内部统一处理存储逻辑
     * 不同任务类型传入不同字段集：
     * - porting: { taskId, libraryName, sourceCodeUrl, cliType }
     * - codecheck: { taskId, prUrl, libraryType, dirName, cliType }
     * 
     * @param {object} fields - 任务字段对象
     * @returns {TaskRecord}
     */
    create(fields) {
        const now = new Date().toISOString();
        
        // 默认字段模板（所有任务类型共有）
        const defaultFields = {
            stage: 'pending',
            createdAt: now,
            updatedAt: now,
            error: null,
            retries: 0,
            metadata: null,
            // porting 任务专有字段（可为 null）
            libraryName: null,
            sourceCodeUrl: null,
            analysisSessionId: null,
            compileSessionId: null,
            portingSessionId: null,
            testSessionId: null,
            interfaceSessionId: null,  // 接口分析 Session ID（Flutter/ArkTS 仓库检视共用）
            stabilitySessionId: null,      // 稳定性检视 Session ID
            consistencySessionId: null,    // 一致性检视 Session ID（Flutter 专用）
            codeQualitySessionId: null,    // 编码质量检视 Session ID
            memoryLeakSessionId: null,     // 内存泄露检视 Session ID
            documentationSessionId: null,  // 文档质量检视 Session ID
            testCoverageSessionId: null,   // 用例覆盖度检视 Session ID
            analysisReportUrl: null,
            compileResultUrl: null,
            portingResultUrl: null,
            testReportUrl: null,
            testErrorUrl: null,
            portingErrorUrl: null,
            // codecheck 任务专有字段（可为 null）
            prUrl: null,
            libraryType: null,
            dirName: null,
            checkReportUrl: null,
            accessToken: null,
            // librarycheck 任务专有字段（可为 null）
            repoUrl: null,
            repoName: null,
            // 仓库审查产物字段（可为 null）
            interfaceDocUrl: null,      // 接口规格说明文档URL
            qualityReportUrl: null,     // 质量检查报告URL
            qualityScore: null,         // 质量评分（0-100）
            // flutterlibrarycheck 任务专有字段（可为 null）
            // Flutter 仓库检视 - 7 个 SKILL 评分
            stabilityScore: null,       // 稳定性评分 (0-100)
            consistencyScore: null,     // 一致性评分 (0-100)
            codeQualityScore: null,     // 编码质量评分 (0-100)
            memoryLeakScore: null,      // 内存泄露评分 (0-100)
            documentationScore: null,   // 文档质量评分 (0-100)
            testCoverageScore: null,    // 用例覆盖度评分 (0-100)
            overallScore: null,         // 综合评分 (加权平均)
            // Flutter 仓库检视产物 URL
            stabilityReportUrl: null,
            consistencyReportUrl: null,
            codeQualityReportUrl: null,
            memoryLeakReportUrl: null,
            documentationReportUrl: null,
            testCoverageReportUrl: null,
            overallReportUrl: null,
            // 代码检视合入建议分级字段（可为 null）
            mergeLevel: null,           // 合入等级：PASS / CONDITIONAL / NEED_FIX / REJECT
            resultUrl: null,            // result.txt 文件路径
            // RN 仓库检视专有字段（可为 null）
            ohosRepoUrl: null,          // 鸿蒙化仓库地址
            upstreamRepoUrl: null,      // 上游原社区仓库地址
            ohosRepoName: null,         // 鸿蒙化仓库名称
            upstreamRepoName: null,     // 上游仓库名称
            rndocUrl: null,             // 外部文档地址（跳转文档模式下优先使用）
            rnRntUrl: null,             // 测试用例地址（用例覆盖度检视参考，含 demoPath 信息）
            // 任务执行时间字段（可为 null）
            startedAt: null,            // 开始执行时间（ISO 时间字符串）
            finishedAt: null,           // 结束执行时间（ISO 时间字符串）
            // 三方库文档修改专有字段（可为 null）
            docFixSessionId: null,      // 文档修改 Session ID
            prStatus: null,             // PR 状态：success / failed / completed / unknown
            reportUrl: null,            // 报告 URL
            // JAVA 库鸿蒙化专有字段（可为 null）
            libraryName: null,              // 库名（不含时间戳）
            analyzerSessionId: null,        // 分析阶段 Session ID
            portingSessionId: null,         // 移植阶段 Session ID
            comparisonSessionId: null,      // 对比阶段 Session ID
            fixSessionId: null,             // 修复阶段 Session ID
            interfaceSessionId: null,       // 接口文档阶段 Session ID
            demoTestSessionId: null,        // Demo+测试阶段 Session ID
            analyzerReportUrl: null,        // 分析报告 URL
            portingReportUrl: null,         // 移植报告 URL
            comparisonReportUrl: null,      // 对比报告 URL
            fixReportUrl: null,             // 修复报告 URL
            interfaceReportUrl: null,       // 接口文档 URL
            demoTestReportUrl: null,        // Demo+测试报告 URL
            analyzerStatus: null,           // 分析阶段状态
            portingStatus: null,            // 移植阶段状态
            comparisonStatus: null,         // 对比阶段状态
            fixStatus: null,                // 修复阶段状态
            interfaceStatus: null,          // 接口文档阶段状态
            demoTestStatus: null,           // Demo+测试阶段状态
            canPort: null,                  // 是否可以鸿蒙化 (boolean)
            comparisonScore: null,          // 对比评分 (0-100)
            fixRound: null,                 // 修复轮次
            overallStatus: null,            // 总体状态
            // Issue 分析任务专有字段（可为 null）
            issueUrl: null,                 // Issue URL
            issueType: null,                // Issue 类型（bug/feature/question）
            analysisSessionId: null,        // 分析 Session ID（外部 Agent）
            analysisReportUrl: null,        // 分析报告 URL（外部 Agent 返回）
            resultUrl: null,                // result.txt 相对路径
            priorityLevel: null,            // 优先级（high/medium/low）
            summary: null,                  // 摘要
            parentTaskId: null,             // 反馈迭代：父任务 ID（AI 轮）
            userFeedback: null,             // 反馈迭代：本轮用户修改意见
            ownerUsername: null,            // 提交人（身份隔离：非本人仅 admin 可见）
        };

        // 合并：传入字段覆盖默认值
        /** @type {TaskRecord} */
        const task = { ...defaultFields, ...fields };

        // 写入内存
        this._tasks.set(task.taskId, task);

        // 双写持久化层（同步）
        if (this._persistence) {
            try {
                this._persistence.create(task);
            } catch (err) {
                logger.error('任务持久化失败', { taskId: task.taskId, error: err.message });
            }
        }

        return task;
    }

    /**
     * 获取任务记录
     *
     * 优先从内存读取（活跃任务），若内存中没有则从 SQLite 查询（已完成任务）。
     * 这是因为初始化时默认不加载已完成任务到内存，需要按需从持久化层读取。
     *
     * @param {string} taskId
     * @returns {TaskRecord|null}
     */
    get(taskId) {
        // 优先从内存读取（活跃任务常驻内存）
        const memTask = this._tasks.get(taskId);
        if (memTask) return memTask;

        // 内存中没有，从 SQLite 查询（已完成任务按需加载）
        if (this._persistence) {
            const dbTask = this._persistence.get(taskId);
            if (dbTask) {
                // 缓存到内存，避免下次再查 SQLite
                this._tasks.set(taskId, dbTask);
                return dbTask;
            }
        }

        return null;
    }

    /**
     * 获取所有任务列表
     * @returns {TaskRecord[]}
     */
    list() {
        return Array.from(this._tasks.values());
    }

    /**
     * 获取最近创建的任务（分页，按 createdAt 降序）
     *
     * 生产环境中任务数据量大时，list() 返回全部任务会导致：
     * - JSON 序列化阻塞事件循环
     * - 响应体过大（MB 级）导致网络传输慢
     * - 前端渲染卡顿
     *
     * 如果内存中任务不足 limit 条（因为初始化时未恢复已完成任务），
     * 则从 SQLite 直接查询最近 limit 条任务，确保结果完整。
     *
     * @param {number} [limit=100]  - 返回的最大任务数
     * @returns {TaskRecord[]}
     */
    listRecent(limit = 100) {
        // 如果持久化层有 listRecent 方法，直接从 SQLite 查询（避免内存全量加载）
        if (this._persistence && typeof this._persistence.listRecent === 'function') {
            return this._persistence.listRecent(limit);
        }

        // fallback：从内存中排序截取
        const all = Array.from(this._tasks.values());
        all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        return all.slice(0, limit);
    }

    /**
     * 分页查询任务（按 createdAt 降序）
     * @param {number} page - 页码，从 1 开始
     * @param {number} pageSize - 每页条数
     * @returns {TaskRecord[]}
     */
    listPage(page = 1, pageSize = 20) {
        if (this._persistence && typeof this._persistence.listPage === 'function') {
            return this._persistence.listPage(page, pageSize);
        }
        // fallback：从内存中排序截取
        const all = Array.from(this._tasks.values());
        all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        const offset = (page - 1) * pageSize;
        return all.slice(offset, offset + pageSize);
    }

    /**
     * 按提交人分页查询（A10：条件先下沉到数据库再排序分页，
     * 避免"全站最近 N 条再过滤"把该用户自己的较早任务挤掉）
     * @param {string} ownerUsername
     * @param {number} [limit=100]
     * @param {number} [offset=0]
     * @returns {TaskRecord[]}
     */
    listRecentByOwner(ownerUsername, limit = 100, offset = 0) {
        if (this._persistence && typeof this._persistence.listRecentByOwner === 'function') {
            return this._persistence.listRecentByOwner(ownerUsername, limit, offset);
        }
        // fallback：从内存中过滤排序截取
        const all = Array.from(this._tasks.values())
            .filter(t => t.ownerUsername === ownerUsername);
        all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        return all.slice(offset, offset + limit);
    }

    /**
     * 按提交人统计任务总数（A10）
     * @param {string} ownerUsername
     * @returns {number}
     */
    countByOwner(ownerUsername) {
        if (this._persistence && typeof this._persistence.countByOwner === 'function') {
            return this._persistence.countByOwner(ownerUsername);
        }
        let n = 0;
        for (const t of this._tasks.values()) if (t.ownerUsername === ownerUsername) n++;
        return n;
    }

    /**
     * 按父任务查询直接子任务（A11：迭代链展开走持久化查询，不依赖内存缓存预热；
     * 重启后已完成任务不在内存，但迭代链必须完整展示）
     * @param {string} parentTaskId
     * @returns {TaskRecord[]}
     */
    listByParent(parentTaskId) {
        if (this._persistence && typeof this._persistence.listByParent === 'function') {
            return this._persistence.listByParent(parentTaskId);
        }
        // fallback：从内存中过滤
        return Array.from(this._tasks.values())
            .filter(t => t.parentTaskId === parentTaskId)
            .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    }

    /**
     * 获取任务总数（不加载任务数据，仅 COUNT）
     * 优先使用持久化层的 count()，fallback 用内存 Map 大小
     * @returns {number}
     */
    count() {
        if (this._persistence && typeof this._persistence.count === 'function') {
            return this._persistence.count();
        }
        return this._tasks.size;
    }

    /**
     * 删除任务记录
     * @param {string} taskId
     */
    delete(taskId) {
        // 从内存删除
        this._tasks.delete(taskId);

        // 从持久化层删除
        if (this._persistence) {
            try {
                this._persistence.delete(taskId);
            } catch (err) {
                logger.error('任务删除持久化失败', { taskId, error: err.message });
            }
        }
    }

    /**
     * 原地更新任务字段
     * @param {string} taskId
     * @param {Partial<TaskRecord>} patch
     */
    patch(taskId, patch) {
        const task = this._tasks.get(taskId);
        if (!task) return;

        // 更新内存
        Object.assign(task, patch, { updatedAt: new Date().toISOString() });

        // 双写持久化层（同步）
        if (this._persistence) {
            try {
                this._persistence.patch(taskId, patch);
            } catch (err) {
                logger.error('任务更新持久化失败', { taskId, error: err.message });
            }
        }
    }

    // ─── 扩展查询（持久化专用）─────────────────────────────────────────────────────

    /**
     * 查询未完成的任务（仅持久化模式有效）
     * @returns {TaskRecord[]}
     */
    listIncomplete() {
        if (!this._persistence) {
            return this.list().filter(task => !['test_complete', 'failed', 'cancelled'].includes(task.stage));
        }
        return this._persistence.listIncomplete();
    }

    /**
     * 按状态查询任务
     * @param {string} stage
     * @returns {TaskRecord[]}
     */
    listByStage(stage) {
        if (!this._persistence) {
            return this.list().filter(task => task.stage === stage);
        }
        return this._persistence.listByStage(stage);
    }

    /**
     * 统计各状态的任务数量
     * @returns {{stage: string, count: number}[]}
     */
    countByStage() {
        if (!this._persistence) {
            const counts = {};
            for (const task of this._tasks.values()) {
                counts[task.stage] = (counts[task.stage] || 0) + 1;
            }
            return Object.entries(counts).map(([stage, count]) => ({ stage, count }));
        }
        return this._persistence.countByStage();
    }

    /**
     * 关闭存储连接（优雅关闭时调用）
     */
    close() {
        if (this._persistence) {
            this._persistence.close();
            logger.info('存储连接已关闭', { dbName: this._dbName });
        }
    }
}