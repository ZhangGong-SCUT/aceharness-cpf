#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { routeClassifyState } from './ohos-pr-gates.mjs';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

async function main() {
  const fromState = arg('--from');
  const gatePath = resolve(arg('--in', 'outputs/gate-check.json'));
  if (!fromState) throw new Error('缺少 --from <分流状态名>');
  const gate = JSON.parse(await readFile(gatePath, 'utf8'));
  const routed = routeClassifyState(fromState, gate.phase);
  const result = {
    ...routed,
    phase: gate.phase,
    from_state: fromState,
    summary: gate.summary || '',
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
});
