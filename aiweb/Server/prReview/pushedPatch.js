import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
const execute = promisify(execFile);
const cache = new Map();

/** Reconstruct all pushes in this run; fix.patch can contain only its last repair. */
export async function readPushedPatch({ runId, workingDirectory, baseline, commitSha, pushSucceeded }) {
    if (!pushSucceeded || !workingDirectory || basename(workingDirectory) !== runId
        || ![baseline, commitSha].every(sha => /^[a-f0-9]{40}$/i.test(sha || ''))) return '';
    const key = `${workingDirectory}:${baseline}:${commitSha}`;
    if (cache.has(key)) return cache.get(key);
    const git = async args => (await execute('git', ['-C', join(workingDirectory, 'repo'), ...args], {
        timeout: 3000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })).stdout;
    try {
        if ((await git(['rev-parse', 'HEAD'])).trim() !== commitSha) return '';
        await git(['merge-base', '--is-ancestor', baseline, commitSha]);
        const patch = await git(['diff', '--binary', baseline, commitSha, '--']);
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(key, patch);
        return patch;
    } catch { return ''; }
}
