import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cloneAnalysisActivity } from '../apps/web/src/utils/analysis-activity.js';
const require = createRequire(import.meta.url);
const { startActivity, completeActivity } = require('../apps/worker/dist/analysis/analysis-activity.js');
const { assessResultQuality } = require('../apps/worker/dist/chat/result-quality.js');
const { SqlExecutorAgent } = require('../apps/worker/dist/chat/agents/sql-executor.js');
const { SqlQueryTool } = require('../apps/worker/dist/chat/tools/sql-query.tool.js');
const { ArtifactRepository } = require('../apps/worker/dist/chat/artifact.repository.js');
const { GenerationExecutionError } = require('../apps/worker/dist/chat/generation-errors.js');
const { ANALYSIS_RUNTIME_VERSIONS } = require('../packages/contracts/dist/index.js');
let checks = 0;
const check = async (name, fn) => {
    await fn();
    checks++;
    console.log(`PASS ${name}`);
};
await check('structured activities snapshot mechanical execution facts', async () => {
    const started = startActivity(
        'activity-1',
        'execute_sql_query',
        { title: '核对账单范围', sql: 'SELECT status FROM billing_records', plan: { purpose: '确认账单状态分布', expectedGrain: '每种状态一行' } },
        new Date('2026-09-22T00:00:00.000Z')
    );
    assert.equal(started.kind, 'query_data');
    assert.equal(started.status, 'running');
    const completed = completeActivity(
        started,
        'execute_sql_query',
        { sql: 'SELECT status FROM billing_records' },
        { queryArtifactId: 'artifact-1', returnedRowCount: 3, columns: [{ name: 'status' }], isLimited: false },
        { executedSql: 'SELECT status FROM billing_records LIMIT 1000', sourceTables: ['billing_records'], sourceFields: ['status'] },
        new Date('2026-09-22T00:00:01.200Z')
    );
    assert.equal(completed.status, 'completed');
    assert.equal(completed.durationMs, 1200);
    assert.equal(completed.query.artifactId, 'artifact-1');
    assert.equal(completed.query.adjusted, true);
    assert.deepEqual(completed.details.find((item) => item.label === '数据来源').value, ['billing_records']);
    assert.deepEqual(completed.details.find((item) => item.label === '使用字段').value, ['status']);
});

await check('informational quality notices do not turn completed analysis yellow', async () => {
    const quality = assessResultQuality({
        plan: { purpose: '核对注册时间', expectedGrain: '单行汇总', expectedShape: 'scalar' },
        sql: 'SELECT MIN(signup_at) AS min_signup FROM product_users',
        columns: [{ name: 'signup_at', type: 'date' }],
        rows: [{ signup_at: '2026-09-15T11:45:17.000Z' }],
        isLimited: false,
    });
    assert.equal(quality.warnings[0].severity, 'info');
    assert.equal(quality.warnings[0].message, '时间范围按 UTC 解释：2026-09-15 11:45:17 至 2026-09-15 11:45:17');

    const started = startActivity(
        'activity-timezone-info',
        'execute_sql_query',
        {
            title: '核对注册时间',
            sql: 'SELECT MIN(signup_at) AS min_signup FROM product_users',
            plan: { purpose: '核对注册时间', expectedGrain: '单行汇总', expectedShape: 'scalar' },
        },
        new Date('2026-09-22T00:00:00.000Z')
    );
    const completed = completeActivity(
        started,
        'execute_sql_query',
        { sql: 'SELECT MIN(signup_at) AS min_signup FROM product_users' },
        { returnedRowCount: 1, columns: [{ name: 'min_signup' }], resultQuality: quality },
        undefined,
        new Date('2026-09-22T00:00:00.065Z')
    );
    assert.equal(completed.status, 'completed');
    assert.equal(completed.warning, undefined);
    assert.deepEqual(completed.qualityMessages, [
        {
            severity: 'info',
            message: quality.warnings[0].message,
            action: quality.warnings[0].action,
        },
    ]);
});

await check('activity snapshots can be copied from reactive proxy inputs', async () => {
    const activity = new Proxy(
        {
            version: 1,
            id: 'activity-proxy',
            groupId: 'group-1',
            kind: 'inspect_schema',
            status: 'completed',
            label: '读取表结构',
            details: [{ label: '数据表', value: ['invoices'] }],
            startedAt: '2026-09-22T00:00:00.000Z',
        },
        {}
    );
    assert.throws(() => structuredClone(activity), /could not be cloned/);
    const copied = cloneAnalysisActivity(activity);
    assert.deepEqual(copied.details[0].value, ['invoices']);
    assert.notEqual(copied, activity);
    assert.notEqual(copied.details, activity.details);
});

await check('activity snapshots tolerate malformed in-flight details', async () => {
    for (const details of [undefined, { label: '错误形状', value: 'x' }]) {
        const copied = cloneAnalysisActivity({ id: 'activity-in-flight', details });
        assert.deepEqual(copied.details, []);
    }
});

