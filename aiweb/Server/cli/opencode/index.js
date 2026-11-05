import { createOpencodeClient } from '@opencode-ai/sdk';

/**
 * OpenCode CLI 适配器
 * 通过 @opencode-ai/sdk 与运行中的 opencode 服务通信，提供统一的 Session 管理接口。
 *
 * 依赖环境变量（可由 options 覆盖）：
 *   OPENCODE_HOST  - opencode 服务主机（默认 localhost）
 *   OPENCODE_PORT  - opencode 服务端口（默认 4096）
 */
class OpenCodeCLI {
    /**
     * @param {object} options
     * @param {string} [options.host]    - opencode 服务主机
     * @param {string} [options.port]    - opencode 服务端口
     * @param {string} [options.baseUrl] - 完整 baseUrl，优先级高于 host/port
     */
    constructor(options = {}) {
        this.host = options.host || process.env.OPENCODE_HOST || 'localhost';
        this.port = options.port || process.env.OPENCODE_PORT || '4096';
        this.baseUrl = options.baseUrl || `http://${this.host}:${this.port}`;
        this.client = null;
        this._init();
    }

    // ─── 初始化 ────────────────────────────────────────────────────────────────

    _init() {
        try {
            this.client = createOpencodeClient({ baseUrl: this.baseUrl });
            this._log('info', `已连接至 ${this.baseUrl}`);
        } catch (error) {
            this._log('error', `初始化失败: ${error.message}`);
            throw error;
        }
    }

    // ─── 运行状态检查 ──────────────────────────────────────────────────────────

    async checkHealth() {
        this._log('info', `checkHealth → ${this.baseUrl}`);
        try {
            // 轻量健康检查：只调用 session.list() 验证连通性
            // 不再为每个 session 拉取全量消息（原 listSessions 会拉所有 session 的所有消息）
            await this.client.session.list();
            this._log('info', 'checkHealth: 连通正常');
            return { status: 'ok', message: 'OpenCode CLI is healthy', target: this.baseUrl };
        } catch (error) {
            this._log('warn', `checkHealth: 连接失败 — ${error.message}`);
            return {
                status: 'error',
                message: `Health check failed: ${error.message}`,
                error: error.message
            };
        }
    }

    // ─── Session 管理 ──────────────────────────────────────────────────────────

