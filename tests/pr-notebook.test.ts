/**
 * 用以前跑过的 PR 门禁快照做回归。
 * 夹具在 tests/fixtures/pr-notebook，由 tests/pr-notebook/harvest.mjs 从本机旧 run 生成。
 * 这里只调用分类函数，不启动监控，不访问 GitCode。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { classifyOhosPrGates } from '../skills/gitcode-pr-review/scripts/ohos-pr-gates.mjs';

const notebookDir = join(process.cwd(), 'tests/fixtures/pr-notebook');
const cards = readdirSync(notebookDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(notebookDir, name), 'utf8')));

describe('PR 错题本', () => {
    test('错题本里有从旧 run 收来的题目', () => {
        expect(cards.length).toBeGreaterThan(0);
    });

    for (const card of cards) {
        test(`${card.pr} 应仍判为 ${card.expected.phase}（${card.id}）`, () => {
            const got = classifyOhosPrGates(card.input);
            for (const [key, value] of Object.entries(card.expected)) {
                expect(got[key], key).toEqual(value);
            }
        });
    }
});
