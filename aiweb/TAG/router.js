/**
 * TAG 路由 — GitCode 打 TAG 系统 API 层
 *
 * 职责：
 *  1. 导出工厂函数 createTagRouter(express)，挂载 /tag/* 路由
 *  2. 参数校验、调用数据库和 GitCode API
 *  3. 不存储 Token，仅从请求中临时使用
 *
 * API 列表：
 *  GET    /tag/list      - 获取所有 TAG 记录
 *  POST   /tag/create    - 创建 TAG 记录（仅入库，不打 TAG）
 *  POST   /tag/execute   - 执行打 TAG 操作
 *  DELETE /tag/delete/:id - 删除 TAG 记录
 *
 * 用法（在 web/server.js 中）：
 *   const { createTagRouter } = require('../TAG/router');
 *   app.use('/tag', createTagRouter(express));
 */

'use strict';

const { GitCodeTagDB, STATUS } = require('./database');
const { createTag } = require('./gitcodeApi');
const { audit, requireAdmin } = require('../platformAudit');
const path = require('node:path');

// ── 数据库单例（延迟初始化，在 createTagRouter 中注入依赖） ────────────────────

const DB_DIR = process.env.AIWEB_TAG_DB_DIR || path.resolve(__dirname, '../../db/GitCodeTag');
let db = null;

/**
 * 创建 TAG 路由器
 * @param {object} deps - 依赖项（由宿主服务器传入，避免模块解析路径问题）
 * @param {object} deps.express   - express 模块
 * @param {Function} deps.Database - better-sqlite3 的 Database 类
 * @returns {object} Express Router 实例
 */
function createTagRouter({ express, Database }) {
  if (!db) {
    db = new GitCodeTagDB(DB_DIR, Database);
    db.initialize();
  }

  const router = express.Router();

/**
 * GET /tag/list
 * 获取所有 TAG 记录
 */
router.get('/list', (_req, res) => {
  try {
    const records = db.getAll();
    res.json({ success: true, data: records, total: records.length });
  } catch (err) {
    console.error('[TAG] 获取列表失败：', err.message);
    res.status(500).json({ success: false, message: '获取 TAG 列表失败' });
  }
});

/**
 * POST /tag/create
 * 创建一条 TAG 记录（仅入库，不执行打 TAG）
 *
 * 请求体：{ repoUrl, ref, tagName, tagDesc }
 */
router.post('/create', (req, res) => {
  try {
    const { repoUrl, ref, tagName, tagDesc } = req.body || {};

    // 参数校验
    if (!repoUrl || typeof repoUrl !== 'string' || !repoUrl.trim()) {
      return res.status(400).json({ success: false, message: '仓库地址不能为空' });
    }
    if (!ref || typeof ref !== 'string' || !ref.trim()) {
      return res.status(400).json({ success: false, message: 'Commit ID 或分支名称不能为空' });
    }
    if (!tagName || typeof tagName !== 'string' || !tagName.trim()) {
      return res.status(400).json({ success: false, message: 'TAG 名称不能为空' });
    }

    const record = db.create({
      repoUrl: repoUrl.trim(),
      ref:     ref.trim(),
      tagName: tagName.trim(),
      tagDesc: (tagDesc || '').trim(),
    });

    res.json({ success: true, data: record });
  } catch (err) {
    console.error('[TAG] 创建记录失败：', err.message);
    res.status(500).json({ success: false, message: '创建 TAG 记录失败' });
  }
});

/**
 * POST /tag/execute
 * 执行打 TAG 操作
 *
 * 请求体：{ id, token }
 * - id: 记录 ID
 * - token: GitCode Access Token（不存储）
 */
router.post('/execute', async (req, res) => {
  try {
    // R02：执行会在 GitCode 上真实打 TAG，仅限 admin
    if (!requireAdmin(req, res)) return;

    const { id, token } = req.body || {};

    // 参数校验
    if (!id) {
      return res.status(400).json({ success: false, message: '记录 ID 不能为空' });
    }
    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ success: false, message: 'GitCode Token 不能为空' });
    }

    // 查询记录
    const record = db.getById(id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'TAG 记录不存在' });
    }

    // 幂等性：已成功的不重复执行
    if (record.status === STATUS.SUCCESS) {
      return res.json({
        success: true,
        data:    record,
        message: 'TAG 已创建，无需重复执行',
      });
    }

    // 调用 GitCode API 打 TAG
    const result = await createTag({
      repoUrl: record.repoUrl,
      ref:     record.ref,
      tagName: record.tagName,
      tagDesc: record.tagDesc,
      token:   token.trim(),
    });

    // 更新数据库
    const updatedRecord = db.updateResult(id, {
      status:      result.success ? STATUS.SUCCESS : STATUS.FAILED,
      tagUrl:      result.tagUrl || '',
      errorMessage: result.errorMessage || '',
    });

    // R02：执行审计（真实写 GitCode 的敏感操作）
    audit('TAG', 'execute', req, id);

    res.json({
      success: result.success,
      data:    updatedRecord,
      message: result.success ? '打 TAG 成功' : result.errorMessage,
    });
  } catch (err) {
    console.error('[TAG] 执行打 TAG 失败：', err.message);
    res.status(500).json({ success: false, message: '执行打 TAG 操作失败' });
  }
});

