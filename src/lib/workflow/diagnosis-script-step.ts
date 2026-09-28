import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rename, cp, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { getInstallPath, getWorkspaceRoot } from '@/lib/core/app-paths';
import { buildConfiguredProcessEnv } from '@/lib/core/configured-env';
import { extractStructuredResult } from '@/lib/ai/result-channel';
import { redactOfficialFixLeak } from '@/lib/workflow/official-fix-redact';
import { isUsableOhosFlutterSdk, listInventoryEntries, loadOhosFlutterSdkInventory, resolveOhosFlutterSdk } from '@/lib/workflow/ohos-flutter-sdk';

export type DiagnosisScript = 'preflight' | 'restore' | 'finish' | 'abort';
type Input = { operation: DiagnosisScript; workingDirectory: string; runDirectory: string;
  globalContext: string; userId?: string; signal?: AbortSignal };
const execute = promisify(execFile);
const field = (text: string, name: string) => new RegExp(`^${name}:\\s*([^\\n]*)`, 'm').exec(text)?.[1]?.trim() || '';
const optionalJson = async (file: string) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
const optionalText = async (file: string) => { try { return await readFile(file, 'utf8'); } catch { return ''; } };
const meaningful = (v: any): v is Record<string, any> => !!v && typeof v === 'object' &&
  ['verdict', 'issue_golden_flag', 'problem_ownership', 'root_cause_summary', 'reset_target_merge_commit'].some(k => k in v);
const conclusion = (text: string): Record<string, any> => extractStructuredResult<Record<string, any>>(text, meaningful) || {};

