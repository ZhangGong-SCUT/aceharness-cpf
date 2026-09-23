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
  let routed;
  if (fromState === '分类处置') {
    // DCO / 静态 / 编译 / 测试的分流条件完全确定，按现有优先级在脚本里一次走完；
    // 保留「分流检视」作为唯一后续入口，因为 AI 意见需要先从 GitCode 拉取。
    const routeStates = new Set(['分类处置', '分流静态', '分流编译', '分流测试']);
    let state = fromState;
    const visited = new Set();
    for (let index = 0; index < routeStates.size; index += 1) {
      if (visited.has(state)) throw new Error(`门禁分流发生循环：${state}`);
      visited.add(state);
      routed = routeClassifyState(state, gate.phase);
      if (!routeStates.has(routed.next_state)) break;
      state = routed.next_state;
    }
    if (!routed || routeStates.has(routed.next_state)) {
      throw new Error(`门禁分流超过预期步数：${gate.phase}`);
    }
  } else {
    routed = routeClassifyState(fromState, gate.phase);
  }
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
