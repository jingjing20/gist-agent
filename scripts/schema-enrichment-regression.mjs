import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SchemaEnrichmentService, parseEnrichments, validateCommentChanges } = require('../apps/api/dist/datasource/schema-enrichment.service.js');
const { SuggestionService } = require('../apps/api/dist/datasource/suggestion.service.js');
const { parseSuggestionTexts, ENRICHMENT_PROMPT } = require('../packages/llm/dist/index.js');
const suggestion = { column: 'amount', suggestedComment: '金额字段', basis: 'original_metadata', needsVerification: ['金额单位'] };
assert.deepEqual(parseEnrichments(JSON.stringify([suggestion]), ['amount']), [suggestion]);
for (const invalid of [[{ ...suggestion, column: 'other' }], [suggestion, suggestion], [{ ...suggestion, suggestedComment: null }], [{ ...suggestion, extra: true }]]) {
    assert.throws(() => parseEnrichments(JSON.stringify(invalid), ['amount']));
}
assert.throws(() => validateCommentChanges([{ column: 'amount', originalComment: '', comment: '' }]));
assert.throws(() => validateCommentChanges([{ column: 'amount', originalComment: '', comment: 'x'.repeat(1001) }]));
assert.deepEqual(parseSuggestionTexts('[" 重复 ","重复","","其他"]'), ['重复', '其他']);
assert.deepEqual(parseSuggestionTexts('[]'), []);
assert.throws(() => parseSuggestionTexts('["有效",42]'));
assert.throws(() => parseSuggestionTexts('prefix ["有效"]'));
function fixture() {
    let columns = [
        { name: 'amount', type: 'numeric', comment: '' },
        { name: 'status', type: 'text', comment: '订单状态' },
    ];
    const writes = [],
        invalidations = [],
        requests = [];
    let permitted = true,
        failSecond = false;
    const db = {
        withTransaction: async (fn) => {
            const draft = structuredClone(columns);
            let updates = 0;
            const tx = {
                query: async (sql, params) => {
                    if (sql.includes('FROM datasource_table_catalog')) {
                        assert.deepEqual(params.slice(2), [10, 1]);
                        return [[{ schema_name: 'public', table_name: 'orders', created_by: permitted ? 7 : 9, owner: 9, accessible: true }]];
                    }
                    if (sql.includes('FROM pg_class')) return [structuredClone(draft)];
                    if (sql.includes('datasource_column_policy')) return [[{ column_name: 'status' }]];
                    if (sql.startsWith('SELECT LEFT')) {
                        assert.ok(!sql.includes('"status"'));
                        return [[{ amount: '100' }]];
                    }
                    if (sql.startsWith('SELECT format')) return [[{ statement: JSON.stringify(params) }]];
                    throw new Error(`Unexpected query ${sql}`);
                },
                queryNative: async (sql) => {
                    assert.ok(!sql.includes('"status"'));
                    return [[{ amount: '100' }]];
                },
                execute: async (sql) => {
                    writes.push(sql);
                    return [{ rowCount: 1 }];
                },
                executeNative: async (sql) => {
                    if (sql.startsWith('LOCK TABLE')) {
                        writes.push(sql);
                        return { rowCount: 0 };
                    }
                    if (failSecond && ++updates === 2) throw new Error('database error');
                    const [schema, table, name, comment] = JSON.parse(sql);
                    assert.equal(schema, 'public');
                    assert.equal(table, 'orders');
                    draft.find((c) => c.name === name).comment = comment;
                    writes.push('COMMENT');
                    return { rowCount: 1 };
                },
            };
            const result = await fn(tx);
            columns = draft;
            return result;
        },
    };
    const service = new SchemaEnrichmentService(
        db,
        {
            chat: async (system, data) => {
                requests.push({ system, data: JSON.parse(data) });
                return JSON.stringify([suggestion]);
            },
        },
        { clearDatasourceCache: (id) => invalidations.push(id) }
    );
    return { service, writes, requests, invalidations, columns: () => columns, revoke: () => (permitted = false), fail: () => (failSecond = true) };
}
{
    const h = fixture();
    await h.service.inspect(1, 10, 7);
    const generated = await h.service.generate(1, 10, 7, ['amount', 'status']);
    assert.equal(generated.prompt.version, 'schema-enrichment-v2');
    assert.equal(h.columns()[0].comment, '');
    assert.deepEqual(h.writes, []);
    assert.equal(h.requests[0].system, ENRICHMENT_PROMPT);
    await assert.rejects(() => h.service.generate(1, 10, 7, ['missing']));
    const saved = await h.service.save(1, 10, 7, [{ column: 'amount', originalComment: '', comment: "金额（元）?'\\" }]);
    assert.equal(saved[0].comment, "金额（元）?'\\");
    assert.ok(h.writes[0].startsWith('LOCK TABLE'));
    assert.ok(h.writes.some((s) => s.startsWith('DELETE FROM datasource_suggestions')));
    assert.deepEqual(h.invalidations, [1]);
    await assert.rejects(
        () => h.service.save(1, 10, 7, [{ column: 'amount', originalComment: '', comment: 'stale overwrite' }]),
        (e) => e.getStatus() === 409
    );
    assert.equal(h.columns()[0].comment, "金额（元）?'\\");
    h.revoke();
    await assert.rejects(
        () => h.service.inspect(1, 10, 7),
        (e) => e.getStatus() === 403
    );
    await assert.rejects(
        () => h.service.generate(1, 10, 7, ['amount']),
        (e) => e.getStatus() === 403
    );
    await assert.rejects(
        () => h.service.save(1, 10, 7, [{ column: 'amount', originalComment: '', comment: 'x' }]),
        (e) => e.getStatus() === 403
    );
}
{
    const h = fixture();
    h.fail();
    await assert.rejects(() =>
        h.service.save(1, 10, 7, [
            { column: 'amount', originalComment: '', comment: '金额' },
            { column: 'status', originalComment: '订单状态', comment: '状态' },
        ])
    );
    assert.equal(h.columns()[0].comment, '');
    assert.equal(h.columns()[1].comment, '订单状态');
    assert.deepEqual(h.invalidations, []);
}
{
    let calls = 0,
        cached,
        schema = [],
        accessible = true;
    const db = {
        query: async (sql) => (sql.includes('FROM data_source d') ? (accessible ? [{ id: 1 }] : []) : cached ? [{ questions: cached }] : []),
        execute: async (_sql, params) => {
            cached = JSON.parse(params[2]);
        },
    };
    const service = new SuggestionService(
        db,
        { getStructuredSchema: async () => schema },
        {
            chat: async () => {
                calls++;
                return '["当前库存有多少？"]';
            },
        }
    );
    assert.deepEqual(await service.getSuggestions(1, 7), []);
    assert.equal(calls, 0);
    schema = [{ tableName: 'stock', columns: [{ name: 'quantity', comment: '库存数量' }] }];
    await service.getSuggestions(1, 7);
    await service.getSuggestions(1, 7);
    assert.equal(calls, 1);
    await service.getSuggestions(1, 7, 'en');
    assert.equal(calls, 2);
    schema[0].columns[0].comment = '可售库存';
    await service.getSuggestions(1, 7, 'en');
    assert.equal(calls, 3);
    accessible = false;
    await assert.rejects(
        () => service.getSuggestions(1, 7),
        (e) => e.getStatus() === 403
    );
}
console.log('PASS schema enrichment: explicit generation, strict output, restricted samples, ownership, optimistic conflicts, atomic save and suggestion cache identity');

// Verify native PostgreSQL statements preserve literal question marks, unlike the placeholder adapter.
const { TransactionConnection } = require('../packages/database/dist/index.js');
const statements = [];
const tx = new TransactionConnection({
    query: async (sql) => {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
    },
});
await tx.executeNative(`COMMENT ON COLUMN "table"."field" IS 'what?''s'`);
await tx.queryNative('SELECT "field?" FROM "table?" LIMIT 5');
assert.equal(statements[0], `COMMENT ON COLUMN "table"."field" IS 'what?''s'`);
assert.equal(statements[1], 'SELECT "field?" FROM "table?" LIMIT 5');
