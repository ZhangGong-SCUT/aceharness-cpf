/**
 * IssueAnalysisPersistence — Issue 分析任务持久化（issueanalysis_tasks 表）
 *
 * 表字段（19 个）：
 *   公共字段 (10)：taskId, cliType, stage, createdAt, updatedAt,
 *                  startedAt, finishedAt, error, retries, metadata
 *   专有字段  (9)：issueUrl, issueType, dirName, analysisSessionId,
 *                  analysisReportUrl, resultUrl, priorityLevel, summary, accessToken
 *
 * 设计原则：与 CodeCheckPersistence 完全对齐，便于复用基础设施与前端模式。
 */

import { TaskPersistence } from '../TaskPersistence.js';
import { createLogger } from '../logger.js';

const logger = createLogger('IssueAnalysisPersistence');

const TABLE = 'issueanalysis_tasks';
const TERMINAL_STAGES = ['issueanalysis_complete', 'failed', 'cancelled'];

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
        taskId            TEXT PRIMARY KEY,
        cliType           TEXT NOT NULL,
        stage             TEXT NOT NULL,
        createdAt         TEXT NOT NULL,
        updatedAt         TEXT NOT NULL,
        startedAt         TEXT,
        finishedAt        TEXT,
        error             TEXT,
        retries           INTEGER DEFAULT 0,
        metadata          TEXT,
        issueUrl          TEXT,
        issueType         TEXT,
        dirName           TEXT,
        analysisSessionId TEXT,
        analysisReportUrl TEXT,
        resultUrl         TEXT,
        priorityLevel     TEXT,
        summary           TEXT,
        accessToken       TEXT,
        parentTaskId      TEXT,
        userFeedback      TEXT,
        ownerUsername     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_issueanalysis_stage     ON ${TABLE}(stage);
    CREATE INDEX IF NOT EXISTS idx_issueanalysis_createdAt ON ${TABLE}(createdAt);
    CREATE INDEX IF NOT EXISTS idx_issueanalysis_dirName   ON ${TABLE}(dirName);
    CREATE INDEX IF NOT EXISTS idx_issueanalysis_priority ON ${TABLE}(priorityLevel);
    -- idx_issueanalysis_parent 依赖 parentTaskId 列：已有库中该列由 _runMigrations 补建，
    -- 索引必须在迁移之后创建（放 SCHEMA 会在旧库上因列不存在而启动失败），见 _runMigrations 尾部
`;

const ALLOWED_PATCH_FIELDS = [
    'stage', 'startedAt', 'finishedAt', 'error', 'retries', 'metadata',
    'issueUrl', 'issueType', 'dirName', 'analysisSessionId',
    'analysisReportUrl', 'resultUrl', 'priorityLevel', 'summary', 'accessToken',
    'parentTaskId', 'userFeedback', 'ownerUsername',
];

export class IssueAnalysisPersistence extends TaskPersistence {
    _getTableName() { return TABLE; }
    _getTableSchema() { return SCHEMA; }
    _getTerminalStages() { return TERMINAL_STAGES; }
    _getAllowedPatchFields() { return ALLOWED_PATCH_FIELDS; }

    create(task) {
        this._db.prepare(`
            INSERT INTO ${TABLE} (
                taskId, cliType, stage, createdAt, updatedAt, startedAt, finishedAt,
                error, retries, metadata,
                issueUrl, issueType, dirName, analysisSessionId,
                analysisReportUrl, resultUrl, priorityLevel, summary, accessToken,
                parentTaskId, userFeedback, ownerUsername
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            task.taskId,
            task.cliType,
            task.stage ?? 'pending',
            task.createdAt,
            task.updatedAt,
            task.startedAt ?? null,
            task.finishedAt ?? null,
            this._serErr(task.error),
            task.retries ?? 0,
            this._serMeta(task.metadata),
            task.issueUrl ?? null,
            task.issueType ?? null,
            task.dirName ?? null,
            task.analysisSessionId ?? null,
            task.analysisReportUrl ?? null,
            task.resultUrl ?? null,
            task.priorityLevel ?? null,
            task.summary ?? null,
            task.accessToken ?? null,
            task.parentTaskId ?? null,
            task.userFeedback ?? null,
            task.ownerUsername ?? null,
        );
        logger.debug('Issue 分析任务已持久化', { taskId: task.taskId });
    }

    _rowToTask(row) {
        return {
            taskId: row.taskId,
            cliType: row.cliType,
            stage: row.stage,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
            error: this._desErr(row.error),
            retries: row.retries,
            metadata: this._desMeta(row.metadata),
            issueUrl: row.issueUrl,
            issueType: row.issueType,
            dirName: row.dirName,
            analysisSessionId: row.analysisSessionId ?? null,
            analysisReportUrl: row.analysisReportUrl,
            resultUrl: row.resultUrl,
            priorityLevel: row.priorityLevel,
            summary: row.summary,
            accessToken: row.accessToken,
            parentTaskId: row.parentTaskId ?? null,
            userFeedback: row.userFeedback ?? null,
            ownerUsername: row.ownerUsername ?? null,
        };
    }

    /**
     * 数据库迁移：补齐新列（幂等）
     */
    _runMigrations() {
        const columns = this._db.prepare(`PRAGMA table_info(${TABLE})`).all();
        const columnNames = columns.map(c => c.name);
        if (!columnNames.includes('analysisSessionId')) {
            this._db.exec(`ALTER TABLE ${TABLE} ADD COLUMN analysisSessionId TEXT`);
            logger.info('已为 issueanalysis_tasks 表添加 analysisSessionId 列');
        }
        if (!columnNames.includes('summary')) {
            this._db.exec(`ALTER TABLE ${TABLE} ADD COLUMN summary TEXT`);
            logger.info('已为 issueanalysis_tasks 表添加 summary 列');
        }
        if (!columnNames.includes('parentTaskId')) {
            this._db.exec(`ALTER TABLE ${TABLE} ADD COLUMN parentTaskId TEXT`);
            logger.info('已为 issueanalysis_tasks 表添加 parentTaskId 列');
        }
        if (!columnNames.includes('userFeedback')) {
            this._db.exec(`ALTER TABLE ${TABLE} ADD COLUMN userFeedback TEXT`);
            logger.info('已为 issueanalysis_tasks 表添加 userFeedback 列');
        }
        if (!columnNames.includes('ownerUsername')) {
            this._db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ownerUsername TEXT`);
            logger.info('已为 issueanalysis_tasks 表添加 ownerUsername 列');
        }
        // 新列索引：必须在补列之后创建（新建库列已在 SCHEMA 中，此处幂等跳过）
        this._db.exec(`CREATE INDEX IF NOT EXISTS idx_issueanalysis_parent ON ${TABLE}(parentTaskId)`);
    }
}
