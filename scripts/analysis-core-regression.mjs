import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cloneAnalysisActivity } from '../apps/web/src/utils/analysis-activity.js';
const require = createRequire(import.meta.url);
const { AnalysisAgent } = require('../apps/worker/dist/analysis/analysis-agent.js');
const { validateSubmission } = require('../apps/worker/dist/analysis/submission.js');
const { AnalysisRuntimeAdapter, requestedPresentation, assertRequestedPresentation } = require('../apps/worker/dist/analysis/analysis-runtime-adapter.js');
const { startActivity, completeActivity } = require('../apps/worker/dist/analysis/analysis-activity.js');
const { assessResultQuality } = require('../apps/worker/dist/chat/result-quality.js');
const { SqlExecutorAgent } = require('../apps/worker/dist/chat/agents/sql-executor.js');
const { SqlQueryTool } = require('../apps/worker/dist/chat/tools/sql-query.tool.js');
const { ArtifactRepository } = require('../apps/worker/dist/chat/artifact.repository.js');
const { GenerationExecutionError } = require('../apps/worker/dist/chat/generation-errors.js');
const { ChatService } = require('../apps/worker/dist/chat/chat.service.js');
const { ANALYSIS_RUNTIME_VERSIONS } = require('../packages/contracts/dist/index.js');
let checks = 0;
const check = async (name, fn) => {
    await fn();
    checks++;
    console.log(`PASS ${name}`);
};
let id = 0;
const call = (name, args) => ({ id: `call-${++id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const query = (sql = 'SELECT 1') => call('execute_sql_query', { title: '核对数据', sql, plan: { purpose: '核对', expectedGrain: '一行', expectedShape: 'scalar' } });
const answer = (kind = 'answer', findings = []) => ({
    kind,
    ...(kind === 'partial' ? { reason: '查询预算已用完' } : {}),
    answer: { summary: '分析结果', findings, limitations: kind === 'partial' ? ['尚未完成验证'] : [], unresolvedQuestions: [] },
});
const observation = (artifactId) => ({ id: 'f1', text: '查询返回一条结果', kind: 'observation', evidence: [{ artifactId, role: 'observation' }] });
const stream = (calls) =>
    (async function* () {
        for (let index = 0; index < calls.length; index++) {
            const c = calls[index];
            yield { choices: [{ delta: { tool_calls: [{ index, id: c.id, function: { name: c.function.name, arguments: c.function.arguments.slice(0, 5) } }] } }] };
            yield { choices: [{ delta: { tool_calls: [{ index, function: { arguments: c.function.arguments.slice(5) } }] } }] };
        }
    })();
function harness(responses, extras = {}) {
    const executions = [],
        seen = [],
        events = [],
        reports = [],
        messages = [],
        turnMessages = [];
    const controller = new AbortController();
    const sql = {
        name: 'execute_sql_query',
        definition: { type: 'function', function: { name: 'execute_sql_query', parameters: { type: 'object', properties: { title: {}, sql: {}, plan: {} } } } },
        parseArguments: (v) => v,
        execute: async (args) => {
            executions.push(args.sql);
            return { succeeded: true, blocks: [], toolResult: JSON.stringify({ queryArtifactId: `a${executions.length}`, isLimited: false, data: [{ n: 1 }] }) };
        },
    };
    const options = {
        messages,
        turnMessages,
        tools: [sql],
        context: { signal: controller.signal, assertWritable: async () => {}, emitter: { send: (e) => events.push(e) } },
        metrics: { llmCallCount: 0, toolCallCount: 0, sqlCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 },
        capability: { contextWindow: 100000, responseReserve: 1000 },
        stream: async (history, definitions) => {
            seen.push({ history: structuredClone(history), names: definitions.map((t) => t.function.name) });
            assert.ok(responses.length, 'Mock responses exhausted');
            const next = responses.shift();
            return typeof next === 'function' ? next() : stream(next);
        },
        onEvent: (e) => events.push(e),
        checkpoint: async () => {},
        onFirstDelta: async () => {},
        onContext: (r) => reports.push(r),
        ...extras,
    };
    return { options, sql, controller, executions, seen, events, messages, turnMessages, reports, run: () => new AnalysisAgent().run(options) };
}

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

await check('submission can correct a chart id mistaken for query evidence', async () => {
    const invalid = answer('partial', [observation('chart-id')]);
    const valid = answer('partial', [observation('a1')]);
    const h = harness([[query()], [call('submit_analysis', invalid)], [call('submit_analysis', valid)]]);
    assert.equal((await h.run()).kind, 'partial');
    assert.match(h.turnMessages.find((message) => message.role === 'tool' && String(message.content).includes('INVALID_TOOL_ARGUMENTS')).content, /查询证据/);
});

await check('direct answer and clarification without SQL', async () => {
    for (const outcome of [answer(), { kind: 'clarification', question: '使用哪个观察截止日期？' }]) {
        const h = harness([[call('submit_analysis', outcome)]]);
        assert.equal((await h.run()).kind, outcome.kind);
        assert.equal(h.executions.length, 0);
        assert.equal(h.turnMessages.at(-1).role, 'tool');
    }
});
await check('query, independent verification, structured evidence answer', async () => {
    const finding = {
        id: 'f',
        text: '解释得到支持',
        kind: 'supported_explanation',
        evidence: [
            { artifactId: 'a1', role: 'observation' },
            { artifactId: 'a2', role: 'verification' },
        ],
    };
    const h = harness([[query()], [query('SELECT 2')], [call('submit_analysis', answer('answer', [finding]))]]);
    assert.equal((await h.run()).kind, 'answer');
    assert.deepEqual(h.executions, ['SELECT 1', 'SELECT 2']);
    assert.equal(h.reports.length, 3);
    const activities = h.events.filter((event) => event.type === 'analysis_activity');
    assert.equal(activities.length, 4);
    assert.deepEqual(
        activities.map((event) => event.activity.status),
        ['running', 'completed', 'running', 'completed']
    );
    assert.deepEqual(
        h.turnMessages.map((m) => m.role),
        ['assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool']
    );
});
await check('fabricated and blocked evidence cannot support findings', async () => {
    assert.throws(() => validateSubmission(answer('answer', [observation('fake')]), new Map(), false), /本轮/);
    assert.throws(() => validateSubmission(answer('answer', [observation('a')]), new Map([['a', { blocked: true, sql: 'SELECT 1' }]]), false), /质量/);
    const f = { ...observation('a'), kind: 'supported_explanation' };
    assert.throws(() => validateSubmission(answer('answer', [f]), new Map([['a', { blocked: false, sql: 'SELECT 1' }]]), false), /验证/);
});
await check('key metrics must point to an evidenced finding', async () => {
    const evidence = new Map([['a1', { blocked: false, sql: 'SELECT 1' }]]);
    const valid = { ...answer('answer', [observation('a1')]), answer: { ...answer('answer', [observation('a1')]).answer,
        summary: '收入上升。', keyPoints: ['期末高于期初'], metrics: [{ label: '期末收入', value: '59.6 万元', findingId: 'f1' }] } };
    assert.equal(validateSubmission(valid, evidence).answer.metrics[0].value, '59.6 万元');
    assert.throws(() => validateSubmission({ ...valid, answer: { ...valid.answer, metrics: [{ label: '收入', value: '59.6 万元', findingId: 'missing' }] } }, evidence), /已证实/);
    assert.throws(() => validateSubmission({ ...valid, answer: { ...valid.answer, keyPoints: ['重复', '重复'] } }, evidence), /不能重复/);
});
await check('table-only answer references observed query rows without report fields', async () => {
    const h = harness([[query('SELECT region, amount FROM revenue')], [call('submit_analysis', { kind: 'table', tables: [{ artifactId: 'a1', title: '地区明细' }] })]]);
    const outcome = await h.run();
    assert.deepEqual(outcome, { kind: 'table', tables: [{ artifactId: 'a1', title: '地区明细' }] });
    assert.throws(() => validateSubmission({ kind: 'table', tables: [{ artifactId: 'unknown' }] }, new Map()), /不是本轮已观察/);
    assert.throws(() => validateSubmission({ kind: 'table', tables: [{ artifactId: 'a1' }] }, new Map([['a1', { blocked: true, sql: 'SELECT 1' }]])), /质量受限/);
});
await check('explicit user output preference wins over the default report', async () => {
    assert.equal(requestedPresentation('帮我查下北区详细的数据，以表格给我就行'), 'table');
    assert.equal(requestedPresentation('只要一句话告诉我结果'), 'direct');
    assert.equal(requestedPresentation('不要表格，给我解释原因'), null);
    assert.equal(requestedPresentation('用表格展示数据并解释原因'), null);
    const tableResponse = { kind: 'response', status: 'complete', blocks: [{ type: 'table', artifactId: 'a1' }] };
    assert.throws(() => assertRequestedPresentation('以表格给我就行', answer()), /只用表格/);
    assert.doesNotThrow(() => assertRequestedPresentation('以表格给我就行', tableResponse));
    assert.throws(() => assertRequestedPresentation('以表格给我就行', { ...tableResponse, blocks: [...tableResponse.blocks, { type: 'markdown', content: '总结', evidence: [] }] }), /只用表格/);
    const h = harness([[query()], [call('submit_analysis', { kind: 'response', status: 'complete', blocks: [{ type: 'markdown', content: '北区收入为 8 万元。', evidence: ['a1'] }] })]]);
    assert.equal((await h.run()).kind, 'response');
});
await check('ordered response blocks validate table and chart references', async () => {
    const evidence = new Map([['a1', { blocked: false, sql: 'SELECT 1' }]]);
    const charts = new Map([['c1', 'a1']]);
    const response = { kind: 'response', status: 'complete', blocks: [
        { type: 'markdown', content: '北区明细如下。', evidence: ['a1'] },
        { type: 'table', artifactId: 'a1' },
        { type: 'chart', chartArtifactId: 'c1' },
    ] };
    assert.deepEqual(validateSubmission(response, evidence, charts).blocks.map((block) => block.type), ['markdown', 'table', 'chart']);
    assert.throws(() => validateSubmission(response, evidence), /不是本轮已生成/);
    assert.throws(() => validateSubmission({ ...response, blocks: [{ type: 'table', artifactId: 'missing' }] }, evidence, charts), /不是本轮已观察/);
    assert.throws(() => validateSubmission({ ...response, blocks: [{ type: 'markdown', content: '收入增长。', evidence: [] }] }, evidence, charts), /至少需要引用/);
});
await check('malformed arguments return paired feedback, no side effect', async () => {
    const bad = query();
    bad.function.arguments = '{';
    const h = harness([[bad], [call('submit_analysis', { kind: 'clarification', question: '请明确口径' })]]);
    await h.run();
    assert.equal(h.executions.length, 0);
    assert.match(h.turnMessages[1].content, /INVALID_TOOL_ARGUMENTS/);
});
await check('SQL failure is repaired by the main loop', async () => {
    const h = harness([[query('SELECT bad')], [query('SELECT 1')], [call('submit_analysis', answer('answer', [observation('a1')]))]]);
    const execute = h.sql.execute;
    h.sql.execute = async (args) =>
        args.sql.includes('bad') ? { succeeded: false, toolResult: JSON.stringify({ errorCode: '42703', retryable: true }), blocks: [] } : execute(args);
    await h.run();
    assert.deepEqual(h.executions, ['SELECT 1']);
    assert.equal(h.options.metrics.sqlCallCount, 2);
    assert.match(h.seen[1].history.at(-1).content, /42703/);
    assert.equal(h.events.filter((event) => event.type === 'analysis_activity_remove').length, 1);
    assert.deepEqual(
        h.events.filter((event) => event.type === 'analysis_activity').map((event) => event.activity.status),
        ['running', 'running', 'completed']
    );
});
await check('repeated failing query stops without executing a third time', async () => {
    const h = harness([[query()], [query()], [query()]]);
    let attempts = 0;
    h.sql.execute = async () => {
        attempts++;
        return { succeeded: false, toolResult: '{"errorCode":"42703"}', blocks: [] };
    };
    await assert.rejects(h.run(), { code: 'ANALYSIS_NO_PROGRESS' });
    assert.equal(attempts, 2);
});
await check('analysis can continue past the former SQL budget and finish', async () => {
    const responses = Array.from({ length: 9 }, (_, i) => [query(`SELECT ${i + 1}`)]);
    responses.push([call('submit_analysis', answer('answer', [observation('a9')]))]);
    const h = harness(responses);
    assert.equal((await h.run()).kind, 'answer');
    assert.equal(h.executions.length, 9);
    assert.ok(h.seen.every((turn) => turn.names.includes('execute_sql_query')));
});
await check('mixed final submission batch executes no tools', async () => {
    const h = harness([[query(), call('submit_analysis', answer())], [call('submit_analysis', answer())]]);
    await h.run();
    assert.equal(h.executions.length, 0);
    assert.equal(h.turnMessages[1].role, 'tool');
    assert.equal(h.turnMessages[2].role, 'tool');
});
await check('security rejection stops the batch and closes tool references', async () => {
    const h = harness([[query(), query('SELECT 2')]]);
    let attempts = 0;
    h.sql.execute = async () => {
        attempts++;
        throw new GenerationExecutionError('SQL_SECURITY_REJECTED', 'denied');
    };
    assert.equal((await h.run()).kind, 'refusal');
    assert.equal(attempts, 1);
    assert.equal(h.turnMessages.length, 3);
});
await check('pre-cancel and mid-tool cancel prevent further model calls', async () => {
    const h = harness([]);
    h.controller.abort(new GenerationExecutionError('CANCELLED', 'cancelled'));
    await assert.rejects(h.run(), { code: 'CANCELLED' });
    assert.equal(h.seen.length, 0);
    const m = harness([[query()]]);
    m.sql.execute = async () => {
        m.controller.abort(new GenerationExecutionError('CANCELLED', 'cancelled'));
        return { toolResult: '{}', blocks: [] };
    };
    await assert.rejects(m.run(), { code: 'CANCELLED' });
    assert.equal(m.seen.length, 1);
});
await check('empty output, repeated unstructured text and context overflow fail explicitly', async () => {
    await assert.rejects(harness([[]]).run(), { code: 'EMPTY_LLM_RESPONSE' });
    const textOnly = () =>
        (async function* () {
            yield { choices: [{ delta: { content: 'unsubmitted' } }] };
        })();
    await assert.rejects(harness([textOnly, textOnly, textOnly]).run(), { code: 'ANALYSIS_NO_PROGRESS' });
    const h = harness([], { capability: { contextWindow: 10, responseReserve: 5 } });
    await assert.rejects(h.run(), { code: 'CONTEXT_BUDGET_EXCEEDED' });
    assert.equal(h.seen.length, 0);
});
await check('tool dependency failures are not exposed as model argument errors', async () => {
    const h = harness([[query()]]);
    h.sql.execute = async () => {
        throw new Error('private connection information');
    };
    await assert.rejects(h.run(), (e) => e.code === 'TOOL_EXECUTION_FAILED' && !e.message.includes('private'));
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
await check('runtime adapter persists snapshot and structured result in existing blocks', async () => {
    const events = [],
        blocks = [],
        turnMessages = [];
    const adapter = new AnalysisRuntimeAdapter(
        { assertDatasourceAccess: async () => {}, getSchemaCatalogSummary: async () => ({ datasourceId: 1, tables: [] }), getStructuredSchema: async () => [] },
        { isReasoningActive: () => false, streamWithTools: async () => stream([call('submit_analysis', { kind: 'clarification', question: '请提供口径' })]) },
        { name: 'execute_sql_query', definition: { type: 'function', function: { name: 'execute_sql_query', parameters: {} } } },
        { name: 'generate_chart', definition: { type: 'function', function: { name: 'generate_chart', parameters: {} } } },
        { listAnalysisEvidence: async () => ({ items: [], nextOffset: null }) },
        {
            query: async () => [],
            withTransaction: async (fn) =>
                fn({
                    query: async (sql) => [
                        sql.includes('FROM data_source d') || sql.includes('SELECT id FROM generation')
                            ? [{ id: 1 }]
                            : sql.includes('SELECT d.id')
                              ? [
                                    {
                                        id: 'stored-definition',
                                        datasource_id: 1,
                                        version: 3,
                                        current_status: 'active',
                                        status: 'active',
                                        source: 'manual',
                                        content: { type: 'term', name: '已确认口径', description: '来自数据库' },
                                    },
                                ]
                              : [],
                    ],
                    execute: async () => [{ rowCount: 1 }],
                }),
        }
    );
    await adapter.run({
        generation: { id: 'g', datasourceId: 1, userId: 1, requestMessageId: 'r', conversationId: 'c', contextUpperBound: '2026-09-15T00:00:00Z', writerToken: 'w' },
        message: '激活率',
        signal: new AbortController().signal,
        emitter: { send: (e) => events.push(e) },
        blocks,
        turnMessages,
        metrics: { llmCallCount: 0, toolCallCount: 0, sqlCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 },
        assertWritable: async () => {},
        checkpoint: async () => {},
        onFirstDelta: async () => {},
    });
    assert.equal(blocks.at(-1).analysis.snapshot.datasourceId, 1);
    assert.deepEqual(blocks.at(-1).analysis.snapshot.definitionRefs, []);
    assert.equal(blocks.at(-1).analysis.contextReports[0].snapshot.promptPolicy, 'analysis-core-v2');
    assert.ok(blocks.at(-1).analysis.contextReports[0].selection.some((c) => c.candidateId === 'catalogs' && c.selected));
    assert.equal(blocks.at(-1).analysis.outcome.kind, 'clarification');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'log');
    assert.equal(blocks[0].title, '分析步骤 1');
    assert.match(blocks[0].content, /^已完成/);
    assert.ok(events.some((e) => e.type === 'log'));
    assert.equal(events.at(-1).content, blocks.at(-1).content);
});
await check('generation selects persisted core and does not call legacy prompt or distiller', async () => {
    let ran = 0,
        finalized;
    const unexpected = () => {
        throw new Error('legacy must not run');
    };
    const generations = {
        emitter: () => ({ send() {} }),
        isCancelRequested: async () => false,
        assertWritable: async () => {},
        checkpointMessage: async () => {},
        markFirstDelta: async () => {},
        recordExecutionMetrics: async () => {},
        recordSpan: async () => {},
        drain: async () => {},
        finalize: async (_g, status) => {
            finalized = status;
            return true;
        },
    };
    const service = new ChatService(
        {},
        generations,
        {},
        {
            run: async () => {
                ran++;
            },
        }
    );
    service.logger = { error() {}, warn() {} };
    const saved = process.env.ANALYSIS_CORE;
    process.env.ANALYSIS_CORE = 'legacy';
    try {
        await service.runGeneration({ id: 'g', conversationId: 'c', userId: 1, promptPolicyVersion: ANALYSIS_RUNTIME_VERSIONS.promptPolicy }, 'question', 1, () => false);
    } finally {
        if (saved === undefined) delete process.env.ANALYSIS_CORE;
        else process.env.ANALYSIS_CORE = saved;
    }
    assert.equal(ran, 1);
    assert.equal(finalized, 'completed');
});
await check('new SQL tool persists evidence even when legacy dual-write is disabled', async () => {
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
    const saved = process.env.ARTIFACT_DUAL_WRITE_ENABLED;
    process.env.ARTIFACT_DUAL_WRITE_ENABLED = '0';
    try {
        const result = await tool.execute(
            { title: '核对', sql: 'SELECT 1', plan: { purpose: '核对', expectedGrain: '一行', expectedShape: 'scalar' } },
            {
                analysisCore: true,
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
    } finally {
        if (saved === undefined) delete process.env.ARTIFACT_DUAL_WRITE_ENABLED;
        else process.env.ARTIFACT_DUAL_WRITE_ENABLED = saved;
    }
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
    const saved = process.env.ANALYSIS_CORE;
    try {
        process.env.ANALYSIS_CORE = 'new';
        await service.createTurn(1, 'c', 'question', 1, 'key', 'hash', false);
        const insert = writes.find((w) => w.sql.includes('INSERT INTO generation'));
        for (const version of Object.values(ANALYSIS_RUNTIME_VERSIONS)) assert.ok(insert.params.includes(version));
        assert.ok(writes.findIndex((w) => w.sql.includes('outbox_event')) > writes.indexOf(insert));
        writes.length = 0;
        delete process.env.ANALYSIS_CORE;
        await service.createTurn(1, 'c', 'question', 1, 'key2', 'hash', false);
        assert.ok(writes.find((w) => w.sql.includes('INSERT INTO generation')).params.includes(ANALYSIS_RUNTIME_VERSIONS.promptPolicy));
    } finally {
        if (saved === undefined) delete process.env.ANALYSIS_CORE;
        else process.env.ANALYSIS_CORE = saved;
    }
});
console.log(`analysis core regression: ${checks} groups PASS (mock only, no external services)`);
