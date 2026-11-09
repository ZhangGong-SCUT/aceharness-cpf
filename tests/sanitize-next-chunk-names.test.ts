import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sanitizeNextOutput } from '../scripts/sanitize-next-chunk-names.js';

const tmpRoots: string[] = [];
afterAll(async () => { await Promise.all(tmpRoots.map((d) => rm(d, { recursive: true, force: true }))); });

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sanitize-chunks-'));
  tmpRoots.push(dir);
  return dir;
}

const COLON = '[externals]_node:fs_promises_ef82023e._.js';
const PORTABLE = '[externals]_node_fs_promises_ef82023e._.js';
const F03A = COLON.replace(':', '\uF03A');

function namesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(entry.name);
    }
  };
  walk(dir);
  return out;
}

describe('sanitizeNextOutput', () => {
  it('把冒号 chunk 和加载器路径改成同一份可移植文件名', async () => {
    const root = await makeTmp();
    const chunks = join(root, 'server', 'chunks');
    mkdirSync(chunks, { recursive: true });
    writeFileSync(join(chunks, COLON), [
      'module.exports=[912714,(e,s,o)=>{s.exports=e.x("node:fs/promises",()=>require("node:fs/promises"))}];',
      `//# sourceMappingURL=${encodeURIComponent(COLON)}.map`,
    ].join('\n'));
    writeFileSync(join(chunks, `${COLON}.map`), '{"file":"keep"}');
    writeFileSync(
      join(chunks, '[root-of-the-server]__512fe453._.js'),
      `687903,e=>{e.v(r=>Promise.all(["server/chunks/${COLON}"].map(r=>e.l(r))).then(()=>r(912714)))}`,
    );
    writeFileSync(join(chunks, '[externals]_fs_promises_0bfe4114._.js'), 'legal');

    expect(sanitizeNextOutput(root)).toBe(2);
    expect(existsSync(join(chunks, PORTABLE))).toBe(true);
    expect(existsSync(join(chunks, COLON))).toBe(false);
    const loader = readFileSync(join(chunks, '[root-of-the-server]__512fe453._.js'), 'utf8');
    expect(loader).toContain(`server/chunks/${PORTABLE}`);
    expect(loader).not.toContain('node:fs_promises');
    const chunk = readFileSync(join(chunks, PORTABLE), 'utf8');
    expect(chunk).toContain('require("node:fs/promises")');
    expect(chunk).toContain(`sourceMappingURL=${encodeURIComponent(PORTABLE)}.map`);
    expect(chunk).not.toContain('%3A');
    expect(readFileSync(join(chunks, '[externals]_fs_promises_0bfe4114._.js'), 'utf8')).toBe('legal');
    expect(sanitizeNextOutput(root)).toBe(0);
    for (const name of namesUnder(root)) {
      expect(name).not.toMatch(/[<>:"|?*\u0000-\u001f]/);
      expect(name).not.toContain('\uF03A');
    }
  });

  it('Windows 上已写成 U+F03A 的文件名仍按冒号路径改写', async () => {
    const root = await makeTmp();
    const chunks = join(root, 'server', 'chunks');
    mkdirSync(chunks, { recursive: true });
    writeFileSync(join(chunks, F03A), 'chunk');
    writeFileSync(join(chunks, 'loader.js'), `Promise.all(["server/chunks/${COLON}"])`);

    expect(sanitizeNextOutput(root)).toBe(1);
    expect(existsSync(join(chunks, PORTABLE))).toBe(true);
    expect(existsSync(join(chunks, F03A))).toBe(false);
    expect(readFileSync(join(chunks, 'loader.js'), 'utf8')).toBe(`Promise.all(["server/chunks/${PORTABLE}"])`);
  });

  it('目标文件已存在时不改动', async () => {
    const root = await makeTmp();
    mkdirSync(join(root, 'server', 'chunks'), { recursive: true });
    writeFileSync(join(root, 'server', 'chunks', 'a:b.js'), 'old');
    writeFileSync(join(root, 'server', 'chunks', 'a_b.js'), 'keep');
    expect(() => sanitizeNextOutput(root)).toThrow(/重命名冲突/);
    expect(readFileSync(join(root, 'server', 'chunks', 'a:b.js'), 'utf8')).toBe('old');
    expect(readFileSync(join(root, 'server', 'chunks', 'a_b.js'), 'utf8')).toBe('keep');
  });
});

describe('预检不再生成 node: chunk 文件名', () => {
  it('诊断脚本和 CLI 不再动态 import node: 内置模块', () => {
    const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const diagnosis = strip(readFileSync(join(process.cwd(), 'src/lib/workflow/diagnosis-script-step.ts'), 'utf8'));
    expect(diagnosis).not.toContain("import('node:");
    const cli = strip(readFileSync(join(process.cwd(), 'src/cli.ts'), 'utf8'));
    expect(cli).not.toContain("import('node:");
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toContain('node scripts/sanitize-next-chunk-names.js');
    const server = readFileSync(join(process.cwd(), 'server.js'), 'utf8');
    const sanitizeAt = server.indexOf('sanitize-next-chunk-names');
    const nextAt = server.indexOf("const next = require('next')");
    expect(sanitizeAt).toBeGreaterThan(-1);
    expect(nextAt).toBeGreaterThan(sanitizeAt);
  });
});
