import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { evalInputsDir, readIssueSnapshot } from '../src/lib/workflow/diagnosis-script-step';

/**
 * F03 链路保管验证：训练评审目录中的脱敏输入 →（CPF 约定：哈希命名写入受控目录）
 * → 引擎 readIssueSnapshot 读回，逐字节一致且 sha256 与 manifest 登记一致。
 * 目录不存在时（其他机器）跳过。
 */
const INPUTS_DIR = '/home/flutter/issue-training-review/run-20261012/inputs';
const MANIFEST = join(INPUTS_DIR, 'manifest.json');
const hasInputs = existsSync(MANIFEST);
const written: string[] = [];
afterAll(async () => { await Promise.all(written.map((f) => rm(f, { force: true }))); });

describe('F03 脱敏输入链路（CPF 写入 → 引擎读取 → 对照 manifest）', () => {
  it.skipIf(!hasInputs)('全部受控输入逐字节一致且哈希匹配', async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const cases = manifest.cases as Array<{ case_id: string; file: string; sha256: string }>;
    expect(cases.length).toBeGreaterThan(0);
    mkdirSync(evalInputsDir(), { recursive: true });
    for (const c of cases) {
      const body = readFileSync(join(INPUTS_DIR, c.file), 'utf8');
      // 与 CPF writeIssueSnapshot 相同的命名约定（内容寻址）
      const hash = createHash('sha256').update(body).digest('hex');
      const staged = join(evalInputsDir(), `${hash}.md`);
      writeFileSync(staged, body);
      written.push(staged);
      const got = await readIssueSnapshot(staged, hash);
      expect(got.sha256, `${c.case_id} 哈希应与 manifest 一致`).toBe(c.sha256);
      expect(got.body, `${c.case_id} 正文应逐字节一致`).toBe(body);
    }
  });
});
