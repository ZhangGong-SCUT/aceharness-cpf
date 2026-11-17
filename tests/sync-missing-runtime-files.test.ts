import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { ensureRuntimeHelpers, syncMissingTree, syncRuntimeTrees } from '../scripts/sync-missing-runtime-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-missing-'));
  temps.push(dir);
  return dir;
}

describe('运行时缺失文件补齐', () => {
  test('复现技能入口文件已放回源码且不再被忽略', () => {
    const skill = readFileSync(join(root, 'skills/flutter-issue-demo-reproduction/SKILL.md'), 'utf8');
    expect(skill.startsWith('---\nname: flutter-issue-demo-reproduction\n')).toBe(true);
    const ignored = [
      'skills/flutter-issue-demo-reproduction/SKILL.md',
      'skills/cpf-ohos-issue-analysis/references/common-experience.md',
      'skills/cpf-ohos-issue-analysis/references/fix-strategy.md',
      'skills/cpf-ohos-issue-analysis/references/issue-content-collection.md',
      'skills/cpf-ohos-issue-analysis/scripts/look-at-image.mjs',
      'configs/flutter-ohos-diagnosis.yaml',
    ];
    for (const file of ignored) {
      const result = spawnSync('git', ['check-ignore', '-v', '--', file], { cwd: root, encoding: 'utf8' });
      expect(result.status, file).toBe(1);
      expect(result.stdout, file).toBe('');
    }
  });

  test('采集说明含第 0 节和第 6 节，并会补进只有 8 个参考文件的运行目录', () => {
    const doc = readFileSync(join(root, 'skills/cpf-ohos-issue-analysis/references/issue-content-collection.md'), 'utf8');
    expect(doc).toContain('## 0. 先判断输入：Issue 链接或纯文本');
    expect(doc).toContain('## 6. 输出 JSON 模板');

    const shipped = [
      'vision-look.md',
      'upstream-search.md',
      'report-template.md',
      'ohos-signing-config.md',
      'log-interpretation.md',
      'log-collection.md',
      'environment-info.md',
      'engine-build.md',
    ];
    const install = tempDir();
    const runtime = tempDir();
    const srcRefs = join(install, 'skills', 'cpf-ohos-issue-analysis', 'references');
    const dstRefs = join(runtime, 'skills', 'cpf-ohos-issue-analysis', 'references');
    mkdirSync(srcRefs, { recursive: true });
    mkdirSync(dstRefs, { recursive: true });
    for (const name of shipped) {
      writeFileSync(join(srcRefs, name), 'package\n');
      writeFileSync(join(dstRefs, name), 'already-installed\n');
    }
    writeFileSync(join(srcRefs, 'issue-content-collection.md'), doc);

    expect(syncRuntimeTrees(install, runtime)).toBe(1);
    expect(readFileSync(join(dstRefs, 'issue-content-collection.md'), 'utf8')).toContain('## 6. 输出 JSON 模板');
    expect(readFileSync(join(dstRefs, 'environment-info.md'), 'utf8')).toBe('already-installed\n');
  });

  test('已有 references 目录时补上 SKILL.md，不覆盖已有文件', () => {
    const src = tempDir();
    const dst = tempDir();
    mkdirSync(join(src, 'flutter-issue-demo-reproduction', 'references'), { recursive: true });
    writeFileSync(join(src, 'flutter-issue-demo-reproduction', 'SKILL.md'), 'name: flutter-issue-demo-reproduction\n');
    writeFileSync(join(src, 'flutter-issue-demo-reproduction', 'references', 'device-emulator-setup.md'), 'new\n');
    mkdirSync(join(dst, 'flutter-issue-demo-reproduction', 'references'), { recursive: true });
    writeFileSync(join(dst, 'flutter-issue-demo-reproduction', 'references', 'device-emulator-setup.md'), 'local\n');

    expect(syncMissingTree(join(src, 'flutter-issue-demo-reproduction'), join(dst, 'flutter-issue-demo-reproduction'))).toBe(1);
    expect(readFileSync(join(dst, 'flutter-issue-demo-reproduction', 'SKILL.md'), 'utf8')).toContain('flutter-issue-demo-reproduction');
    expect(readFileSync(join(dst, 'flutter-issue-demo-reproduction', 'references', 'device-emulator-setup.md'), 'utf8')).toBe('local\n');
    expect(syncMissingTree(join(src, 'flutter-issue-demo-reproduction'), join(dst, 'flutter-issue-demo-reproduction'))).toBe(0);
  });

  test('运行时脚本依赖如果是符号链接，改成安装包里的真实文件', () => {
    const install = tempDir();
    const runtime = tempDir();
    mkdirSync(join(install, 'scripts'), { recursive: true });
    writeFileSync(join(install, 'scripts', 'file-lock.mjs'), 'export const lock = 1;\n');
    writeFileSync(join(install, 'scripts', 'runtime-root.mjs'), 'export const root = 1;\n');
    mkdirSync(join(runtime, 'scripts'), { recursive: true });
    symlinkSync('/tmp/missing-file-lock', join(runtime, 'scripts', 'file-lock.mjs'));
    expect(ensureRuntimeHelpers(install, runtime)).toBe(2);
    expect(readFileSync(join(runtime, 'scripts', 'file-lock.mjs'), 'utf8')).toContain('lock');
    expect(readFileSync(join(runtime, 'scripts', 'runtime-root.mjs'), 'utf8')).toContain('root');
    expect(ensureRuntimeHelpers(install, runtime)).toBe(0);
  });

  test('运行时目录已经链接到安装目录时不再复制', () => {
    const src = tempDir();
    const runtime = tempDir();
    mkdirSync(join(src, 'skills'));
    writeFileSync(join(src, 'skills', 'SKILL.md'), 'skill\n');
    symlinkSync(join(src, 'skills'), join(runtime, 'skills'));
    expect(syncRuntimeTrees(src, runtime)).toBe(0);
  });
});
