import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

/**
 * R4：PR 流程的产物归档。
 *
 * 此前 PR run 只把 gate-check/pr-push-audit 等少数文件搬到持久 outputs，
 * 工作目录里的 push-result.json / gate-source.json / dcp-codecheck-defects.json /
 * fix.patch 等原始证据没有进入归档；工作目录一旦清理就失去独立复核基础。
 *
 * 本模块提供两件事：
 *  1. snapshotPrArtifact：把每次尝试的 push/gate/patch 快照到 outputs/history/<tag>/，
 *     按尝试时间或 commit 分版，避免只留最后一份覆盖文件。
 *  2. archivePrRunArtifacts：把工作目录 outputs 全量递归归档进持久 run（无后缀白名单），
 *     逐文件 hash 校验 + 回读验证，写 pr-archive-manifest.json；不完整时返回 failed/partial。
 */

export interface PrArtifactEntry {
  name: string;
  role: 'evidence' | 'versioned';
  source_path: string | null;
  archived_to: string | null;
  status: 'archived' | 'already_present' | 'missing' | 'failed';
  bytes: number | null;
  sha256: string | null;
  error?: string;
}

export async function sha256File(file: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex');
  } catch {
    return null;
  }
}

function safeTag(raw: unknown): string {
  const cleaned = String(raw || '').replace(/[^0-9A-Za-z_.:-]/g, '');
  return cleaned || `t${Date.now()}`;
}

/** 把一次尝试的产物快照到 outputs/history/<tag>/，保留分版（push/gate/patch 不被覆盖）。 */
export async function snapshotPrArtifact(input: {
  name: string;
  tag: string;
  runDirectory: string;
  workingDirectory: string;
}): Promise<PrArtifactEntry | null> {
  const source = [
    join(input.runDirectory, 'outputs', input.name),
    join(input.workingDirectory, 'outputs', input.name),
  ].find((file) => existsSync(file));
  if (!source) return null;
  const tag = safeTag(input.tag);
  const dir = join(input.runDirectory, 'outputs', 'history', tag);
  const dst = join(dir, input.name);
  const digest = await sha256File(source);
  if (!digest) return null;
  await mkdir(dir, { recursive: true });
  const already = existsSync(dst) && (await sha256File(dst)) === digest;
  if (!already) await cp(source, dst);
  const ok = (await sha256File(dst)) === digest;
  const info = await stat(dst);
  return {
    name: `history/${tag}/${input.name}`,
    role: 'versioned',
    source_path: source,
    archived_to: dst,
    status: ok ? (already ? 'already_present' : 'archived') : 'failed',
    bytes: info.size,
    sha256: digest,
  };
}

/** 全量递归归档工作目录 outputs → 持久 run outputs，hash 校验 + 回读验证，写 manifest。 */
export async function archivePrRunArtifacts(input: {
  workingDirectory: string;
  runDirectory: string;
}): Promise<{
  artifact_status: 'complete' | 'partial' | 'failed';
  entries: PrArtifactEntry[];
  manifest: string;
  error?: string;
}> {
  const workOutputs = join(input.workingDirectory, 'outputs');
  const archiveOutputs = join(input.runDirectory, 'outputs');
  const selfGenerated = new Set(['pr-archive-manifest.json']);
  const entries: PrArtifactEntry[] = [];
  const safeName = (name: string) => !!name && !isAbsolute(name) && !name.includes('\\')
    && !name.split('/').some((part) => part === '..' || part === '.' || !part);
  const withinRoot = async (root: string, file: string) => {
    const actualRoot = await realpath(root);
    const actual = await realpath(file);
    if (!actual.startsWith(actualRoot + sep)) throw new Error('产物路径越出 outputs 目录');
  };
  const archiveFile = async (name: string) => {
    const src = join(workOutputs, name);
    const dst = join(archiveOutputs, name);
    try {
      if (!safeName(name) || selfGenerated.has(name)) throw new Error('非法或自引用产物路径');
      const source = existsSync(src) ? src : dst;
      await withinRoot(source === src ? workOutputs : archiveOutputs, source);
      const info = await stat(source);
      if (!info.isFile()) throw new Error('产物引用必须指向普通文件');
      const digest = await sha256File(source);
      if (!digest) throw new Error('产物 hash 读取失败');
      // 逐级拒绝符号链接目录/文件，避免归档时穿透到 outputs 之外
      let parent = archiveOutputs;
      for (const component of name.split('/').slice(0, -1)) {
        parent = join(parent, component);
        try { if ((await lstat(parent)).isSymbolicLink()) throw new Error('归档目标包含符号链接'); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; await mkdir(parent); }
      }
      try { if ((await lstat(dst)).isSymbolicLink()) throw new Error('归档文件不能是符号链接'); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      if (existsSync(dst)) await withinRoot(archiveOutputs, dst);
      const already = existsSync(dst) && (await sha256File(dst)) === digest;
      if (!already) await cp(source, dst);
      // 回读验证：清理工作目录后，该归档必须能独立读回同一内容
      if ((await sha256File(dst)) !== digest) throw new Error('归档回读 hash 不匹配');
      entries.push({
        name, role: 'evidence', source_path: source, archived_to: dst,
        status: already ? 'already_present' : 'archived', bytes: info.size, sha256: digest,
      });
    } catch (error: any) {
      entries.push({
        name, role: 'evidence', source_path: src, archived_to: null,
        status: error?.code === 'ENOENT' ? 'missing' : 'failed', bytes: null, sha256: null,
        error: String(error?.message || error).slice(0, 200),
      });
    }
  };

  let persistFailed = false;
  try {
    for (const root of [workOutputs, archiveOutputs]) {
      try { if ((await lstat(root)).isSymbolicLink()) throw new Error('outputs 根目录不能是符号链接'); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    await mkdir(archiveOutputs, { recursive: true });
    const walk = async (prefix = ''): Promise<void> => {
      const dir = join(workOutputs, prefix);
      if (!existsSync(dir)) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(name);
        else if (!selfGenerated.has(name)) await archiveFile(name);
      }
    };
    await walk();
  } catch (error: any) {
    persistFailed = true;
    entries.push({
      name: 'outputs/', role: 'evidence', source_path: workOutputs, archived_to: null,
      status: 'failed', bytes: null, sha256: null, error: String(error?.message || error).slice(0, 200),
    });
  }

  const manifest = {
    version: 1,
    run_id: input.runDirectory.split(sep).filter(Boolean).pop() || '',
    generated_at: new Date().toISOString(),
    working_directory: input.workingDirectory,
    entries,
  };
  try {
    await mkdir(archiveOutputs, { recursive: true });
    await writeFile(join(archiveOutputs, 'pr-archive-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    persistFailed = true;
  }

  const artifactStatus = persistFailed || entries.some((entry) => entry.status === 'failed')
    ? 'failed'
    : entries.some((entry) => entry.status === 'missing') ? 'partial' : 'complete';
  return {
    artifact_status: artifactStatus,
    entries,
    manifest: 'outputs/pr-archive-manifest.json',
    ...(persistFailed ? { error: '运行归档目录写入失败' } : {}),
  };
}
