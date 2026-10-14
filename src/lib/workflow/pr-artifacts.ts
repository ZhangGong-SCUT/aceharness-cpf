import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

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

const MANIFEST = 'pr-archive-manifest.json';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
function validName(name: string) {
  if (!name || isAbsolute(name) || name.includes('\\') || name.includes('\0')
    || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('非法产物路径');
  }
}

/** Check every existing component, including outputs and its ancestors. Never follow symlinks. */
async function checkPath(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('产物路径不能包含符号链接');
    } catch (error) {
      if (!isMissing(error)) throw error;
      break;
    }
  }
}

async function readRegular(path: string): Promise<Buffer> {
  await checkPath(path);
  if (!(await lstat(path)).isFile()) throw new Error('产物必须是普通文件');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('产物必须是普通文件');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new Error('读取期间产物发生变化，请重试');
    }
    return bytes;
  } finally { await handle.close(); }
}

export async function sha256File(file: string): Promise<string | null> {
  try { return digest(await readRegular(file)); } catch { return null; }
}

/** Atomic normal copies; exclusive snapshots never replace a different historical value. */
async function persist(path: string, bytes: Buffer, immutable = false): Promise<'archived' | 'already_present'> {
  await checkPath(path);
  try {
    const old = await readRegular(path);
    if (digest(old) === digest(bytes)) return 'already_present';
    if (immutable) throw new Error('同一尝试的快照内容冲突，保留原证据');
  } catch (error) { if (!isMissing(error)) throw error; }
  await mkdir(dirname(path), { recursive: true });
  await checkPath(path);
  const temp = join(dirname(path), `.pr-artifact-${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    await checkPath(path);
    if (immutable) {
      try { await link(temp, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
          || digest(await readRegular(path)) !== digest(bytes)) throw error;
        return 'already_present';
      }
    } else { await rename(temp, path); }
    if (digest(await readRegular(path)) !== digest(bytes)) throw new Error('归档回读 hash 不匹配');
    return 'archived';
  } finally { await unlink(temp).catch(() => {}); }
}

function failedEntry(name: string, source: string, error: unknown, role: PrArtifactEntry['role'] = 'evidence'): PrArtifactEntry {
  return { name, role, source_path: source, archived_to: null,
    status: isMissing(error) ? 'missing' : 'failed', bytes: null, sha256: null,
    error: String((error as Error)?.message || error).slice(0, 200) };
}

type Locations = { workingDirectory: string; runDirectory: string };

/** Explicit source selects this attempt's evidence. Default is work; there is no stale archive fallback. */
export async function snapshotPrArtifact(input: Locations & {
  name: string; tag: string; source?: 'work' | 'archive';
}): Promise<PrArtifactEntry> {
  const source = join(input.source === 'archive' ? input.runDirectory : input.workingDirectory, 'outputs', input.name);
  const name = `history/${input.tag}/${input.name}`;
  try {
    validName(input.name);
    if (!/^[0-9A-Za-z_][0-9A-Za-z_.:-]*$/.test(input.tag)) throw new Error('非法快照尝试标识');
    const bytes = await readRegular(source);
    const dst = join(input.runDirectory, 'outputs', name);
    const status = await persist(dst, bytes, true);
    return { name, role: 'versioned', source_path: source, archived_to: dst,
      status, bytes: bytes.length, sha256: digest(bytes) };
  } catch (error) { return failedEntry(name, source, error, 'versioned'); }
}

/** Copy all generated evidence, verify required files and retain the previous manifest's expectations. */
export async function archivePrRunArtifacts(input: Locations & {
  requiredArtifacts?: string[];
  allowEmpty?: boolean;
}): Promise<{
  artifact_status: 'complete' | 'partial' | 'failed'; entries: PrArtifactEntry[]; manifest: string; error?: string;
}> {
  const work = join(input.workingDirectory, 'outputs');
  const archive = join(input.runDirectory, 'outputs');
  const entries: PrArtifactEntry[] = [];
  const expected = new Set(input.requiredArtifacts || []);
  const priorHashes = new Map<string, string>();
  const manifestPath = join(archive, MANIFEST);
  const statusOf = () => entries.some(e => e.status === 'failed') ? 'failed' as const
    : entries.some(e => e.status === 'missing') ? 'partial' as const : 'complete' as const;
  try {
    // A root validation failure must return before even attempting to write the manifest.
    await checkPath(work);
    await checkPath(manifestPath);
  } catch (error) {
    entries.push(failedEntry('outputs/', work, error));
    return { artifact_status: 'failed', entries, manifest: '', error: '归档路径校验失败，未写入清单' };
  }
  try {
    try {
      const previous = JSON.parse((await readRegular(manifestPath)).toString());
      for (const name of previous.required_artifacts || []) { validName(name); expected.add(name); }
      for (const entry of previous.entries || []) {
        if (entry.name === 'outputs/') continue;
        validName(entry.name);
        expected.add(entry.name);
        if (/^[a-f0-9]{64}$/.test(entry.sha256 || '') && ['archived', 'already_present'].includes(entry.status)) {
          priorHashes.set(entry.name, entry.sha256);
        }
      }
    } catch (error) { if (!isMissing(error)) throw error; }
    const walk = async (prefix = ''): Promise<void> => {
      let children;
      try { children = await readdir(join(work, prefix), { withFileTypes: true }); }
      catch (error) { if (!prefix && isMissing(error)) return; throw error; }
      for (const child of children) {
        const name = prefix ? `${prefix}/${child.name}` : child.name;
        if (name === MANIFEST) continue;
        if (child.isDirectory()) { await checkPath(join(work, name)); await walk(name); }
        else expected.add(name);
      }
    };
    await walk();
    if (!expected.size && !input.allowEmpty) throw new Error('没有可核验的产物，不能声明完整归档');
    for (const name of [...expected].sort()) {
      const src = join(work, name), dst = join(archive, name);
      try {
        validName(name);
        if (name === MANIFEST) throw new Error('归档清单不能引用自身');
        let bytes: Buffer;
        let source = src;
        try { bytes = await readRegular(src); }
        catch (error) {
          if (!isMissing(error)) throw error;
          // Source cleanup is safe only if the archived copy still matches previously verified evidence.
          if (!priorHashes.has(name)) throw error;
          bytes = await readRegular(dst);
          if (digest(bytes) !== priorHashes.get(name)) throw new Error('源文件缺失且持久证据与旧清单不一致');
          source = dst;
        }
        const status = await persist(dst, bytes);
        entries.push({ name, role: 'evidence', source_path: source, archived_to: dst,
          status, bytes: bytes.length, sha256: digest(bytes) });
      } catch (error) { entries.push(failedEntry(name, src, error)); }
    }
  } catch (error) { entries.push(failedEntry('outputs/', work, error)); }
  try {
    const manifest = { version: 2, run_id: input.runDirectory.split(sep).filter(Boolean).pop() || '',
      generated_at: new Date().toISOString(), working_directory: input.workingDirectory,
      artifact_status: statusOf(), required_artifacts: [...expected].sort(), entries };
    await persist(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  } catch (error) {
    entries.push(failedEntry(MANIFEST, manifestPath, error));
    return { artifact_status: 'failed', entries, manifest: '', error: '归档清单写入失败' };
  }
  return { artifact_status: statusOf(), entries, manifest: `outputs/${MANIFEST}` };
}
