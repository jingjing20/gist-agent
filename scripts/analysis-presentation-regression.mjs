import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { AnalysisArtifactController } = require('../apps/api/dist/analysis-artifact/analysis-artifact.module.js');
const fingerprint = createHash('sha256')
    .update(JSON.stringify({ policies: [], tables: ['events'] }))
    .digest('hex');
const row = {
    id: '11111111-1111-4111-8111-111111111111',
    datasource_id: 1,
    analysis_context: { accessFingerprint: fingerprint },
    result_rows: Array.from({ length: 125 }, (_, i) => ({ i })),
    columns_json: [{ name: 'i', type: 'number' }],
};
let authorized = true;
const db = {
    query: async (sql, params) => {
        if (sql.includes('SELECT a.*')) {
            assert.deepEqual(params, [row.id, 7, '22222222-2222-4222-8222-222222222222', 7, 7]);
            assert.match(sql, /expires_at>NOW/);
            assert.match(sql, /datasource_permission/);
            return authorized ? [row] : [];
        }
        if (sql.includes('FROM datasource_table_catalog')) return [{ table_name: 'events' }];
        if (sql.includes('FROM datasource_column_policy')) return [];
        throw new Error(`Unexpected SQL: ${sql}`);
    },
};
const api = new AnalysisArtifactController(db),
    user = { id: 7 };
const metadata = await api.metadata(user, row.id, '22222222-2222-4222-8222-222222222222');
assert.equal(metadata.result_rows, undefined);
const first = await api.rows(user, row.id, '22222222-2222-4222-8222-222222222222', undefined, '100');
assert.equal(first.rows.length, 100);
assert.equal(first.nextCursor, '100');
const last = await api.rows(user, row.id, '22222222-2222-4222-8222-222222222222', '100', '100');
assert.equal(last.rows.length, 25);
assert.equal(last.nextCursor, null);
for (const limit of ['101', '0', '1.5', 'x', ''])
    await assert.rejects(
        () => api.rows(user, row.id, '22222222-2222-4222-8222-222222222222', '0', limit),
        (e) => e.status === 400
    );
for (const cursor of ['-1', '1.5', '9007199254740992'])
    await assert.rejects(
        () => api.rows(user, row.id, '22222222-2222-4222-8222-222222222222', cursor),
        (e) => e.status === 400
    );
authorized = false;
await assert.rejects(
    () => api.metadata(user, row.id, '22222222-2222-4222-8222-222222222222'),
    (e) => e.status === 404
);
await assert.rejects(
    () => api.rows(user, row.id, '22222222-2222-4222-8222-222222222222'),
    (e) => e.status === 404
);
authorized = true;
row.analysis_context.accessFingerprint = 'changed';
await assert.rejects(
    () => api.metadata(user, row.id, '22222222-2222-4222-8222-222222222222'),
    (e) => e.status === 409
);
await assert.rejects(
    () => api.rows(user, row.id, '22222222-2222-4222-8222-222222222222'),
    (e) => e.status === 409
);
delete row.analysis_context;
await assert.rejects(
    () => api.metadata(user, row.id, '22222222-2222-4222-8222-222222222222'),
    (e) => e.status === 409
);
console.log('PASS S4 evidence metadata, pagination, authorization and permission snapshot checks (mock; no database/model/UI)');
const { readFileSync } = await import('node:fs');
const read = (file) => JSON.parse(readFileSync(new URL(`../benchmarks/saas-growth/${file}`, import.meta.url), 'utf8'));
const cases = read('agent-core-cases.json'),
    acceptance = read('s4-acceptance.json'),
    reference = read('cases.json');
assert.equal(acceptance.cases.length, 10);
assert.deepEqual(
    acceptance.cases.map((c) => c.id),
    cases.cases.map((c) => c.id)
);
for (const c of acceptance.cases) {
    const input = cases.cases.find((x) => x.id === c.id);
    assert.ok(input.messages.length && input.must.length && input.must_not.length);
    for (const id of c.reference_case_ids)
        assert.ok(
            reference.cases.some((r) => r.id === id),
            `Missing reference ${id}`
        );
    for (const variant of ['baseline', 'new_core']) assert.ok(['not_run', 'pass', 'fail', 'needs-review'].includes(c[variant].status));
}
console.log('PASS S4 C01–C10 acceptance records and reference integrity; semantic results remain independently recorded');