    /**
     * 获取所有 Session（附带状态）
     *
     * 优化：不再为每个 session 拉取全量消息来判断状态。
     * 仅返回 session 元信息，状态通过 checkSessionStatus 按需查询。
     * 原实现对 N 个 session 发起 N 个并发 HTTP 请求拉全量消息，
     * session 数量多时会压垮 OpenCode 服务。
     */
    async listSessions() {
        this._log('info', 'listSessions 开始');
        try {
            const sessions = await this.client.session.list();
            // 只返回 session 元信息，不拉取消息
            const result = sessions.data.map(s => ({ ...s, status: 'unknown' }));
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
        try {
            const session = await this.client.session.get({ path: { id: sessionId } });
            const result = await this._getSessionWithStatus(session.data);
            this._log('info', `getSession 完成，status=${result.status}`);
            return result;
        } catch (error) {
            this._log('error', `getSession 失败 id=${sessionId}: ${error.message}`);
            throw new Error(`Failed to get session: ${error.message}`);
        }
    }

    /**
     * 删除 Session
     * @param {string} sessionId
     */
    async deleteSession(sessionId) {
        this._log('info', `deleteSession id=${sessionId}`);
        try {
            const result = await this.client.session.delete({ path: { id: sessionId } });
            this._log('info', `deleteSession 成功 id=${sessionId}`);
            return result.data;
        } catch (error) {
            this._log('error', `deleteSession 失败 id=${sessionId}: ${error.message}`);
            throw new Error(`Failed to delete session: ${error.message}`);
        }
    }

    /**
     * 终止 Session（中断正在运行的任务）
     * @param {string} sessionId
     */
    async abortSession(sessionId) {
        this._log('info', `abortSession id=${sessionId}`);
        try {
            const result = await this.client.session.abort({ path: { id: sessionId } });
            this._log('info', `abortSession 成功 id=${sessionId}`);
            return result.data;
        } catch (error) {
            this._log('error', `abortSession 失败 id=${sessionId}: ${error.message}`);
            throw new Error(`Failed to abort session: ${error.message}`);
        }
    }

    /**
     * 向指定 Session 发送消息
     * @param {string} sessionId
     * @param {string} message
     */
    async sendMessage(sessionId, message) {
        this._log('info', `sendMessage id=${sessionId}`);
        this._log('info', `  message (前100字): ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`);
        try {
            await this.client.session.promptAsync({
                path: { id: sessionId },
                body: {
                    parts: [{ type: 'text', text: message }],
                    noReply: false
                },
                url: `/session/${sessionId}/prompt_async`
            });
            this._log('info', `sendMessage 成功 id=${sessionId}`);
            return { success: true };
        } catch (error) {
            this._log('error', `sendMessage 失败 id=${sessionId}: ${error.message}`);
            throw new Error(`Failed to send message: ${error.message}`);
        }
    }

    /**
     * 创建新 Session，可选附带初始提示词
     * @param {string} title  - Session 标题
     * @param {string} [prompt] - 初始提示词（可选）
     */
    async startSession(title, prompt) {
        this._log('info', `startSession title="${title}"`);
        this._log('info', `  prompt 长度: ${prompt ? prompt.length : 0} 字符`);
        try {
            const session = await this.client.session.create({ body: { title } });
            const sessionId = session.data.id;
            this._log('info', `Session 已创建 id=${sessionId}`);

            if (prompt) {
                await this.client.session.promptAsync({
                    path: { id: sessionId },
                    body: {
                        parts: [{ type: 'text', text: prompt }],
                        noReply: false
                    },
                    url: `/session/${sessionId}/prompt_async`
                });
                this._log('info', `初始 prompt 已发送 id=${sessionId}`);
            }

            return {
                sessionId,
                action: 'create',
                message: prompt ? '已创建新 Session 并开始执行' : '已创建新 Session'
            };
        } catch (error) {
            this._log('error', `startSession 失败: ${error.message}`);
            throw new Error(`Failed to start session: ${error.message}`);
        }
    }

    /**
     * 查询 Session 当前状态
     * @param {string} sessionId
     * @returns {{ status: 'completed'|'running'|'unknown', lastMessage?: object }}
     */
    async checkSessionStatus(sessionId) {
        this._log('debug', `checkSessionStatus id= ${sessionId}`);
        try {
            // 优化：只拉取最后一条消息而非全量消息列表
            // PollingScheduler 每 2-12 秒调用一次，原实现拉取全量消息（随对话增长可达 MB 级）
            // 改用 limit 参数只取最后 1 条，减少 90%+ 网络开销
            const messages = await this.client.session.messages({
                path: { id: sessionId },
                query: { limit: 1 },
            });
            const data = messages.data;

            if (!data || data.length === 0) {
                return { status: 'unknown' };
            }

            const lastMessage = data[data.length - 1];

            // 出错 / 被中断
            if (lastMessage.info?.error) {
                const errName = lastMessage.info.error.name ?? 'UnknownError';
                this._log('warn', `checkSessionStatus: 检测到错误 ${errName}，status=error`);
                return { status: 'error', error: lastMessage.info.error, lastMessage };
            }

            // 正常完成
            const isCompleted =
                lastMessage.info?.finish === 'stop' &&
                Array.isArray(lastMessage.parts) &&
                lastMessage.parts.some(p => p.type === 'text');

            const status = isCompleted ? 'completed' : 'running';
            return { status, lastMessage };
        } catch (error) {
            this._log('warn', `checkSessionStatus 异常 id=${sessionId}: ${error.message}`);
            return { status: 'unknown' };
        }
    }

    /**
     * 获取 Session 消息历史
     * @param {string} sessionId
     */
    async getSessionMessages(sessionId) {
        this._log('info', `getSessionMessages id=${sessionId}`);
        try {
            const messages = await this.client.session.messages({ path: { id: sessionId } });
            return messages.data;
        } catch (error) {
            this._log('error', `getSessionMessages 失败 id=${sessionId}: ${error.message}`);
            throw new Error(`Failed to get session messages: ${error.message}`);
        }
    }

    // ─── 内部方法 ──────────────────────────────────────────────────────────────

    /**
     * 获取 Session 及其完成状态
     */
    async _getSessionWithStatus(session) {
        try {
            const messages = await this.client.session.messages({ path: { id: session.id } });

            if (!messages.data || messages.data.length === 0) {
                return { ...session, status: 'unknown' };
            }

            const lastMessage = messages.data[messages.data.length - 1];

            if (
                lastMessage.info &&
                lastMessage.info.role === 'assistant' &&
                lastMessage.info.finish === 'stop' &&
                lastMessage.parts &&
                Array.isArray(lastMessage.parts) &&
                lastMessage.parts.some(p => p.type === 'text')
            ) {
                return { ...session, status: 'completed' };
            }

            return { ...session, status: 'running' };
        } catch {
            return { ...session, status: 'unknown' };
        }
    }

    _log(level, msg) {
        const prefix = '[OpenCodeCLI]';
        if (level === 'error') console.error(`❌ ${prefix} ${msg}`);
        else if (level === 'warn') console.warn(`⚠️  ${prefix} ${msg}`);
        else console.log(`ℹ️  ${prefix} ${msg}`);
    }
}

export default OpenCodeCLI;
