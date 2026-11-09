import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** 把 unified diff 按文件切开。 */
export function splitPatch(patch) {
    const text = String(patch || '').replace(/\r\n/g, '\n');
    const parts = text.split(/^diff --git /m).slice(1);
    return parts.map((part) => {
        const header = part.split('\n')[0] || '';
        const path = header.match(/ b\/(.+)$/)?.[1] || '';
        return { path: path.trim(), diff: `diff --git ${part}`.trimEnd() };
    }).filter((item) => item.path && !item.path.includes('..'));
}

/**
 * 补丁里的删除行和上下文行，按原顺序能在目标文件里找到，才认为这份补丁对得上。
 * 纯新增补丁没有可对齐的旧行，返回 false，避免空补丁被当成能套用。
 */
export function patchContextApplies(fileText, fileDiff) {
    const source = String(fileText || '').replace(/\r\n/g, '\n');
    const rows = String(fileDiff || '').replace(/\r\n/g, '\n').split('\n');
    const oldLines = [];
    for (const row of rows) {
        if (row.startsWith('diff ') || row.startsWith('index ') || row.startsWith('---')
            || row.startsWith('+++') || row.startsWith('@@') || row.startsWith('\\')) continue;
        if (row.startsWith('+')) continue;
        if (row.startsWith('-') || row.startsWith(' ')) oldLines.push(row.slice(1));
    }
    if (!oldLines.length) return false;
    return source.includes(oldLines.join('\n'));
}

export function parseSyncVerdict(text) {
    const raw = String(text || '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const obj = JSON.parse(raw.slice(start, end + 1));
        const reason = String(obj.reason || '').replace(/\s+/g, ' ').trim().slice(0, 400);
        return { canSync: obj.canSync === true, reason };
    } catch {
        return null;
    }
}

/** AI 说能同步，并且补丁原文对得上，才允许自动推送。 */
export function decideSync({ ai, applies, fileMissing }) {
    if (fileMissing) return { canSync: false, reason: '读不到兄弟分支上的对应文件，没有推送。' };
    if (!ai) return { canSync: false, reason: 'AI 没有给出判断，没有推送。' };
    if (!ai.canSync) return { canSync: false, reason: ai.reason || 'AI 判断这份修改不能同步到该分支。' };
    if (!applies) {
        const note = ai.reason ? `${ai.reason} ` : '';
        return { canSync: false, reason: `${note}但这份补丁的原文对不上该分支，没有自动推送。`.trim() };
    }
    return { canSync: true, reason: ai.reason || '补丁能对上该分支。' };
}

export function loadModelEndpoint() {
    try {
        const cfg = JSON.parse(readFileSync(join(homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'));
        const providers = cfg?.provider && typeof cfg.provider === 'object' ? Object.values(cfg.provider) : [];
        const provider = providers.find((item) => item?.options?.baseURL && item?.options?.apiKey);
        if (!provider) return null;
        const models = provider.models && typeof provider.models === 'object' ? Object.keys(provider.models) : [];
        const model = models.includes('deepseek-v4-flash') ? 'deepseek-v4-flash' : models[0];
        if (!model) return null;
        return {
            baseURL: String(provider.options.baseURL).replace(/\/$/, ''),
            apiKey: String(provider.options.apiKey),
            model,
        };
    } catch {
        return null;
    }
}

export async function askSyncModel({ endpoint, patch, sibling, fileExcerpt }) {
    const response = await fetch(`${endpoint.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${endpoint.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: endpoint.model,
            temperature: 0,
            messages: [
                {
                    role: 'system',
                    content: '你只判断一份代码补丁能不能原样套到另一个版本分支。只输出 JSON：{"canSync":true或false,"reason":"一句中文"}。canSync 为 true 的条件是：同一处逻辑在目标文件里还在，补丁里的旧行能对上，改动意图没有被目标分支的不同实现挡住。对不上、文件职责变了、或你无法确定时 canSync 必须是 false，并在 reason 里写明原因。',
                },
                {
                    role: 'user',
                    content: [
                        `目标 PR #${sibling.number}，分支 ${sibling.headRef || '-'}，基线 ${sibling.baseRef || '-'}。`,
                        '待同步补丁：',
                        String(patch || '').slice(0, 12000),
                        '目标分支上的对应文件：',
                        String(fileExcerpt || '').slice(0, 12000),
                    ].join('\n'),
                },
            ],
        }),
        signal: AbortSignal.timeout(60000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
        throw new Error(String(message).slice(0, 200));
    }
    return parseSyncVerdict(payload?.choices?.[0]?.message?.content || '');
}
