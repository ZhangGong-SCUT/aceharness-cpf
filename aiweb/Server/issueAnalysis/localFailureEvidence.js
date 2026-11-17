import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { aceRunsDir } from '../library/aceRuntime.js';

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_EVENTS = 400;
const RELEVANT_EVENTS = new Set([
    'ohos.flutter.sdk', 'ohos.flutter.sdk.overlay',
    'ohos.flutter.sdk.overlay.revived', 'ohos.flutter.sdk.overlay.removed',
    'step.prompt', 'step.fail', 'run.fail',
]);

function text(value, limit = 12000) {
    return String(value == null ? '' : value)
        .replace(/\b(?:gh[ps]_|glpat-)[A-Za-z0-9_-]+/g, '[已隐藏凭证]').slice(0, limit);
}

function validRunId(runId) {
    return /^run-[A-Za-z0-9-]+$/.test(String(runId || ''));
}

function resolveRunFile(root, runId, relative = '') {
    if (!validRunId(runId) || (relative && (typeof relative !== 'string' || path.isAbsolute(relative)))) return null;
    const directory = path.resolve(root, runId);
    const resolved = path.resolve(directory, relative || '.');
    const relation = path.relative(directory, resolved);
    if (relation.startsWith('..') || path.isAbsolute(relation)) return null;
    return resolved;
}

async function readBounded(filePath, limit) {
    if (!filePath) return null;
    let handle;
    try {
        handle = await open(filePath, 'r');
        const { size } = await handle.stat();
        if (size > limit) return null;
        const buffer = Buffer.alloc(size);
        await handle.read(buffer, 0, size, 0);
        return buffer.toString('utf8');
    } catch {
        return null;
    } finally {
        await handle?.close();
    }
}

/** Select the same bounded diagnostic fields as the ACE route, never prompt/output bodies. */
export async function readLocalDiagnosticEvents(runId, root = aceRunsDir()) {
    const filePath = resolveRunFile(root, runId, 'diagnostics.jsonl');
    let handle;
    try {
        handle = await open(filePath, 'r');
        const { size } = await handle.stat();
        const start = Math.max(0, size - MAX_DIAGNOSTIC_BYTES);
        const buffer = Buffer.alloc(Math.min(size, MAX_DIAGNOSTIC_BYTES));
        await handle.read(buffer, 0, buffer.length, start);
        let content = buffer.toString('utf8');
        if (start > 0) content = content.slice(content.indexOf('\n') + 1);
        return content.split('\n').filter(Boolean).flatMap(line => {
            try {
                const event = JSON.parse(line);
                if (event.runId && event.runId !== runId || !RELEVANT_EVENTS.has(event.event)) return [];
                return [{
                    timestamp: event.timestamp, event: event.event, state: event.state, step: event.step,
                    matched: event.matched, pending: event.pending, branch: event.branch,
                    sdkId: event.sdkId, sdkRoot: event.sdkRoot, flutterBin: event.flutterBin,
                    reason: typeof event.reason === 'string' ? text(event.reason, 1000) : undefined,
                    error: typeof event.error === 'string' ? text(event.error, 2000) : undefined,
                }];
            } catch { return []; }
        }).slice(-MAX_EVENTS);
    } catch {
        return [];
    } finally {
        await handle?.close();
    }
}

async function readResultEvidence(root, runId, log) {
    if (log?.status !== 'completed' || !/^(?:问题复现|复现验证|完成|报告沉淀|修复验证)-/.test(String(log.stepName || ''))) return null;
    // Only these platform-written result records may enrich the compact run.
    if (!/^outputs\/step-logs\/[^/]+\.result\.json$/.test(String(log.resultRef || ''))) return null;
    const raw = await readBounded(resolveRunFile(root, runId, log.resultRef), MAX_RESULT_BYTES);
    if (!raw) return null;
    try {
        const result = JSON.parse(raw);
        if (result.runId !== runId || result.stepName !== log.stepName) return null;
        return text(JSON.stringify(result.fields || {}));
    } catch { return null; }
}

/** Last-resort local evidence for the same authenticated task when an older ACE cannot serve details. */
export async function readLocalIssueRunForTriage(runId, configFile, root = aceRunsDir()) {
    const statePath = resolveRunFile(root, runId, 'state.yaml');
    const raw = await readBounded(statePath, MAX_STATE_BYTES);
    if (!raw) return null;
    let state;
    try { state = parse(raw); } catch { return null; }
    if (state?.runId !== runId || (configFile && state.configFile !== configFile)) return null;
    const logs = Array.isArray(state.stepLogs) ? state.stepLogs : [];
    const stepLogs = await Promise.all(logs.map(async log => ({
        stepName: text(log.stepName, 300), status: text(log.status, 40),
        error: text(log.error, 12000), childSummary: text(log.childSummary, 4000),
        timestamp: log.timestamp || null, outputRef: text(log.outputRef, 1000),
        resultRef: text(log.resultRef, 1000),
        output: await readResultEvidence(root, runId, log),
    })));
    return {
        runId, configFile: state.configFile, mode: state.workflowMode,
        status: state.status, statusReason: text(state.statusReason, 12000),
        currentState: state.currentPhase || state.currentState,
        currentPhase: state.currentPhase || state.currentState,
        currentStep: text(state.currentStep, 300),
        activeSteps: Array.isArray(state.activeSteps) ? state.activeSteps.map(step => text(step, 300)) : [],
        completedSteps: Array.isArray(state.completedSteps) ? state.completedSteps.map(step => text(step, 300)) : [],
        diagnosisVerificationStatus: state.diagnosisVerificationStatus || null,
        startTime: state.startTime || null, endTime: state.endTime || null,
        stepLogs, diagnostics: await readLocalDiagnosticEvents(runId, root),
    };
}
