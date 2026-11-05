import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const CHECKOUT_STATES = new Set(['DCO修复', '静态修复', '编译修复', '检视修复']);

function field(context: string, key: string): string {
  return new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(context)?.[1]?.trim() || '';
}

export function shouldCheckoutPrHead(stateName: string, agent: string): boolean {
  return CHECKOUT_STATES.has(stateName) && agent === 'developer';
}

export async function ensurePrHeadCheckout(input: {
  workingDirectory: string;
  globalContext: string;
  signal?: AbortSignal;
}): Promise<void> {
  const script = [
    resolve(process.cwd(), 'skills/gitcode-pr-review/scripts/checkout-pr-head.mjs'),
    resolve(input.workingDirectory, 'skills/gitcode-pr-review/scripts/checkout-pr-head.mjs'),
  ].find((item) => existsSync(item));
  if (!script) throw new Error('找不到 checkout-pr-head.mjs');
  const args = [
    script,
    '--run', input.workingDirectory,
    '--base-ref', field(input.globalContext, 'base_ref'),
    '--head-ref', field(input.globalContext, 'head_ref'),
    '--head-sha', field(input.globalContext, 'head_sha'),
    '--head-repo', field(input.globalContext, 'head_repo'),
  ];
  try {
    await execute(process.execPath, args, {
      cwd: input.workingDirectory,
      signal: input.signal,
      timeout: 10 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error: any) {
    const detail = String(error?.stderr || error?.stdout || error?.message || 'checkout failed').slice(0, 500);
    throw new Error(`检出 PR 分支失败，禁止改为 git clone。${detail}`);
  }
}
