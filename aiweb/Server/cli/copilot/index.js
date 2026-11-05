import { CopilotClient, approveAll } from '@github/copilot-sdk';
import { randomUUID } from 'node:crypto';

/**
 * Copilot CLI 适配器
 *
 * 通过 @github/copilot-sdk 与 GitHub Copilot 交互，接口与 OpenCodeCLI 对标。
 * 内部维护一个 CopilotClient 单例，懒加载连接，按需创建 / 管理 Session。
 *
 * 配置选项：
 *   options.gitHubToken    - GitHub PAT（不传则使用已登录用户凭据）
 *   options.cliPath        - 覆盖 Copilot CLI 可执行路径
 *   options.cliUrl         - 连接到已有的外部 Copilot 服务（host:port）
 *   options.sendTimeout    - sendMessage 超时毫秒数（默认 120000）
 */
class CopilotCLI {
    /**
     * @param {object} options
     * @param {string} [options.gitHubToken]  - GitHub PAT
     * @param {string} [options.cliPath]      - Copilot CLI 可执行路径
     * @param {string} [options.cliUrl]       - 连接已有外部服务（host:port）
     * @param {number} [options.sendTimeout]  - 每条消息发送超时（ms）
     */
    constructor(options = {}) {
        const clientOpts = {};
        if (options.cliUrl) {
            clientOpts.cliUrl = options.cliUrl;
        } else {
            if (options.cliPath) clientOpts.cliPath = options.cliPath;
            if (options.gitHubToken) {
                clientOpts.gitHubToken = options.gitHubToken;
            } else {
                clientOpts.useLoggedInUser = true;
            }
        }
        this._clientOpts = clientOpts;
        this._client = null;

        this.sendTimeout = options.sendTimeout || 1200000; // 默认 20 分钟

        /**
         * 内存 Session 记录：sessionId → SessionRecord
         * @type {Map<string, SessionRecord>}
         */
        this.sessions = new Map();
    }

    // ─── 内部：懒加载 Client ───────────────────────────────────────────────────

    async _getClient() {
        if (!this._client) {
            this._client = new CopilotClient(this._clientOpts);
        }
        if (this._client.state !== 'connected') {
            await this._client.start();
        }
        return this._client;
    }

    // ─── 运行状态检查 ──────────────────────────────────────────────────────────

    /**
     * 检查 Copilot SDK 是否可用（尝试启动客户端连接）
     */
    async checkHealth() {
        this._log('info', 'checkHealth: 检测 Copilot SDK 连接');
        try {
            const client = await this._getClient();
            this._log('info', `checkHealth: 连接正常，state=${client.state}`);
            return { status: 'ok', message: 'Copilot SDK is connected', target: 'copilot-cli' };
        } catch (error) {
            this._log('warn', `checkHealth: 连接失败 — ${error.message}`);
            return {
                status: 'error',
                message: `Copilot SDK health check failed: ${error.message}`,
                error: error.message
            };
        }
    }

    // ─── Session 管理 ──────────────────────────────────────────────────────────

    /**
     * 获取所有 Session（融合持久化列表与内存状态）
     */
    async listSessions() {
        this._log('info', 'listSessions 开始');
        try {
            const client = await this._getClient();
            const persistedList = await client.listSessions();

            // 以持久化列表为主，补充内存中的状态
            const result = persistedList.map(meta => {
                const record = this.sessions.get(meta.sessionId);
                return {
                    id: meta.sessionId,
                    title: record?.title ?? meta.summary ?? meta.sessionId,
                    messages: record?.messages ?? [],
                    status: record?.status ?? 'unknown',
                    createdAt: record?.createdAt ?? meta.startTime?.toISOString() ?? null
                };
            });

            // 补充仅在内存中（尚未持久化）的 Session
            for (const [id, record] of this.sessions) {
                if (!result.find(r => r.id === id)) {
                    result.push({
                        id: record.id,
                        title: record.title,
                        messages: record.messages,
                        status: record.status,
                        createdAt: record.createdAt
                    });
                }
            }

            this._log('info', `listSessions 完成，共 ${result.length} 个 Session`);
            return result;
        } catch (error) {
            this._log('error', `listSessions 失败: ${error.message}`);
            throw new Error(`Failed to list sessions: ${error.message}`);
        }
    }

    /**
     * 获取指定 Session
     * @param {string} sessionId
     */
    async getSession(sessionId) {
        this._log('info', `getSession id=${sessionId}`);
        const record = this.sessions.get(sessionId);
        if (!record) {
            throw new Error(`Session not found: ${sessionId}`);
        }
        return {
            id: record.id,
            title: record.title,
            messages: record.messages,
            status: record.status,
            createdAt: record.createdAt
        };
    }

    /**
     * 删除 Session（先断开，再从持久化存储和内存中移除）
     * @param {string} sessionId
     */
    async deleteSession(sessionId) {
        this._log('info', `deleteSession id=${sessionId}`);
        if (!this.sessions.has(sessionId)) {
            throw new Error(`Session not found: ${sessionId}`);
        }
        try {
            const client = await this._getClient();
            await client.deleteSession(sessionId);
        } catch (error) {
            this._log('warn', `deleteSession: SDK 删除失败（已忽略）: ${error.message}`);
        }
        this.sessions.delete(sessionId);
        this._log('info', `deleteSession 成功 id=${sessionId}`);
        return { sessionId, deleted: true };
    }

