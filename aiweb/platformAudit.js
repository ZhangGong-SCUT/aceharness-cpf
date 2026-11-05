/**
 * 平台子系统操作审计（R02）
 *
 * TAG / PrCheck 作为团队共享工作台，删除、废弃、执行等敏感操作
 * 除要求 admin 角色外，还要落一条审计记录（JSONL，追加写，不做轮转）。
 *
 * 用法（CommonJS）：
 *   const { audit, requireAdmin } = require('../platformAudit');
 *   if (!requireAdmin(req, res)) return;          // 非 admin → 403
 *   audit('TAG', 'delete', req, id);              // 操作成功后记录
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AUDIT_FILE = process.env.AIWEB_AUDIT_FILE || path.resolve(__dirname, '..', 'db', 'platform-audit.log');

/**
 * 记录一条审计日志（失败只打 console，不影响主流程）
 * @param {string} system   - 子系统名，如 'TAG' / 'PrCheck'
 * @param {string} action   - 操作名，如 'delete' / 'deprecate' / 'execute'
 * @param {object} req      - express 请求（取 platformUser / ip）
 * @param {string|number} [recordId] - 被操作的记录 ID
 */
function audit(system, action, req, recordId) {
    try {
        const entry = {
            ts: new Date().toISOString(),
            system,
            action,
            recordId: recordId ?? null,
            username: req?.platformUser?.username ?? null,
            role: req?.platformUser?.role ?? null,
            ip: req?.ip ?? null,
        };
        fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
    } catch (err) {
        console.error('[audit] 审计日志写入失败：', err.message);
    }
}

/**
 * 敏感操作要求 admin 角色（共享工作台模式：普通用户可读写记录，
 * 但删除/废弃/执行仅限 admin）。未通过时直接回 403 并返回 false。
 * @param {object} req
 * @param {object} res
 * @returns {boolean} 是否放行
 */
function requireAdmin(req, res) {
    if (req?.platformUser?.role !== 'admin') {
        res.status(403).json({ success: false, message: '该操作仅限管理员' });
        return false;
    }
    return true;
}

module.exports = { audit, requireAdmin };
