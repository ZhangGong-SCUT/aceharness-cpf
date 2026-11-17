import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aceRuntimeRoot } from '../library/aceRuntime.js';

const ID_RE = /^prd-[a-f0-9]{8}$/;

export function draftsDir() {
  return join(aceRuntimeRoot(), 'pr-drafts');
}

export function isDraftId(id) {
  return ID_RE.test(String(id || ''));
}

export async function readDraft(id) {
  if (!isDraftId(id)) return null;
  try {
    return JSON.parse(await readFile(join(draftsDir(), `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(name, value) {
  const dir = draftsDir();
  await mkdir(dir, { recursive: true });
  const temporary = join(dir, `.${name}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, join(dir, name));
}

/** 移植核对记录，键是 portCheck 返回的 key（绑定具体 commit）。 */
export async function readVerifications() {
  try {
    return JSON.parse(await readFile(join(draftsDir(), 'verifications.json'), 'utf8')) || {};
  } catch {
    return {};
  }
}

export async function saveVerification(key, record) {
  const all = await readVerifications();
  all[key] = record;
  await writeJson('verifications.json', all);
  return record;
}

export async function listDrafts(limit = 100) {
  let names = [];
  try {
    names = (await readdir(draftsDir())).filter((name) => /^prd-[a-f0-9]{8}\.json$/.test(name));
  } catch {
    return [];
  }
  const verifications = await readVerifications();
  const drafts = [];
  for (const name of names) {
    const draft = await readDraft(name.slice(0, -5));
    if (!draft) continue;
    const pullList = (draft.results?.pulls || []).filter((item) => item.url)
      .map((item) => ({ base: item.base, number: item.number, url: item.url }));
    drafts.push({
      id: draft.id,
      createdAt: draft.createdAt || '',
      status: draft.status || 'draft',
      repoPath: draft.repoPath || '',
      headBranch: draft.headBranch || '',
      trackingBranch: draft.trackingBranch || '',
      groupId: draft.groupId || '',
      port: draft.port ? { fromBranch: draft.port.fromBranch, verified: Boolean(verifications[`sha:${draft.headSha}`]) } : null,
      title: draft.title || '',
      commits: draft.commits?.length || 0,
      dirty: Boolean(draft.dirty),
      pulls: pullList.length,
      pullList,
    });
  }
  return drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export async function writeDraft(draft) {
  if (!isDraftId(draft?.id)) throw new Error('草稿编号无效');
  await writeJson(`${draft.id}.json`, draft);
  return draft;
}
