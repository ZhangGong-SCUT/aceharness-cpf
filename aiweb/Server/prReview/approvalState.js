import { aceDataDir, aceRunsDir, aceRuntimeRoot } from '../library/aceRuntime.js';
import { readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

const field = (text, name, indent = '') => new RegExp(`^${indent}${name}:[ \\t]*([^\\n]*)`, 'm').exec(text)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';

const DECISION_ASK = '检视建议已经生成，还没有推送。请在这张卡片里选择应用、驳回，或按你的想法改。';

function outputRoots(raw, runDir) {
    const work = field(raw, 'workingDirectory');
    const runId = basename(runDir);
    return [work && basename(work) === runId ? join(work, 'outputs') : '', join(runDir, 'outputs')].filter(Boolean);
}

function readJsonFile(file) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function readNamedJson(roots, name) {
    for (const root of roots) {
        const data = readJsonFile(join(root, name));
        if (data) return data;
    }
    return null;
}

/** 挂起步骤写的 waiting_for。门禁文件可能仍是更早的 need_start_build，不能单靠它判断。 */
function readParkWaitingFor(roots) {
    for (const root of roots) {
        const text = (() => { try { return readFileSync(join(root, '挂起-记录挂起.md'), 'utf8'); } catch { return ''; } })();
        const fenced = /```json\s*([\s\S]*?)```/.exec(text)?.[1] || text;
        try {
            const waiting = JSON.parse(fenced)?.waiting_for;
            if (waiting) return String(waiting);
        } catch { /* 继续找步骤结果 */ }
        try {
            const names = readdirSync(join(root, 'step-logs'))
                .filter(name => name.startsWith('挂起-记录挂起-') && name.endsWith('.result.json'))
                .sort();
            const latest = names[names.length - 1];
            const waiting = latest && readJsonFile(join(root, 'step-logs', latest))?.fields?.waiting_for;
            if (waiting) return String(waiting);
        } catch { /* 该目录没有挂起结果 */ }
    }
    return '';
}

/**
 * 检视建议等用户应用/驳回/修改。
 * 旧的 gate-check.json 经常还写着 need_start_build，不能据此当成等 CI。
 */
export function isReviewDecision({ phase, suggestion, gateHeadSha, waitingFor } = {}) {
    if (String(waitingFor || '') === 'user_decision') return true;
    if (phase === 'review_pending_decision') return true;
    return suggestion?.mode === 'suggestion' && !!suggestion.head_sha
        && (!gateHeadSha || suggestion.head_sha === gateHeadSha);
}

/** Bind wait classification to the pending question, never an old success message. */
export function classifyParkApproval(runId) {
    if (!/^run-[A-Za-z0-9_-]+$/.test(runId)) return '';
    try {
        const dir = join(aceRunsDir(), runId);
        const raw = readFileSync(join(dir, 'state.yaml'), 'utf8');
        if (field(raw, 'currentState') !== '__human_approval__') return '';
        const pending = field(raw, 'pendingHumanQuestionId');
        const questions = /^humanQuestions:[^\n]*\n([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(raw)?.[1] || '';
        const question = questions.split(/^  - id:\s*/m).slice(1).find(part => part.split('\n')[0].trim() === pending);
        if (!question || field(question, 'status', '    ') !== 'unanswered'
            || field(question, 'previousState', '    ') !== '挂起') return '';
        const work = field(raw, 'workingDirectory');
        const roots = [work && basename(work) === runId ? join(work, 'outputs') : '', join(dir, 'outputs')].filter(Boolean);
        const read = name => {
            for (const root of roots) { try { return JSON.parse(readFileSync(join(root, name), 'utf8')); } catch {} }
            return null;
        };
        const suggestion = read('review-suggestion.json'), gate = read('gate-check.json');
        const waitingFor = readParkWaitingFor(roots);
        if (isReviewDecision({
            phase: gate?.phase,
            suggestion,
            gateHeadSha: gate?.head_sha,
            waitingFor: waitingFor || (/waiting_for(?:\\?["'])?\s*[:=：]\s*(?:\\?["'])?user_decision/.test(question) ? 'user_decision' : ''),
        })) return 'decision';
        return 'webhook';
    } catch { return ''; }
}

/**
 * 把待确认问题写成使用者能直接看懂的一句话。
 * kind=suspended 是挂起等 CI，不要求点确认；kind=human 才是真要人做决定。
 */
export function composeApprovalAsk({ suggestedNextState, previousState, message, gate, suggestion, waitingFor } = {}) {
    const next = String(suggestedNextState || '').trim();
    const previous = String(previousState || '').trim();
    const phase = String(gate?.phase || '');
    const summary = String(gate?.summary || '').replace(/\s+/g, ' ').trim();
    if (isReviewDecision({ phase, suggestion, gateHeadSha: gate?.head_sha, waitingFor })) {
        return {
            kind: 'human',
            ask: DECISION_ASK,
            reason: DECISION_ASK,
            suggestedNextState: '',
            previousState: previous,
            phase: phase || 'review_pending_decision',
        };
    }
    const waitingCi = previous === '挂起' && phase !== 'blocked_no_issue' && phase !== 'blocked_rate_limit'
        && phase !== 'review_pending_decision';
    if (waitingCi) {
        return {
            kind: 'suspended',
            ask: summary ? `正在等 CI，不用点确认。${summary}` : '正在等 CI 门禁结果，出结果后会自动继续，不用点确认。',
            reason: summary,
            suggestedNextState: next,
            previousState: previous,
            phase,
        };
    }
    let reason = summary;
    if (phase === 'blocked_no_issue') {
        reason = '这个 PR 没有关联 Issue，CI 已拒绝 start build，不能继续等门禁。';
    } else if (phase === 'blocked_rate_limit') {
        reason = summary || '门禁触发被限流。';
    } else if (phase === 'review_pending_decision') {
        reason = '检视建议已经生成，还没有推送。请在这张卡片里选择应用、驳回，或按你的想法改。';
    } else if (!reason) {
        reason = String(message || '').replace(/\s+/g, ' ').trim();
    }
    const ask = next
        ? `需要你确认是否进入「${next}」。${reason}`
        : (reason || '需要你确认下一步。');
    return { kind: 'human', ask, reason, suggestedNextState: next, previousState: previous, phase };
}

/** 读当前未回答的人工确认，并附上门禁摘要。读不到返回 null。 */
export function readHumanApproval(runId) {
    if (!/^run-[A-Za-z0-9_-]+$/.test(String(runId || ''))) return null;
    try {
        const dir = join(aceRunsDir(), runId);
        const raw = readFileSync(join(dir, 'state.yaml'), 'utf8');
        const phaseNow = field(raw, 'currentPhase') || field(raw, 'currentState');
        if (phaseNow !== '__human_approval__') return null;
        const pending = field(raw, 'pendingHumanQuestionId');
        const questions = /^humanQuestions:[^\n]*\n([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(raw)?.[1] || '';
        const question = questions.split(/^  - id:\s*/m).slice(1).find(part => part.split('\n')[0].trim() === pending) || '';
        const roots = outputRoots(raw, dir);
        return composeApprovalAsk({
            suggestedNextState: field(question, 'suggestedNextState', '    '),
            previousState: field(question, 'previousState', '    '),
            message: field(question, 'message', '    '),
            gate: readNamedJson(roots, 'gate-check.json'),
            suggestion: readNamedJson(roots, 'review-suggestion.json'),
            waitingFor: readParkWaitingFor(roots),
        });
    } catch {
        return null;
    }
}
