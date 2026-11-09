/**
 * F03：受控快照输入（盲测/受控回放通道的 CPF 侧）。
 *
 * 与 ACEHarness 约定：快照写入 <运行时根>/eval-inputs/<sha256>.md，
 * 引擎端 collectIssue 校验路径位置与哈希后才采用（见 diagnosis-script-step.ts readIssueSnapshot）。
 */
import { aceDataDir, aceRunsDir, aceRuntimeRoot } from '../library/aceRuntime.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const EVAL_INPUTS_DIR = join(aceRuntimeRoot(), 'eval-inputs');
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MIN_SNAPSHOT_LENGTH = 10;

/**
 * 写入快照（幂等：同内容复用同一路径）。
 * @param {string} content Markdown 快照正文
 * @returns {{ path: string, sha256: string, bytes: number }}
 */
export function writeIssueSnapshot(content) {
    const body = String(content || '');
    if (body.trim().length < MIN_SNAPSHOT_LENGTH) throw new Error('快照内容过短（至少 10 个非空字符）');
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(`快照内容超出 ${MAX_SNAPSHOT_BYTES / 1024}KB 上限`);
    const sha256 = createHash('sha256').update(body).digest('hex');
    mkdirSync(EVAL_INPUTS_DIR, { recursive: true, mode: 0o700 });
    const file = join(EVAL_INPUTS_DIR, `${sha256}.md`);
    if (!existsSync(file)) {
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, body, { mode: 0o600 });
        renameSync(tmp, file); // 同目录 rename 原子生效，并发重复写结果一致
    }
    // 落盘后回读校验，保证登记值与磁盘内容一致
    const diskHash = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (diskHash !== sha256) throw new Error('快照落盘校验失败');
    return { path: file, sha256, bytes };
}

export const EVALUATION_MODES = new Set(['guided_replay', 'blind_eval']);