async function save(input: Input, name: string, value: unknown) {
  for (const root of new Set([input.workingDirectory, input.runDirectory])) {
    const out = join(root, 'outputs'); await mkdir(out, { recursive: true });
    const file = join(out, name);
    await writeFile(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(file + '.tmp', file);
  }
}

export function issueApiAddress(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Issue 地址必须使用受支持平台的 HTTPS 地址');
  const parts = /^\/([^/]+)\/([^/]+)\/issues\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  const bases: Record<string, string> = { 'gitcode.com': 'https://gitcode.com/api/v5',
    'github.com': 'https://api.github.com', 'gitee.com': 'https://gitee.com/api/v5' };
  if (!parts || !bases[url.hostname]) throw new Error('Issue 地址格式或平台不受支持');
  const [, owner, repo, number] = parts;
  if (![owner, repo].every(v => /^[A-Za-z0-9_.-]+$/.test(v) && v !== '.' && v !== '..')) throw new Error('仓库地址格式无效');
  return { source: `${url.origin}${url.pathname}`, platform: url.hostname.split('.')[0], owner, repo, number,
    api: `${bases[url.hostname]}/repos/${owner}/${repo}/issues/${number}` };
}

async function collectIssue(input: Input, env: NodeJS.ProcessEnv) {
  const rawUrl = field(input.globalContext, 'issue-url') || input.globalContext.match(/https:\/\/[^\s<>"']+\/issues\/[A-Za-z0-9]+/)?.[0];
  if (!rawUrl) return { input_source: 'freeform_text', body: input.globalContext.replace(/^access-token:.*$/gm, ''),
    title: '文本问题', comments: [], issue_comments_count: 0, issue_content_complete: !!input.globalContext.trim(), checked_at: new Date().toISOString() };
  const target = issueApiAddress(rawUrl);
  const cached = await optionalJson(join(input.runDirectory, 'outputs/diagnosis-input.json'));
  if (cached?.source_url === target.source && cached.issue_content_complete) return cached;
  const token = field(input.globalContext, 'access-token') || env[`${target.platform.toUpperCase()}_TOKEN`] || '';
  const deadline = Date.now() + 20000;
  const get = async (url: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (input.signal?.aborted) throw new Error('诊断已停止');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Issue 采集超时');
      try {
        const signal = AbortSignal.any([AbortSignal.timeout(Math.min(8000, remaining)), ...(input.signal ? [input.signal] : [])]);
        const response = await fetch(url, { signal, redirect: 'error', headers: {
          Accept: 'application/json', 'User-Agent': 'ACEHarness-Diagnosis', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
        if (!response.ok) {
          const error = Object.assign(new Error(`Issue API HTTP ${response.status}`), { status: response.status });
          if (response.status >= 500 && attempt === 0) continue;
          throw error;
        }
        const raw = await response.text();
        if (raw.length > 2_000_000) throw new Error('Issue API 内容超出采集上限');
        return JSON.parse(raw);
      } catch (error: any) {
        if (input.signal?.aborted || error.status || attempt === 1) throw new Error(error.status ? `Issue API HTTP ${error.status}` : 'Issue 采集暂不可用或响应无效');
      }
    }
  };
  const issue = await get(target.api);
  if (typeof issue?.title !== 'string' || typeof issue?.body !== 'string') throw new Error('Issue 正文缺失，无法开始诊断');
  const comments: any[] = []; let complete = false; let commentError: string | null = null;
  try {
    for (let page = 1; page <= 3; page++) {
      const items = await get(`${target.api}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error('评论响应无效');
      comments.push(...items.map(c => ({ body: redactOfficialFixLeak(String(c.body || '')).text,
        created_at: c.created_at || null, author: c.user?.login || '' })));
      if (items.length < 100) { complete = true; break; }
    }
  } catch { if (input.signal?.aborted) throw new Error('诊断已停止'); commentError = '评论采集不完整，正文仍可分析'; }
  return { input_source: 'issue_url', source_url: target.source, title: redactOfficialFixLeak(issue.title).text,
    body: redactOfficialFixLeak(issue.body).text, issue_created_at: issue.created_at || null,
    comments, issue_comments_count: comments.length, issue_content_complete: true,
    comments_complete: complete, comments_error: commentError,
    missing_evidence: complete ? [] : ['评论未完整读取，请在报告中说明'], checked_at: new Date().toISOString() };
}

async function environment(input: Input, env: NodeJS.ProcessEnv) {
  const probe = async (command: string, args: string[]) => {
    try { return { ok: true, output: (await execute(command, args, { env, signal: input.signal, timeout: 4000, maxBuffer: 65536 })).stdout.trim() }; }
    catch (error: any) { if (input.signal?.aborted) throw new Error('诊断已停止'); return { ok: false, output: '', reason: error.code === 'ENOENT' ? '未安装或不在 PATH 中' : '命令失败或超时' }; }
  };
  const [git, hdc, adb] = await Promise.all([probe('git', ['--version']), probe('hdc', ['list', 'targets']), probe('adb', ['devices'])]);
  const sdks = listInventoryEntries(loadOhosFlutterSdkInventory()).filter(s => isUsableOhosFlutterSdk(s.path)).map(s => ({ id: s.id, version: s.version }));
  const ohosDevices = hdc.ok ? hdc.output.split(/\r?\n/).filter(s => s.trim() && !/empty|no devices|list of/i.test(s)) : [];
  const androidDevices = adb.ok ? adb.output.split(/\r?\n/).filter(s => /\sdevice$/.test(s)) : [];
  return { checked_at: new Date().toISOString(), git_available: git.ok, ohos_sdk_inventory: sdks,
    ohos_device_count: ohosDevices.length, android_device_count: androidDevices.length,
    hdc_available: hdc.ok, adb_available: adb.ok,
    runtime_validation: ohosDevices.length && sdks.length ? 'needs_sdk_alignment' : 'blocked_environment',
    missing_evidence: [...(!sdks.length ? ['缺少可用 OHOS Flutter SDK'] : []), ...(!ohosDevices.length ? ['当前无可用 OHOS 设备'] : [])] };
}

async function stepResult(archive: string, work: string, name: string, state: any): Promise<Record<string, any>> {
  const raw = await optionalText(join(archive, 'outputs', name + '.md'))
    || await optionalText(join(work, 'outputs', name + '.md'))
    || [...(state.stepLogs || [])].reverse().find((s: any) => s.stepName === name)?.output || '';
  return { ...conclusion(raw), text: raw.slice(-8000) };
}

async function captureContext(input: Input, env: NodeJS.ProcessEnv, persist = true) {
  const state = parse(await optionalText(join(input.runDirectory, 'state.yaml'))) || {};
  const read = (name: string) => stepResult(input.runDirectory, input.workingDirectory, name, state);
  const [collect, reproduction, root, verification, inherited] = await Promise.all([
    read('信息采集-Issue信息采集'), read('问题复现-问题复现'), read('根因分析-根因定位'),
    read('修复验证-修复方案对抗验证'), optionalJson(join(input.workingDirectory, 'outputs/diagnosis-inherited.json'))]);
  const repositories: any[] = [];
  for (const name of ['repo', 'repo-engine']) {
    if (!existsSync(join(input.workingDirectory, name, '.git'))) continue;
    const git = async (args: string[]) => (await execute('git', ['-C', join(input.workingDirectory, name), ...args], { env, timeout: 5000, signal: input.signal })).stdout.trim();
    const inheritedRepo = inherited?.repositories?.find((r: any) => r.name === name);
    const pinned = name === 'repo' ? collect.reset_target_merge_commit || collect.commit : collect.engine_commit;
    const commit = /^[a-f0-9]{40}$/i.test(pinned || '') ? pinned : inheritedRepo?.commit || await git(['rev-parse', 'HEAD']);
    const url = await git(['remote', 'get-url', 'origin']);
    const safeUrl = new URL(url); safeUrl.username = ''; safeUrl.password = ''; safeUrl.search = ''; safeUrl.hash = '';
    repositories.push({ name, url: safeUrl.toString(), commit,
      baseline_confirmed: /^[a-f0-9]{40}$/i.test(pinned || '') || (!!inheritedRepo?.commit && inheritedRepo.baseline_confirmed !== false),
      branch: inheritedRepo?.branch || collect.branch || await git(['branch', '--show-current']) });
    // Save the actual diff before any future workspace cleanup.
    const patchName = name === 'repo' ? 'fix.patch' : 'fix-engine.patch';
    const patch = await optionalText(join(input.workingDirectory, 'outputs', patchName))
      || (await execute('git', ['-C', join(input.workingDirectory, name), 'diff', commit, '--'], { env, timeout: 10000, signal: input.signal, maxBuffer: 8 * 1024 * 1024 })).stdout;
    if (persist && patch) for (const root of [input.workingDirectory, input.runDirectory]) {
      await mkdir(join(root, 'outputs'), { recursive: true });
      await writeFile(join(root, 'outputs', patchName), patch);
    }
  }
  const demoCandidate = reproduction.demo_path || inherited?.demo_path || join(input.workingDirectory, 'demo');
  const demoPath = resolve(input.workingDirectory, demoCandidate);
  const within = demoPath.startsWith(resolve(input.workingDirectory) + sep);
  const golden = inherited?.issue_golden_flag || reproduction.issue_golden_flag;
  const context = { version: 1, run_id: basename(input.runDirectory), working_directory: input.workingDirectory,
    checked_at: new Date().toISOString(), repositories, issue_golden_flag: golden || null,
    demo_path: within && existsSync(demoPath) ? demoPath : null,
    context_completeness: golden && within && existsSync(demoPath) && repositories.length
      && repositories.every(r => r.baseline_confirmed) ? 'complete' : 'partial',
    root_cause_summary: root.root_cause_summary || root.summary || inherited?.root_cause_summary || root.text,
    problem_ownership: root.problem_ownership || inherited?.problem_ownership || null,
    verification_status: verification.verdict === 'pass' && verification.issue_golden_flag_met === true
      && verification.engine_aligned === true && verification.bug_fixed === true ? 'verified' : 'needs_runtime_validation' };
  if (persist) await save(input, 'diagnosis-context.json', context);
  return context;
}

async function restore(input: Input, env: NodeJS.ProcessEnv) {
  const parentId = field(input.globalContext, 'parent-run-id');
  if (!/^run-[A-Za-z0-9_-]{4,80}$/.test(parentId)) throw new Error('原运行 ID 无效');
  const archive = join(getWorkspaceRoot(), 'runs', parentId);
  const state = parse(await readFile(join(archive, 'state.yaml'), 'utf8')) || {};
  const owner = state.createdBy || state.runOwnerId;
  if (owner && owner !== input.userId) throw new Error('原任务与当前执行用户不匹配');
  const work = state.workingDirectory || join(dirname(input.workingDirectory), parentId);
  if (basename(work) !== parentId) throw new Error('原任务工作目录不匹配');
  let context = await optionalJson(join(archive, 'outputs/diagnosis-context.json'));
  if (!context) {
    try { context = await captureContext({ ...input, runDirectory: archive, workingDirectory: work }, env, false); }
    catch { if (input.signal?.aborted) throw new Error('诊断已停止'); }
  }
  if (!context) return { verdict: 'conditional_pass', fallback_to_agent: true,
    summary: '旧任务上下文需按原始记录核对，转入兼容恢复步骤；不得猜测验收判据或提交' };
  if (context.run_id !== parentId) throw new Error('原任务上下文归属不匹配');
  if (!context.issue_golden_flag || !context.demo_path || !context.repositories?.length
    || context.repositories.some((r: any) => r.baseline_confirmed === false)) {
    return { verdict: 'conditional_pass', fallback_to_agent: true,
      summary: '旧任务缺少结构化继承清单，转入原有上下文恢复步骤核对；不得猜测验收判据或提交' };
  }
  const sourceDemo = await realpath(context.demo_path);
  if (!sourceDemo.startsWith(await realpath(work) + sep)) throw new Error('原 Demo 不在任务工作目录内');
  if (!context.repositories?.length) throw new Error('原任务缺少仓库基线，无法恢复到相同提交');
  const repositories = [];
  for (const repo of context.repositories) {
    if (!['repo', 'repo-engine'].includes(repo.name) || !/^[a-f0-9]{40}$/i.test(repo.commit || '')) throw new Error('原任务仓库基线无效');
    const url = new URL(repo.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !['gitcode.com', 'github.com', 'gitee.com'].includes(url.hostname)
      || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname)) throw new Error('原仓库地址无效');
    const dest = join(input.workingDirectory, repo.name);
    const git = async (args: string[]) => (await execute('git', args, { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, signal: input.signal, timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
    if (!existsSync(join(dest, '.git'))) {
      if (existsSync(dest)) throw new Error('恢复目录已存在且不是 Git 仓库，已保留，请检查后继续');
      const local = join(work, repo.name);
      const mirror = join(getWorkspaceRoot(), 'repo-cache', url.hostname, url.pathname.slice(1).replace(/\.git$/, '') + '.git');
      const source = [local, mirror].find(p => existsSync(p));
      const staging = await mkdtemp(join(input.workingDirectory, '.diagnosis-repo-'));
      const clone = join(staging, repo.name);
      try {
        if (source) {
          await git(['clone', '--no-checkout', '--', source, clone]);
          await git(['-C', clone, 'remote', 'set-url', 'origin', repo.url]);
        } else {
          await execute(process.execPath, [getInstallPath('skills/cpf-ohos-issue-analysis/scripts/repo-cache.mjs'), 'clone', '--repo', repo.url, '--dest', clone],
            { env, signal: input.signal, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
        }
        // An unpopulated --no-checkout clone legitimately reports deleted files.
        await git(['-C', clone, 'checkout', '--detach', repo.commit, '--']);
        await rename(clone, dest);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    } else {
      if (await git(['-C', dest, 'status', '--porcelain'])) throw new Error('恢复目录已有修改，已保留，请检查后继续');
      // Exact baseline only. Falling back to today's branch head would invalidate comparison.
      await git(['-C', dest, 'checkout', '--detach', repo.commit, '--']);
    }
    repositories.push({ ...repo, path: dest });
  }
  const demo = join(input.workingDirectory, 'demo');
  const marker = '.ace-diagnosis-restore.json';
  if (existsSync(demo)) {
    if ((await optionalJson(join(demo, marker)))?.parent_run_id !== parentId) throw new Error('Demo 目录已存在但恢复未确认，已保留，请检查后继续');
  } else {
    const staging = await mkdtemp(join(input.workingDirectory, '.diagnosis-demo-'));
    try {
      await cp(sourceDemo, join(staging, 'demo'), { recursive: true, dereference: true,
        filter: async p => {
          if (['build', '.dart_tool', '.gradle', 'oh_modules', 'node_modules', marker].includes(basename(p))) return false;
          if (input.signal?.aborted) throw new Error('诊断已停止');
          const actual = await realpath(p);
          if (actual !== sourceDemo && !actual.startsWith(sourceDemo + sep)) throw new Error('原 Demo 包含指向工作目录外的文件，请先整理复现工程');
          return true;
        } });
      await writeFile(join(staging, 'demo', marker), JSON.stringify({ parent_run_id: parentId }), { mode: 0o600 });
      await rename(join(staging, 'demo'), demo);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const pin = resolveOhosFlutterSdk({ branch: repositories.find(r => r.name === 'repo')?.branch || repositories[0].branch });
  await save(input, 'ohos-flutter-sdk.json', pin);
  const result = { ...context, run_id: basename(input.runDirectory), parent_run_id: parentId, repositories,
    demo_path: demo, repo_commit: repositories[0].commit, verdict: 'pass', context_completeness: 'complete',
    summary: '已按原提交恢复仓库、独立 Demo 和冻结验收判据', verification_status: 'needs_runtime_validation' };
  await save(input, 'diagnosis-inherited.json', result);
  return result;
}

/** Deterministic I/O steps. Semantic diagnosis and independent review stay with the agents. */
export async function executeDiagnosisScript(input: Input): Promise<string> {
  const env = await buildConfiguredProcessEnv(undefined, process.env, { userId: input.userId });
  let result: any;
  try {
    if (input.operation === 'preflight') {
      const [issue, checks] = await Promise.all([collectIssue(input, env), environment(input, env)]);
      await save(input, 'diagnosis-input.json', issue);
      await save(input, 'diagnosis-preflight.json', checks);
      result = { verdict: issue.issue_content_complete && checks.git_available ? 'pass' : 'fail',
        summary: '问题正文和环境预检已归档；缺设备时先做静态分析并保留待运行验证标记',
        input_source: issue.input_source, issue_comments_count: issue.issue_comments_count,
        artifact_path: 'outputs/diagnosis-input.json', environment: checks };
    } else if (input.operation === 'restore') result = await restore(input, env);
    else if (input.operation === 'finish') {
      const context = await captureContext(input, env);
      result = { verdict: 'pass', summary: '诊断产物和可确认的继承信息已归档；缺失项保留待核对',
        artifact_path: 'outputs/diagnosis-context.json', context_completeness: context.context_completeness,
        verification_status: context.verification_status };
    } else result = { verdict: 'fail', summary: '诊断已终止，已保留阶段产物和错误记录，可查看预检及步骤详情' };
  } catch (error: any) {
    if (input.signal?.aborted) throw new Error('诊断已停止');
    // Child process diagnostics may contain credentials; expose only bounded first-party errors.
    const message = error.stdout !== undefined || error.stderr !== undefined ? '仓库恢复命令失败，请核对原始提交及网络后重试'
      : String(error.message || '诊断脚本失败').replace(/https?:\/\/[^\s]+/g, '[地址]').slice(0, 300);
    result = { verdict: 'fail', summary: message, operation: input.operation };
  }
  await save(input, `diagnosis-${input.operation}-result.json`, result);
  return `<step-conclusion>${JSON.stringify(result)}</step-conclusion>`;
}
