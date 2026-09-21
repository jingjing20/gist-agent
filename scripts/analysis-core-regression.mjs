import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AnalysisAgent } = require('../apps/worker/dist/analysis/analysis-agent.js');
const { validateSubmission } = require('../apps/worker/dist/analysis/submission.js');
const { AnalysisRuntimeAdapter } = require('../apps/worker/dist/analysis/analysis-runtime-adapter.js');
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
});
await check('repeated failing query is blocked, modified query remains possible', async () => {
    const h = harness([[query()], [query()], [query()], [call('submit_analysis', answer('partial'))]]);
    let attempts = 0;
    h.sql.execute = async () => {
        attempts++;
        return { succeeded: false, toolResult: '{"errorCode":"42703"}', blocks: [] };
    };
    assert.equal((await h.run()).kind, 'partial');
    assert.equal(attempts, 2);
});
await check('SQL budget exposes only partial submission; no excess execution', async () => {
    const h = harness([[query()], [query('SELECT 2')], [call('submit_analysis', answer('partial', [observation('a1')]))]], { limits: { sqlCalls: 1 } });
    assert.equal((await h.run()).kind, 'partial');
    assert.deepEqual(h.seen[1].names, ['submit_analysis']);
    assert.equal(h.executions.length, 1);
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
await check('empty output, hard model limit and context overflow fail explicitly', async () => {
    await assert.rejects(harness([[]]).run(), { code: 'EMPTY_LLM_RESPONSE' });
    const textOnly = () =>
        (async function* () {
            yield { choices: [{ delta: { content: 'unsubmitted' } }] };
        })();
    await assert.rejects(harness([textOnly, textOnly], { limits: { modelCalls: 2 } }).run(), { code: 'MAX_AGENT_ITERATIONS_EXCEEDED' });
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
    let repairCalls = 0,
        dbCalls = 0;
    const executor = new SqlExecutorAgent(
        {
            queryReadOnlyWithFields: async () => {
                dbCalls++;
                throw Object.assign(new Error('syntax'), { code: 'ER_PARSE_ERROR' });
            },
        },
        {
            chat: async () => {
                repairCalls++;
                return 'SELECT 1';
            },
        },
        { getAllowedTableNames: async () => ['t'], getColumnPolicies: async () => [] }
    );
    executor.logger = { error() {}, warn() {}, log() {} };
    await assert.rejects(executor.execute('SELECT 1', 1, 1, new AbortController().signal, { allowModelRepair: false }));
    assert.equal(dbCalls, 1);
    assert.equal(repairCalls, 0);
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
        { getSchemaCatalogSummary: async () => ({ datasourceId: 1, tables: [] }), getStructuredSchema: async () => [] },
        { isReasoningActive: () => false, streamWithTools: async () => stream([call('submit_analysis', { kind: 'clarification', question: '请提供口径' })]) },
        { name: 'execute_sql_query', definition: { type: 'function', function: { name: 'execute_sql_query', parameters: {} } } },
        { name: 'generate_chart', definition: { type: 'function', function: { name: 'generate_chart', parameters: {} } } },
        {},
        {
            withTransaction: async (fn) =>
                fn({
                    query: async (sql) => [
                        sql.includes('FROM data_source d')
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
    assert.deepEqual(blocks.at(-1).analysis.snapshot.definitionRefs, [{ id: 'stored-definition', version: 3 }]);
    assert.equal(blocks.at(-1).analysis.definitions[0].name, '已确认口径');
    assert.equal(blocks.at(-1).analysis.outcome.kind, 'clarification');
    assert.equal(blocks.length, 1);
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
        { isReasoningActive: unexpected },
        {},
        { buildSystemPrompt: unexpected },
        { updateStateAsync: unexpected },
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
        assert.equal(executionOptions.allowModelRepair, false);
    } finally {
        if (saved === undefined) delete process.env.ARTIFACT_DUAL_WRITE_ENABLED;
        else process.env.ARTIFACT_DUAL_WRITE_ENABLED = saved;
    }
});
await check('generation creation stamps all new versions before enqueue, legacy remains default', async () => {
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
        assert.ok(!writes.find((w) => w.sql.includes('INSERT INTO generation')).params.includes(ANALYSIS_RUNTIME_VERSIONS.promptPolicy));
    } finally {
        if (saved === undefined) delete process.env.ANALYSIS_CORE;
        else process.env.ANALYSIS_CORE = saved;
    }
});
console.log(`analysis core regression: ${checks} groups PASS (mock only, no external services)`);
