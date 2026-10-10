import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assessResultQuality } = require('../apps/worker/dist/chat/result-quality.js');
const { SqlQueryTool } = require('../apps/worker/dist/chat/tools/sql-query.tool.js');
const plan = { purpose: '核对', expectedGrain: 'id', expectedShape: 'table' };
const quality = (rows, sql = 'SELECT id, region FROM a JOIN b ON a.id = b.id') => assessResultQuality({
    plan, sql, columns: [{ name: 'id', type: 'number' }, { name: 'region', type: 'string' }], rows, isLimited: false,
});
const partialNulls = quality([{ id: 1, region: null }, { id: 2, region: '华东' }]);
assert.equal(partialNulls.warnings.find(w => w.code === 'NULL_VALUES').severity, 'info');
assert.ok(!partialNulls.warnings.some(w => w.code === 'JOIN_FANOUT_RISK'));
assert.equal(quality([{ id: 1, region: null }]).warnings.find(w => w.code === 'NULL_VALUES').severity, 'warning');
assert.equal(quality([{ id: 1 }, { id: 1 }]).warnings.find(w => w.code === 'DUPLICATE_GRAIN').severity, 'blocking');
async function execute(rows, analysis = true) {
    let persisted;
    const tool = new SqlQueryTool({ execute: async () => ({
        finalSql: 'SELECT id, region FROM a', rows, rowCount: rows.length,
        columns: [{ name: 'id', type: 'number' }, { name: 'region', type: 'string' }], isLimited: false,
    }) }, { createQueryArtifact: async input => {
        persisted = input;
        return { id: 'artifact', resultContentHash: 'hash' };
    } });
    const result = await tool.execute({ sql: 'SELECT id, region FROM a', plan }, {
        ...(analysis ? { analysisContext: {} } : {}), writerToken: 'writer', generationId: 'g',
        conversationId: 'c', userId: 1, datasourceId: 1, schemaContextVersion: 'v',
        signal: new AbortController().signal, assertWritable: async () => {}, emitter: { send() {} },
    });
    assert.equal(result.succeeded, true);
    return { payload: JSON.parse(result.toolResult), persisted };
}
const smallRows = Array.from({ length: 30 }, (_, id) => ({ id, region: '华东' }));
const small = await execute(smallRows);
assert.deepEqual(small.payload.data, smallRows);
assert.equal(small.payload.resultQuality.toolResultTruncated, false);
assert.equal(small.payload.systemMessage, undefined);
for (const analysis of [true, false]) {
    const limit = analysis ? 16000 : 60000;
    const rows = [{ id: 1, region: 'x'.repeat(100) }, { id: 2, region: 'x'.repeat(limit) }];
    const { payload, persisted } = await execute(rows, analysis);
    assert.deepEqual(payload.data, rows.slice(0, 1));
    assert.ok(JSON.stringify(payload.data).length <= limit);
    assert.deepEqual(persisted.rows, rows);
    assert.equal(payload.resultQuality.warnings.find(w => w.code === 'TOOL_RESULT_TRUNCATED').severity, 'blocking');
    assert.match(payload.systemMessage, /模型收到前 1 行/);
    const oversized = await execute([{ id: 1, region: 'x'.repeat(limit) }], analysis);
    assert.deepEqual(oversized.payload.data, []);
    assert.equal(oversized.payload.resultQuality.toolResultTruncated, true);
}
console.log('PASS result quality and SQL result size regression');
