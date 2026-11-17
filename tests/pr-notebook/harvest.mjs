/**
 * 从本机已经跑完的 PR run 抽出错题夹具。
 * 只读 ~/.aceharness/runs，只写 tests/fixtures/pr-notebook。
 * 不进监控、不发评论、不推代码。测试本身只读夹具，不读本机 run。
 *
 * 用法（在仓库根目录）：
 *   node tests/pr-notebook/harvest.mjs
 *   node tests/pr-notebook/harvest.mjs run-1794448498710-pr13-059acc07
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyOhosPrGates, commentBelongsToPull } from '../../skills/gitcode-pr-review/scripts/ohos-pr-gates.mjs';

const repoRoot = join(import.meta.dirname, '../..');
const outDir = join(repoRoot, 'tests/fixtures/pr-notebook');
const runsRoot = join(process.env.ACE_HOME || join(homedir(), '.aceharness'), 'runs');

const DEFAULT_RUNS = [
    'run-1793846060433-pr2279-9d63c33f',
    'run-1793863223937-pr2279-e5143644',
    'run-1793867217710-pr2111-cccc65b1',
    'run-1793887225495-pr2111-e9588a83',
    'run-1794448498710-pr13-059acc07',
    'run-1794464498863-pr13-61bba307',
];

const LOCKED_KEYS = [
    'phase',
    'verdict',
    'welcome',
    'start_build_posted',
    'dco_ok',
    'static_ok',
    'compile_ok',
    'test_fail',
    'build_passed',
    'failure_cause',
    'trigger_rejected',
];

function readJson(path) {
    return readFile(path, 'utf8').then((text) => JSON.parse(text));
}

function slimComment(item) {
    return {
        user: { login: String(item?.user?.login || item?.user?.username || '').trim() },
        body: String(item?.body || item?.note || '').trim(),
        created_at: String(item?.created_at || item?.updated_at || ''),
        comment_type: item?.comment_type || item?.noteable_type || '',
        target: item?.target && typeof item.target === 'object'
            ? {
                issue: item.target.issue ? { number: item.target.issue.number } : undefined,
                pull: Boolean(item.target.pull || item.target.pull_request || item.target.merge_request),
            }
            : undefined,
    };
}

function slimPull(pull) {
    return {
        title: String(pull?.title || ''),
        body: String(pull?.body || pull?.description || ''),
        state: String(pull?.state || ''),
        user: { login: String(pull?.user?.login || pull?.user?.username || '').trim() },
        labels: Array.isArray(pull?.labels)
            ? pull.labels.map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean)
            : [],
    };
}

function slimLog(log) {
    if (!log || typeof log !== 'object') return null;
    return {
        verdict: log.verdict || '',
        root_cause_verified: Boolean(log.root_cause_verified),
        evidence: Array.isArray(log.evidence) ? log.evidence.slice(0, 3) : [],
        reasons: Array.isArray(log.reasons) ? log.reasons.slice(0, 3) : [],
    };
}

async function harvestOne(runId) {
    const dir = join(runsRoot, runId, 'outputs');
    const source = await readJson(join(dir, 'gate-source.json'));
    const recorded = await readJson(join(dir, 'gate-check.json'));
    let identity = {};
    try { identity = await readJson(join(dir, 'pr-identity.json')); } catch { /* 旧 run 可能没有 */ }
    let log = null;
    try { log = slimLog(await readJson(join(dir, 'gate-log-analysis.json'))); } catch { /* 没核对日志 */ }

    const comments = [...(source.issueComments || []), ...(source.pullComments || [])]
        .filter(commentBelongsToPull)
        .map(slimComment)
        .filter((item) => item.body);
    const pull = slimPull(source.pull);
    const input = {
        labels: pull.labels,
        comments,
        pull,
        state: pull.state.toLowerCase(),
        own_pr: identity.own_pr !== false,
        dcp_defect_count: Number(recorded.dcp_defect_count || 0),
    };
    if (log) input.log_analysis = log;

    const got = classifyOhosPrGates(input);
    const expected = {};
    for (const key of LOCKED_KEYS) expected[key] = got[key];

    const owner = identity.owner || source.owner || '';
    const repo = identity.repo || source.repo || '';
    const number = identity.number || source.number || '';
    const note = recorded.phase === expected.phase
        ? `当时的门禁结论是 ${recorded.phase}。`
        : `分类器结论是 ${expected.phase}。这次 run 之后又被改成 ${recorded.phase}，错题本只锁分类器，不重放后面的人工指令。`;

    return {
        id: runId,
        pr: owner && repo && number ? `${owner}/${repo}#${number}` : runId,
        note,
        recorded: { phase: recorded.phase, verdict: recorded.verdict },
        input,
        expected,
    };
}

const wanted = process.argv.slice(2).filter((item) => item && !item.startsWith('-'));
const runIds = wanted.length ? wanted : DEFAULT_RUNS;
await mkdir(outDir, { recursive: true });
const keep = new Set();
for (const runId of runIds) {
    const card = await harvestOne(runId);
    const file = join(outDir, `${runId}.json`);
    await writeFile(file, `${JSON.stringify(card, null, 2)}\n`);
    keep.add(`${runId}.json`);
    console.log(`${card.pr}  recorded=${card.recorded.phase}  locked=${card.expected.phase}`);
}
if (!wanted.length) {
    for (const name of await readdir(outDir)) {
        if (name.endsWith('.json') && !keep.has(name)) {
            console.log(`留下未刷新的旧夹具 ${name}`);
        }
    }
}
