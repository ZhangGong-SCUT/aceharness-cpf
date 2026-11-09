import { cp, mkdir, readdir, stat, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { execSync } from 'child_process';
import { getInstallPath, getWorkspaceCacheFile, getWorkspaceSkillPath, getWorkspaceSkillsDir, getWorkspaceRoot } from '@/lib/core/app-paths';
import { createDirectoryLinkSync, isLinkedDirectoryTarget } from '@/lib/core/directory-links';
import { syncMissingTree } from '../../../scripts/sync-missing-runtime-files.mjs';

const INSTALL_SKILLS_DIR = getInstallPath('skills');
let seedPromise: Promise<void> | null = null;
let runtimeSkillsSeeded = false;

/** Dependencies required by aceharness-* skills scripts */
const SKILL_DEPS: string[] = [];

async function linkMissingBundledEntry(src: string, dst: string): Promise<void> {
  const srcStat = await stat(src);
  if (!srcStat.isDirectory()) {
    if (existsSync(dst)) return;
    await mkdir(dirname(dst), { recursive: true });
    await cp(src, dst, { force: false });
    return;
  }

  if (!existsSync(dst)) {
    await mkdir(dirname(dst), { recursive: true });
    try {
      createDirectoryLinkSync(src, dst);
    } catch (error) {
      console.warn(`[runtime-skills] Failed to link bundled skill ${src} -> ${dst}:`, error);
    }
    return;
  }

  if (isLinkedDirectoryTarget(dst, src)) return;
  syncMissingTree(src, dst);
}

async function linkMissingBundledSkills(srcDir: string, dstDir: string): Promise<void> {
  await mkdir(dstDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    await linkMissingBundledEntry(resolve(srcDir, entry.name), resolve(dstDir, entry.name));
  }
}

/**
 * Ensure skill script dependencies (yaml, zod) are available in the runtime directory.
 * Tries to resolve from the install dir first; if not found, installs into runtime.
 */
async function ensureSkillDeps(): Promise<void> {
  const runtimeRoot = getWorkspaceRoot();
  const runtimeNodeModules = join(runtimeRoot, 'node_modules');

  // Check if deps already resolvable from install dir or runtime
  const missing: string[] = [];
  for (const dep of SKILL_DEPS) {
    const inInstall = existsSync(join(getInstallPath('node_modules'), dep));
    const inRuntime = existsSync(join(runtimeNodeModules, dep));
    if (!inInstall && !inRuntime) {
      missing.push(dep);
    }
  }

  if (missing.length === 0) return;

  // Ensure package.json exists in runtime root
  const pkgPath = join(runtimeRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    await writeFile(pkgPath, '{"private":true}\n');
  }

  try {
    console.log(`[runtime-skills] Installing skill dependencies: ${missing.join(', ')}`);
    execSync(`npm install ${missing.join(' ')} --save --legacy-peer-deps`, {
      cwd: runtimeRoot,
      stdio: 'pipe',
      timeout: 60000,
    });
  } catch (err: any) {
    console.error(`[runtime-skills] Failed to install skill deps:`, err.message);
  }
}

async function refreshStalePrSkill(runtimeSkillsDir: string): Promise<void> {
  const dest = resolve(runtimeSkillsDir, 'gitcode-pr-review', 'SKILL.md');
  const src = resolve(INSTALL_SKILLS_DIR, 'gitcode-pr-review', 'SKILL.md');
  if (!existsSync(dest) || !existsSync(src)) return;
  if (isLinkedDirectoryTarget(resolve(runtimeSkillsDir, 'gitcode-pr-review'), resolve(INSTALL_SKILLS_DIR, 'gitcode-pr-review'))) return;
  const current = readFileSync(dest, 'utf8');
  if (current.includes('ACE_NODE')) return;
  const backup = `${dest}.bak-before-identity-script`;
  if (!existsSync(backup)) await cp(dest, backup);
  await cp(src, dest, { force: true });
}

export async function ensureRuntimeSkillsSeeded(): Promise<void> {
  if (runtimeSkillsSeeded) return;
  if (seedPromise) return seedPromise;

  seedPromise = (async () => {
    const runtimeSkillsDir = getWorkspaceSkillsDir();
    if (!existsSync(INSTALL_SKILLS_DIR)) {
      await mkdir(runtimeSkillsDir, { recursive: true });
      await ensureSkillDeps();
      runtimeSkillsSeeded = true;
      return;
    }

    await linkMissingBundledSkills(INSTALL_SKILLS_DIR, runtimeSkillsDir);
    await refreshStalePrSkill(runtimeSkillsDir);
    await ensureSkillDeps();
    runtimeSkillsSeeded = true;
  })().finally(() => {
    seedPromise = null;
  });

  return seedPromise;
}

export async function getRuntimeSkillsDirPath(): Promise<string> {
  await ensureRuntimeSkillsSeeded();
  return getWorkspaceSkillsDir();
}

export async function getRuntimeSkillPath(...segments: string[]): Promise<string> {
  await ensureRuntimeSkillsSeeded();
  return getWorkspaceSkillPath(...segments);
}

export function getInstallSkillsDirPath(): string {
  return INSTALL_SKILLS_DIR;
}

export async function syncInstalledSkillsToRuntime(skillNames: string[]): Promise<{ synced: string[]; missing: string[] }> {
  await ensureRuntimeSkillsSeeded();

  const runtimeSkillsDir = getWorkspaceSkillsDir();
  const synced: string[] = [];
  const missing: string[] = [];

  for (const rawName of skillNames) {
    const skillName = rawName.trim();
    if (!skillName) continue;

    const src = join(INSTALL_SKILLS_DIR, skillName);
    if (!existsSync(src)) {
      missing.push(skillName);
      continue;
    }

    const dest = join(runtimeSkillsDir, skillName);
    if (existsSync(dest)) {
      if (!isLinkedDirectoryTarget(dest, src)) syncMissingTree(src, dest);
      synced.push(skillName);
      continue;
    }

    try {
      createDirectoryLinkSync(src, dest);
    } catch (error) {
      console.warn(`[runtime-skills] Failed to link installed skill ${skillName}:`, error);
    }
    if (!existsSync(dest) || !isLinkedDirectoryTarget(dest, src)) {
      missing.push(skillName);
      continue;
    }
    synced.push(skillName);
  }

  await ensureSkillDeps();
  runtimeSkillsSeeded = true;
  return { synced, missing };
}

export function getSkillsTempPath(...segments: string[]): string {
  return getWorkspaceCacheFile('skills', ...segments);
}
