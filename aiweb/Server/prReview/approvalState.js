import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

const field = (text, name, indent = '') => new RegExp(`^${indent}${name}:[ \\t]*([^\\n]*)`, 'm').exec(text)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';

/** Bind wait classification to the pending question, never an old success message. */
export function classifyParkApproval(runId) {
    if (!/^run-[A-Za-z0-9_-]+$/.test(runId)) return '';
    try {
        const dir = join(homedir(), '.aceharness/runs', runId);
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
        if (gate?.phase === 'review_pending_decision' || (suggestion?.mode === 'suggestion' && suggestion.head_sha
            && (!gate?.head_sha || suggestion.head_sha === gate.head_sha))) return 'decision';
        if (/waiting_for(?:\\?["'])?\s*[:=：]\s*(?:\\?["'])?user_decision/.test(question)) return 'decision';
        return 'webhook';
    } catch { return ''; }
}
