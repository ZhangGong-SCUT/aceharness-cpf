import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parse } from 'yaml';
import { getWorkspaceRoot } from '@/lib/core/app-paths';
import { classifyPrReviewInput, prIdentityKey } from './pr-review-input';

const exec = promisify(execFile);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const field = (text: string, name: string) => new RegExp(`^${name}:\\s*([^\\n]*)`, 'm').exec(text)?.[1]?.trim() || '';
const json = async (path: string) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const text = async (path: string) => { try { return await readFile(path, 'utf8'); } catch { return ''; } };
const canonicalPatch = (patch: string) => patch.replace(/^index [a-f0-9]+\.\.[a-f0-9]+/gm, 'index HASH..HASH').trimEnd();
const semanticFallback = () => ({ verdict: 'conditional_pass', fallback_to_agent: true, summary: '使用原有语义审查步骤' });
type Input = { operation: 'approved-apply' | 'approved-apply-audit'; workingDirectory: string;
  runDirectory: string; globalContext: string; userId?: string; signal?: AbortSignal; env: NodeJS.ProcessEnv };

/** Apply only the exact patch the caller approved. Other modes retain their AI steps. */
export async function executeApprovedApply(input: Input): Promise<Record<string, any>> {
  const sourceId = field(input.globalContext, 'user_apply_patch');
  const expectedHash = field(input.globalContext, 'approved_patch_sha256');
  if (!/^run-[A-Za-z0-9_-]{4,80}$/.test(sourceId) || !/^[a-f0-9]{64}$/.test(expectedHash)) return semanticFallback();
  const baseline = field(input.globalContext, 'head_sha');
  const out = join(input.workingDirectory, 'outputs');
  const save = async (name: string, body: string) => {
    for (const root of [input.workingDirectory, input.runDirectory]) {
      await mkdir(join(root, 'outputs'), { recursive: true });
      await writeFile(join(root, 'outputs', name), body, { mode: 0o600 });
    }
  };
  const git = async (path: string, args: string[]) => (await exec('git', ['-C', path, ...args], {
    env: { ...input.env, GIT_TERMINAL_PROMPT: '0' }, signal: input.signal, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  })).stdout;
  let result: Record<string, any>;
  try {
    if (!/^[a-f0-9]{40}$/i.test(baseline)) throw new Error('缺少批准时的精确提交，不能应用');
    const archive = join(getWorkspaceRoot(), 'runs', sourceId);
    const source = parse(await readFile(join(archive, 'state.yaml'), 'utf8'));
    const own = source.createdBy || source.runOwnerId;
    if (!own || own !== input.userId) throw new Error('建议任务与当前执行用户不匹配');
    const currentPr = classifyPrReviewInput(input.globalContext), sourcePr = classifyPrReviewInput(source.globalContext);
    if (!currentPr.owner || prIdentityKey(currentPr.owner, currentPr.repo, currentPr.number) !== prIdentityKey(sourcePr.owner, sourcePr.repo, sourcePr.number)
      || currentPr.headRepo !== sourcePr.headRepo || currentPr.headRef !== sourcePr.headRef) throw new Error('建议补丁与当前 PR 分支不匹配');
    const sourceWork = source.workingDirectory;
    if (!sourceWork || basename(sourceWork) !== sourceId) return semanticFallback();
    const patch = await text(join(archive, 'outputs/fix.patch')) || await text(join(sourceWork, 'outputs/fix.patch'));
    if (!patch || hash(patch) !== expectedHash) throw new Error('建议补丁在批准后发生变化，请重新确认');
    const suggestion = await json(join(sourceWork, 'outputs/review-suggestion.json')) || await json(join(archive, 'outputs/review-suggestion.json'));
    if ((suggestion?.head_sha || sourcePr.headSha) !== baseline) throw new Error('建议基线与批准提交不一致，请重新生成建议');
    const repo = join(input.workingDirectory, 'repo');
    if (!currentPr.headRef) throw new Error('缺少 PR 来源分支');
    await exec('git', ['check-ref-format', '--branch', currentPr.headRef], { env: input.env, timeout: 10000 });
    if (input.operation === 'approved-apply') {
      if (!existsSync(join(repo, '.git'))) {
        if (existsSync(repo)) throw new Error('目标仓库目录已存在且状态不明，已保留');
        const original = join(sourceWork, 'repo');
        if (!existsSync(join(original, '.git'))) return semanticFallback();
        if (!currentPr.headRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(currentPr.headRepo)) throw new Error('PR 来源仓库地址无效');
        const staging = await mkdtemp(join(input.workingDirectory, '.approved-apply-'));
        try {
          const target = join(staging, 'repo');
          await exec('git', ['clone', '--no-checkout', '--', original, target], { env: input.env, signal: input.signal, timeout: 120000, maxBuffer: 1024 * 1024 });
          await git(target, ['remote', 'set-url', 'origin', `https://gitcode.com/${currentPr.headRepo}.git`]);
          await git(target, ['checkout', '-B', currentPr.headRef, baseline, '--']);
          await rename(target, repo);
        } finally { await rm(staging, { recursive: true, force: true }); }
      }
      if ((await git(repo, ['rev-parse', 'HEAD'])).trim() !== baseline) throw new Error('本地提交与批准基线不一致，已保留');
      const diff = await git(repo, ['diff', '--binary', 'HEAD', '--']);
      const untracked = await git(repo, ['ls-files', '--others', '--exclude-standard']);
      if (untracked.trim()) throw new Error('工作区存在未归档文件，不能覆盖');
      await save('fix.patch', patch);
      if (diff) {
        if (canonicalPatch(diff) !== canonicalPatch(patch)) throw new Error('工作区已有其他修改，已保留');
      } else {
        await git(repo, ['apply', '--check', '--index', '--', join(out, 'fix.patch')]);
        await git(repo, ['apply', '--index', '--', join(out, 'fix.patch')]);
      }
      // Preserve the original review, not suggestion mode (the user has already approved it).
      for (const name of ['ai-review-comments.json', 'dcp-codecheck-defects.json']) {
        let body = await text(join(archive, 'outputs', name)) || await text(join(sourceWork, 'outputs', name));
        if (body && name === 'ai-review-comments.json') {
          body = JSON.stringify({ ...JSON.parse(body), approved_patch: { source_run_id: sourceId,
            sha256: expectedHash, canonical_sha256: hash(canonicalPatch(patch)), baseline_head_sha: baseline } });
        }
        if (body) await save(name, body);
      }
      await save('review-lineage.json', JSON.stringify({ source_run_id: sourceId, approved_patch_sha256: expectedHash,
        baseline_head_sha: baseline, pr_key: prIdentityKey(currentPr.owner, currentPr.repo, currentPr.number) }));
    }
    const diff = await git(repo, ['diff', '--binary', 'HEAD', '--']);
    if ((await git(repo, ['rev-parse', 'HEAD'])).trim() !== baseline || canonicalPatch(diff) !== canonicalPatch(patch)
      || (await git(repo, ['ls-files', '--others', '--exclude-standard'])).trim()) throw new Error('实际修改与已批准补丁不一致，请核对');
    result = { verdict: 'pass', summary: '已用脚本核对批准补丁、原始提交和实际改动，等待推送验证',
      source_run_id: sourceId, baseline_head_sha: baseline, patch_sha256: expectedHash, applied: true, runtime_verified: false };
  } catch (error: any) {
    if (input.signal?.aborted) throw new Error('已停止应用补丁');
    result = { verdict: 'fail', applied: false, summary: error.stderr !== undefined
      ? '补丁应用或校验失败，工作区已保留，请核对冲突和原始提交' : String(error.message).slice(0, 200) };
  }
  await save('approved-apply-result.json', JSON.stringify(result));
  return result;
}