await check('new SQL execution disables nested model repair', async () => {
    let dbCalls = 0;
    const executor = new SqlExecutorAgent(
        {
            queryReadOnlyWithFields: async () => {
                dbCalls++;
                throw Object.assign(new Error('syntax'), { code: '42601' });
            },
        },
        { getAllowedTableNames: async () => ['t'], getColumnPolicies: async () => [] }
    );
    executor.logger = { error() {}, warn() {}, log() {} };
    await assert.rejects(executor.execute('SELECT 1', 1, 1, new AbortController().signal));
    assert.equal(dbCalls, 1);
    assert.equal(typeof executor.attemptFixSql, 'undefined');
});
await check('SQL adapter sanitizes recoverable errors and propagates security', async () => {
    const ctx = { analysisCore: true, assertWritable: async () => {}, signal: new AbortController().signal, emitter: { send() {} } };
    const t = new SqlQueryTool(
        {
            execute: async () => {
                throw Object.assign(new Error('private database details'), { code: '42703' });
            },
        },
        {}
    );
    const output = await t.execute({ sql: 'SELECT bad', title: '查询' }, ctx);
    assert.equal(output.succeeded, false);
    assert.ok(!output.toolResult.includes('private'));
    t.sqlExecutor.execute = async () => {
        throw new GenerationExecutionError('SQL_SECURITY_REJECTED', 'private details');
    };
    await assert.rejects(t.execute({ sql: 'DELETE', title: '查询' }, ctx), { code: 'SQL_SECURITY_REJECTED' });
});
await check('evidence write fence locks generation and prevents terminal writes', async () => {
    const statements = [];
    const db = {
        withTransaction: async (fn) =>
            fn({
                query: async (sql) => {
                    statements.push(sql);
                    return [[]];
                },
            }),
    };
    const repo = new ArtifactRepository(db);
    await assert.rejects(repo.writeArtifact({ generationId: 'g', conversationId: 'c', userId: 1, writerToken: 'w' }, 'INSERT evidence', []), { code: 'WRITER_OWNERSHIP_LOST' });
    assert.equal(statements.length, 1);
    assert.match(statements[0], /FOR UPDATE/);
    db.withTransaction = async (fn) =>
        fn({
            query: async (sql) => {
                statements.push(sql);
                return [[{ ok: true }]];
            },
        });
    assert.deepEqual(await repo.writeArtifact({ generationId: 'g', conversationId: 'c', userId: 1, writerToken: 'w' }, 'INSERT evidence', []), [{ ok: true }]);
    assert.equal(statements.at(-1), 'INSERT evidence');
});
await check('SQL tool always persists evidence', async () => {
    let persisted, executionOptions;
    const tool = new SqlQueryTool(
        {
            execute: async (...args) => {
                executionOptions = args[4];
                return { finalSql: 'SELECT 1', wasFixed: false, rows: [{ n: 1 }], columns: [{ name: 'n', type: 'number' }], rowCount: 1, isLimited: false };
            },
        },
        {
            createQueryArtifact: async (input) => {
                persisted = input;
                return { id: 'persisted', resultContentHash: 'hash' };
            },
        }
    );
    const result = await tool.execute(
        { title: '核对', sql: 'SELECT 1', plan: { purpose: '核对', expectedGrain: '一行', expectedShape: 'scalar' } },
        {
            writerToken: 'writer',
            generationId: 'g',
            conversationId: 'c',
            userId: 1,
            datasourceId: 1,
            schemaContextVersion: 'v',
            signal: new AbortController().signal,
            assertWritable: async () => {},
            emitter: { send() {} },
        }
    );
    assert.equal(JSON.parse(result.toolResult).queryArtifactId, 'persisted');
    assert.equal(persisted.writerToken, 'writer');
    assert.equal(executionOptions, undefined);
});
await check('generation creation always stamps the sole runtime before enqueue', async () => {
    const { GenerationService } = require('../apps/api/dist/chat/generation.service.js');
    const service = Object.create(GenerationService.prototype); // No Redis connection in this test.
    const writes = [];
    service.db = {
        withTransaction: async (fn) =>
            fn({
                query: async (sql) => {
                    if (sql.includes('SELECT datasource_id')) return [[{ datasource_id: 1 }]];
                    if (sql.includes('COUNT(*)')) return [[{ count: 0 }]];
                    if (sql.includes('clock_timestamp')) return [[{ context_upper_bound: '2026-09-15T00:00:00Z' }]];
                    return [[]];
                },
                execute: async (sql, params) => {
                    writes.push({ sql, params });
                    return [{ rowCount: 1 }];
                },
            }),
    };
    await service.createTurn(1, 'c', 'question', 1, 'key', 'hash', false);
    const insert = writes.find((w) => w.sql.includes('INSERT INTO generation'));
    for (const version of Object.values(ANALYSIS_RUNTIME_VERSIONS)) assert.ok(insert.params.includes(version));
    assert.ok(writes.findIndex((w) => w.sql.includes('outbox_event')) > writes.indexOf(insert));
});
console.log(`analysis core regression: ${checks} groups PASS (mock only, no external services)`);

await import('./prompt-runtime-regression.mjs');
