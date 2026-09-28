import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify, parse } from 'yaml';
import { executeDiagnosisScript, issueApiAddress } from '@/lib/workflow/diagnosis-script-step';
import { stateMachineWorkflowSchema } from '@/lib/core/schemas';

const mocks = vi.hoisted(() => ({ root: '', command: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/core/app-paths', () => ({ getWorkspaceRoot: () => mocks.root, getInstallPath: (...v: string[]) => join(process.cwd(), ...v) }));
vi.mock('@/lib/core/configured-env', () => ({ buildConfiguredProcessEnv: async () => ({ PATH: '/bin' }) }));
vi.mock('@/lib/workflow/ohos-flutter-sdk', () => ({ loadOhosFlutterSdkInventory: () => ({}), listInventoryEntries: () => [],
  isUsableOhosFlutterSdk: () => false, resolveOhosFlutterSdk: () => ({ matched: false, reason: 'test inventory empty' }) }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const fn = Object.assign(() => {}, { [promisify.custom]: (...args: any[]) => mocks.command(...args) });
  return { execFile: fn };
});
const dirs: string[] = [];
beforeEach(async () => {
  mocks.root = await mkdtemp(join(tmpdir(), 'diagnosis-script-')); dirs.push(mocks.root);
  mocks.command.mockReset().mockImplementation(async (cmd, args) => {
    if (cmd === 'git' && args.includes('--version')) return { stdout: 'git version 2' };
    if (cmd === 'git' && args.includes('status')) return { stdout: '' };
    if (cmd === 'git' && args.includes('clone')) { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
    if (cmd === 'git') return { stdout: '' };
    throw Object.assign(new Error('not installed'), { code: 'ENOENT' });
  });
  mocks.fetch.mockReset(); vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture(globalContext = 'issue-url: https://gitcode.com/org/repo/issues/42') {
  const workingDirectory = join(mocks.root, 'work/run-test');
  const runDirectory = join(mocks.root, 'runs/run-test');
  await mkdir(join(workingDirectory, 'outputs'), { recursive: true });
  await mkdir(join(runDirectory, 'outputs'), { recursive: true });
  return { workingDirectory, runDirectory, globalContext, userId: 'u1' };
}
const result = (text: string) => JSON.parse(text.replace(/^<step-conclusion>|<\/step-conclusion>$/g, ''));

test('preflight collects one snapshot, redacts official answers, and never treats missing devices as verified', async () => {
  const input = await fixture('issue-url: https://gitcode.com/org/repo/issues/42\naccess-token: secret');
  mocks.fetch.mockImplementation(async (url: string, opts: any) => {
    expect(opts.headers.Authorization).toBe('Bearer secret');
    return new Response(JSON.stringify(url.includes('/comments') ? [{ body: '已在 PR #99 修复', user: { login: 'user' } }]
      : { title: 'Crash', body: 'Repro code', created_at: '2026-01-01' }), { status: 200 });
  });
  const data = result(await executeDiagnosisScript({ ...input, operation: 'preflight' }));
  expect(data.verdict).toBe('pass'); expect(data.environment.runtime_validation).toBe('blocked_environment');
  const raw = await readFile(join(input.runDirectory, 'outputs/diagnosis-input.json'), 'utf8');
  expect(raw).not.toContain('secret'); expect(raw).not.toContain('PR #99');
  expect(JSON.parse(raw).issue_comments_count).toBe(1);
  await executeDiagnosisScript({ ...input, operation: 'preflight' });
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

test('freeform input has no invented Issue requests and no credentials in its snapshot', async () => {
  const input = await fixture('Text reproduction steps\naccess-token: secret');
  expect(result(await executeDiagnosisScript({ ...input, operation: 'preflight' })).verdict).toBe('pass');
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(await readFile(join(input.runDirectory, 'outputs/diagnosis-input.json'), 'utf8')).not.toContain('secret');
});

test.each([401, 403, 404])('unreadable Issue HTTP %s terminates before any model or repository work', async status => {
  const input = await fixture(); mocks.fetch.mockResolvedValue(new Response('{}', { status }));
  const data = result(await executeDiagnosisScript({ ...input, operation: 'preflight' }));
  expect(data.verdict).toBe('fail'); expect(data.summary).toContain(String(status)); expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

test('transient API failures are retried once and incomplete comments remain visible', async () => {
  const input = await fixture();
  mocks.fetch.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Issue', body: 'Steps' }), { status: 200 }))
    .mockResolvedValue(new Response('{}', { status: 403 }));
  expect(result(await executeDiagnosisScript({ ...input, operation: 'preflight' })).verdict).toBe('pass');
  const saved = JSON.parse(await readFile(join(input.runDirectory, 'outputs/diagnosis-input.json'), 'utf8'));
  expect(saved.comments_complete).toBe(false); expect(saved.missing_evidence).toHaveLength(1);
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
});

test('Issue URLs cannot select an arbitrary API host or embed credentials', () => {
  for (const url of ['http://gitcode.com/o/r/issues/1', 'https://localhost/o/r/issues/1', 'https://secret@gitcode.com/o/r/issues/1']) expect(() => issueApiAddress(url)).toThrow();
  expect(issueApiAddress('https://gitee.com/org/repo/issues/I123').number).toBe('I123');
});

async function parent(input: Awaited<ReturnType<typeof fixture>>, owner = 'u1') {
  const work = join(mocks.root, 'work/run-parent'), archive = join(mocks.root, 'runs/run-parent');
  await mkdir(join(work, 'repo/.git'), { recursive: true }); await mkdir(join(work, 'demo/build'), { recursive: true });
  await mkdir(join(archive, 'outputs'), { recursive: true });
  await writeFile(join(work, 'demo/main.dart'), 'original'); await writeFile(join(work, 'demo/build/old'), 'stale');
  await writeFile(join(archive, 'state.yaml'), stringify({ createdBy: owner, workingDirectory: work }));
  await writeFile(join(archive, 'outputs/diagnosis-context.json'), JSON.stringify({ version: 1, run_id: 'run-parent',
    issue_golden_flag: 'tap once crashes', root_cause_summary: 'root', demo_path: join(work, 'demo'),
    repositories: [{ name: 'repo', url: 'https://gitcode.com/org/repo.git', commit: 'a'.repeat(40), branch: 'dev' }] }));
  return { ...input, globalContext: 'parent-run-id: run-parent', parentWork: work, parentArchive: archive };
}

test('feedback restores the exact baseline and copies an independent demo without old build output', async () => {
  const input = await parent(await fixture());
  const data = result(await executeDiagnosisScript({ ...input, operation: 'restore' }));
  expect(data.verdict).toBe('pass'); expect(data.issue_golden_flag).toBe('tap once crashes');
  expect(data.demo_path).toBe(join(input.workingDirectory, 'demo'));
  expect(await readFile(join(data.demo_path, 'main.dart'), 'utf8')).toBe('original');
  await expect(readFile(join(data.demo_path, 'build/old'))).rejects.toThrow();
  expect(mocks.command.mock.calls.some(([cmd, args]) => cmd === 'git' && args.includes('checkout') && args.includes('a'.repeat(40)))).toBe(true);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

test('feedback rejects a foreign owner and an external demo symlink', async () => {
  const input = await parent(await fixture(), 'other');
  expect(result(await executeDiagnosisScript({ ...input, operation: 'restore' })).verdict).toBe('fail');
  await writeFile(join(input.parentArchive, 'state.yaml'), stringify({ createdBy: 'u1', workingDirectory: input.parentWork }));
  await writeFile(join(mocks.root, 'outside'), 'private');
  await symlink(join(mocks.root, 'outside'), join(input.parentWork, 'demo/external'));
  expect(result(await executeDiagnosisScript({ ...input, operation: 'restore' })).verdict).toBe('fail');
  expect(await readdir(input.workingDirectory)).not.toContain('demo');
  expect((await readdir(input.workingDirectory)).some(name => name.startsWith('.diagnosis-'))).toBe(false);
  await rm(join(input.parentWork, 'demo/external'));
  expect(result(await executeDiagnosisScript({ ...input, operation: 'restore' })).verdict).toBe('pass');
});

test('a pre-existing incomplete demo is preserved and never claimed restored', async () => {
  const input = await parent(await fixture());
  await mkdir(join(input.workingDirectory, 'demo'));
  await writeFile(join(input.workingDirectory, 'demo/partial'), 'unfinished');
  expect(result(await executeDiagnosisScript({ ...input, operation: 'restore' })).verdict).toBe('fail');
  expect(await readFile(join(input.workingDirectory, 'demo/partial'), 'utf8')).toBe('unfinished');
});

test('real Git restore checks out the saved baseline, preserves dirty retries, and archives evidence honestly', async () => {
  const { execFile } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const exec = promisify(execFile);
  mocks.command.mockImplementation((cmd, args, options) => exec(cmd, args, options));
  const input = await parent(await fixture());
  const repo = join(input.parentWork, 'repo');
  await exec('git', ['init', repo]);
  await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await writeFile(join(repo, 'file.txt'), 'baseline');
  await exec('git', ['-C', repo, 'add', 'file.txt']);
  await exec('git', ['-C', repo, 'commit', '-m', 'baseline']);
  const commit = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  await exec('git', ['-C', repo, 'remote', 'add', 'origin', 'https://gitcode.com/org/repo.git']);
  const file = join(input.parentArchive, 'outputs/diagnosis-context.json');
  const context = JSON.parse(await readFile(file, 'utf8'));
  context.repositories[0].commit = commit;
  await writeFile(file, JSON.stringify(context));
  await writeFile(join(repo, 'file.txt'), 'parent fix');
  const restored = result(await executeDiagnosisScript({ ...input, operation: 'restore' }));
  expect(restored.verdict).toBe('pass');
  expect(await readFile(join(input.workingDirectory, 'repo/file.txt'), 'utf8')).toBe('baseline');
  expect(result(await executeDiagnosisScript({ ...input, operation: 'restore' })).verdict).toBe('pass');
  await writeFile(join(input.workingDirectory, 'repo/file.txt'), 'child fix');
  expect(result(await executeDiagnosisScript({ ...input, operation: 'restore' })).verdict).toBe('fail');
  await writeFile(join(input.workingDirectory, 'outputs/fix.patch'), 'existing patch including new files');
  await writeFile(join(input.runDirectory, 'state.yaml'), stringify({ stepLogs: [] }));
  const finished = result(await executeDiagnosisScript({ ...input, operation: 'finish' }));
  expect(finished.verification_status).toBe('needs_runtime_validation');
  const saved = JSON.parse(await readFile(join(input.runDirectory, 'outputs/diagnosis-context.json'), 'utf8'));
  expect(saved.context_completeness).toBe('complete');
  expect(saved.repositories[0]).toMatchObject({ commit, baseline_confirmed: true });
  expect(await readFile(join(input.runDirectory, 'outputs/fix.patch'), 'utf8')).toBe('existing patch including new files');
  expect(await readFile(join(input.workingDirectory, 'repo/file.txt'), 'utf8')).toBe('child fix');
});

test('an unconfirmed baseline uses legacy evidence recovery, never the latest branch head', async () => {
  const input = await parent(await fixture());
  const file = join(input.parentArchive, 'outputs/diagnosis-context.json');
  const context = JSON.parse(await readFile(file, 'utf8'));
  context.repositories[0].baseline_confirmed = false;
  await writeFile(file, JSON.stringify(context));
  expect(result(await executeDiagnosisScript({ ...input, operation: 'restore' })).fallback_to_agent).toBe(true);
  expect(mocks.command).not.toHaveBeenCalled();
});

test('legacy runs without a structured manifest keep the original recovery path', async () => {
  const input = await parent(await fixture());
  await rm(join(input.parentArchive, 'outputs/diagnosis-context.json'));
  // No local repositories: old completion may have cleaned them.
  await rm(join(input.parentWork, 'repo'), { recursive: true });
  expect(result(await executeDiagnosisScript({ ...input, operation: 'restore' })).fallback_to_agent).toBe(true);
});

test('all diagnosis configs expose deterministic I/O without removing the semantic reviews', async () => {
  for (const name of ['cpf-ohos-diagnosis', 'flutter-ohos-diagnosis', 'cpf-ohos-diagnosis-iterate']) {
    const config = parse(await readFile(join(process.cwd(), 'configs', name + '.yaml'), 'utf8'));
    expect(stateMachineWorkflowSchema.safeParse(config).success).toBe(true);
    const states = config.workflow.states;
    expect(states.find((s: any) => s.isInitial).steps[0].diagnosisScript).toBe(name.endsWith('iterate') ? 'restore' : 'preflight');
    expect(states.find((s: any) => s.name === '完成').steps[0].diagnosisScript).toBe('finish');
    expect(states.find((s: any) => s.name === '方案设计').steps).toHaveLength(3);
  }
});
