import test from 'node:test';
import assert from 'node:assert/strict';
import { singleFlight } from '../issueAnalysis/singleFlight.js';
test('concurrent lookup/dispatch uses a single operation and releases after settlement', async () => {
    let count = 0, release;
    const pending = new Promise(resolve => { release = resolve; });
    const operation = async () => { count++; await pending; return { taskId: 'only-one' }; };
    const results = Array.from({ length: 20 }, () => singleFlight('same', operation));
    await Promise.resolve(); assert.equal(count, 1); release();
    const values = await Promise.all(results); assert.ok(values.every(v => v === values[0]));
    await singleFlight('same', async () => { count++; }); assert.equal(count, 2);
});
test('failed operation releases the key and independent keys are not blocked', async () => {
    await assert.rejects(singleFlight('a', async () => { throw new Error('failed'); }));
    assert.deepEqual(await Promise.all([singleFlight('a', async () => 1), singleFlight('b', async () => 2)]), [1, 2]);
});