/**
 * POST /tag/deprecate
 * 废弃一条 TAG 记录（标记为存在问题，不参与计数）
 *
 * 请求体：{ id }
 * 实现：将 status 设为 failed，errorMessage 设为 [DEPRECATED] 前缀
 * 不修改数据库表结构
 */
router.post('/deprecate', (req, res) => {
  try {
    // R02：废弃仅限 admin
    if (!requireAdmin(req, res)) return;

    const { id } = req.body || {};

    if (!id) {
      return res.status(400).json({ success: false, message: '记录 ID 不能为空' });
    }

    const record = db.getById(id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'TAG 记录不存在' });
    }

    // 已成功的记录不可废弃
    if (record.status === STATUS.SUCCESS) {
      return res.status(400).json({ success: false, message: '已成功的 TAG 不可废弃' });
    }

    // 已经是废弃状态则跳过
    if (record.errorMessage && record.errorMessage.startsWith('[DEPRECATED]')) {
      return res.json({ success: true, data: record, message: 'TAG 已废弃' });
    }

    // 废弃：status=failed, errorMessage=[DEPRECATED] + 原错误信息
    const prevMsg = (record.errorMessage && record.errorMessage.trim()) ? record.errorMessage.trim() : '';
    const deprecatedMsg = prevMsg ? `[DEPRECATED] ${prevMsg}` : '[DEPRECATED]';

    const updatedRecord = db.updateResult(id, {
      status:      STATUS.FAILED,
      tagUrl:      record.tagUrl || '',
      errorMessage: deprecatedMsg,
    });

    audit('TAG', 'deprecate', req, id);

    res.json({ success: true, data: updatedRecord, message: 'TAG 已废弃' });
  } catch (err) {
    console.error('[TAG] 废弃记录失败：', err.message);
    res.status(500).json({ success: false, message: '废弃 TAG 记录失败' });
  }
});

/**
 * DELETE /tag/delete/:id
 * 删除一条 TAG 记录
 */
router.delete('/delete/:id', (req, res) => {
  try {
    // R02：删除仅限 admin
    if (!requireAdmin(req, res)) return;

    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) {
      return res.status(400).json({ success: false, message: '无效的记录 ID' });
    }

    const deleted = db.deleteById(id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'TAG 记录不存在' });
    }

    audit('TAG', 'delete', req, id);

    res.json({ success: true, message: '删除成功' });
  } catch (err) {
    console.error('[TAG] 删除记录失败：', err.message);
    res.status(500).json({ success: false, message: '删除 TAG 记录失败' });
  }
});

  return router;
}

module.exports = { createTagRouter };