    /**
     * 终止 Session（中断正在运行的任务，Session 仍可继续使用）
     * @param {string} sessionId
     */
    async abortSession(sessionId) {
        this._log('info', `abortSession id=${sessionId}`);
        const record = this.sessions.get(sessionId);
        if (!record) {
            return { sessionId, aborted: true };
        }
        try {
            if (record.session) {
                await record.session.abort();
            }
        } catch (error) {
            this._log('warn', `abortSession: 中止信号失败（已忽略）: ${error.message}`);
        }
        record.status = 'aborted';
        this._log('info', `abortSession 成功 id=${sessionId}`);
        return { sessionId, aborted: true };
    }

    /**
     * 向指定 Session 发送消息并等待回复
     * @param {string} sessionId
     * @param {string} message
     */
    async sendMessage(sessionId, message) {
        this._log('info', `sendMessage id=${sessionId}`);
        this._log('info', `  message (前100字): ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`);

        const record = this.sessions.get(sessionId);
        if (!record) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        record.messages.push({
            role: 'user',
            content: message,
            timestamp: new Date().toISOString()
        });
        record.status = 'running';

        try {
            const event = await record.session.sendAndWait(
                { prompt: message },
                this.sendTimeout
            );

            const content = event?.data?.content ?? '';
            record.messages.push({
                role: 'assistant',
                content,
                timestamp: new Date().toISOString()
            });
            record.status = 'completed';

            this._log('info', `sendMessage 完成 id=${sessionId}`);
            return { success: true, response: content };
        } catch (error) {
            record.status = 'error';
            this._log('error', `sendMessage 失败 id=${sessionId}: ${error.message}`);
            throw new Error(`Failed to send message: ${error.message}`);
        }
    }

    /**
     * 创建新 Session，可选附带初始提示词
     *
     * 与 OpenCodeCLI 保持一致：若传入 prompt，则以 fire-and-forget 方式在后台异步执行，
     * 立即返回 sessionId，供上层 PollingScheduler 轮询 checkSessionStatus 判断完成。
     *
     * @param {string} title    - Session 标题
     * @param {string} [prompt] - 初始提示词（可选）
     */
    async startSession(title, prompt) {
        this._log('info', `startSession title="${title}"`);
        this._log('info', `  prompt 长度: ${prompt ? prompt.length : 0} 字符`);

        try {
            const client = await this._getClient();
            const sessionId = randomUUID();

            const session = await client.createSession({
                sessionId,
                onPermissionRequest: approveAll
            });

            /** @type {SessionRecord} */
            const record = {
                id: sessionId,
                title,
                messages: [],
                status: 'idle',
                createdAt: new Date().toISOString(),
                session
            };
            this.sessions.set(sessionId, record);
            this._log('info', `Session 已创建 id=${sessionId}`);

            if (prompt) {
                // Fire-and-forget：后台异步执行，不阻塞调用方
                // record.status 由 sendMessage 内部同步更新（running → completed / error）
                // PollingScheduler 通过 checkSessionStatus 轮询内存状态即可正常工作
                this.sendMessage(sessionId, prompt).catch(error => {
                    this._log('error', `startSession 后台执行失败 id=${sessionId}: ${error.message}`);
                    const r = this.sessions.get(sessionId);
                    if (r) r.status = 'error';
                });
                return { sessionId, action: 'create', message: '已创建新 Session 并开始执行' };
            }

            return { sessionId, action: 'create', message: '已创建新 Session' };
        } catch (error) {
            this._log('error', `startSession 失败: ${error.message}`);
            throw new Error(`Failed to start session: ${error.message}`);
        }
    }

    /**
     * 查询 Session 当前状态
     * @param {string} sessionId
     * @returns {{ status: string, lastMessage?: object }}
     */
    async checkSessionStatus(sessionId) {
        this._log('info', `checkSessionStatus id=${sessionId}`);
        const record = this.sessions.get(sessionId);
        if (!record) {
            return { status: 'unknown' };
        }
        const lastMessage = record.messages.length > 0
            ? record.messages[record.messages.length - 1]
            : null;
        this._log('info', `checkSessionStatus: status=${record.status}`);
        return { status: record.status, lastMessage };
    }

    /**
     * 获取 Session 消息历史
     * @param {string} sessionId
     */
    async getSessionMessages(sessionId) {
        this._log('info', `getSessionMessages id=${sessionId}`);
        const record = this.sessions.get(sessionId);
        if (!record) {
            throw new Error(`Session not found: ${sessionId}`);
        }
        return record.messages;
    }

    // ─── 内部方法 ──────────────────────────────────────────────────────────────

    _log(level, msg) {
        const prefix = '[CopilotCLI]';
        if (level === 'error') console.error(`❌ ${prefix} ${msg}`);
        else if (level === 'warn') console.warn(`⚠️  ${prefix} ${msg}`);
        else console.log(`ℹ️  ${prefix} ${msg}`);
    }
}

/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {string} title
 * @property {Array<{role: string, content: string, timestamp: string}>} messages
 * @property {'idle'|'running'|'completed'|'error'|'aborted'} status
 * @property {string} createdAt
 * @property {import('@github/copilot-sdk').CopilotSession} session
 */

export default CopilotCLI;
