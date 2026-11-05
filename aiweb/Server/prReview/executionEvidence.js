import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

/** Read only this execution's files. Prefer the freshest copy in its isolated workspace. */
export function readExecutionEvidence(runId, workingDirectory = '') {
    if (!/^run-[A-Za-z0-9_-]+$/.test(String(runId || ''))) return {};
    const dir = join(homedir(), '.aceharness', 'runs', runId);
    if (!workingDirectory) {
        try { workingDirectory = /^workingDirectory:\s*["']?([^\n"']+)/m.exec(readFileSync(join(dir, 'state.yaml'), 'utf8'))?.[1]?.trim() || ''; } catch {}
    }
    const roots = [join(dir, 'outputs')];
    if (workingDirectory && basename(workingDirectory) === runId) roots.unshift(join(workingDirectory, 'outputs'));
    const read = name => roots.map(root => {
        try { const path = join(root, name); return { value: JSON.parse(readFileSync(path, 'utf8')), at: statSync(path).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a,b) => b.at-a.at)[0];
    const pushFile = read('push-result.json');
    const push = pushFile?.value || {};
    const gate = read('gate-check.json')?.value || {};
    const comment = read('pr-comment.json')?.value || {};
    const audit = read('pr-push-audit.json')?.value || {};
    let summary = {};
    try { summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')); } catch {}
    const start = read('start-result.json')?.value;
    if (!summary.status && start?.run_id === runId && start.status === 'failed') summary.status = 'failed';
    const commitSha = String(push.commit_sha || '');
    const remoteHeadSha = String(push.remote_head_sha || '');
    const pushSucceeded = push.push_status === 'success' && !!commitSha && remoteHeadSha === commitSha;
    const pushFailed = /fail|error|denied|403/i.test(String(push.push_status || ''));
    const pushAt = Date.parse(push.pushed_at || push.checked_at || '') || 0;
    const gateAt = Date.parse(gate.checked_at || '') || 0;
    const auditedBuild = audit.push_verified === true && audit.commit_sha === commitSha
        && audit.remote_head_sha === remoteHeadSha && audit.build_comment_id
        && String(audit.build_comment_id) === String(comment.comment_id)
        && Date.parse(audit.checked_at || '') >= Date.parse(comment.posted_at || '');
    const buildCredential = pushSucceeded && comment.ok === true && comment.endpoint === 'pulls'
        && comment.body?.trim() === 'start build' && comment.comment_id
        && (auditedBuild || (pushAt && Date.parse(comment.posted_at || '') >= pushAt)) ? String(comment.comment_id) : null;
    const verificationBoundary = buildCredential ? Date.parse(comment.posted_at) : pushAt;
    const gatesPassed = gate.phase === 'green' || (gate.phase === 'tester_approved'
        && ['dco', 'static', 'compile', 'test'].every(k => gate[`${k}_ok`] === true && !gate[`${k}_fail`]));
    return { evidenceRunId: runId, runStatus: summary.status || '', commitSha, remoteHeadSha,
        pushStatus: push.push_status || '', pushSucceeded, pushFailed, buildCredential,
        ciObserved: !!gate.head_sha && gateAt > 0 && !gate.read_failed,
        ciSha: gate.head_sha || '', ciPassed: pushSucceeded && gatesPassed
            && !gate.read_failed && gate.head_sha === commitSha && gateAt > 0 && gateAt >= verificationBoundary,
        error: push.error || (summary.status === 'failed' ? start?.error : null) || null,
        credentialFingerprint: push.credential_fingerprint || null,
        pushCheckedAt: pushAt ? new Date(pushAt).toISOString() : null,
        gateCheckedAt: gate.checked_at || null, gateReadFailed: !!gate.read_failed,
        gateError: gate.read_failed ? gate.summary || '门禁读取失败' : null };
}
