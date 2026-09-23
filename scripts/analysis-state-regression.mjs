import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { newAnalysisState, patchAnalysisState, evidenceMismatch, conditionSignature, validateEvidenceReference } = require('../apps/worker/dist/analysis/analysis-state.js');
const { AnalysisStateRepository } = require('../apps/worker/dist/analysis/analysis-state.repository.js');
const { AnalysisRuntimeAdapter } = require('../apps/worker/dist/analysis/analysis-runtime-adapter.js');
const { GenerationService } = require('../apps/worker/dist/chat/generation.service.js');
const { assembleContext } = require('../apps/worker/dist/analysis/context-assembler.js');
const { AnalysisAgent } = require('../apps/worker/dist/analysis/analysis-agent.js');
const { ArtifactRepository } = require('../apps/worker/dist/chat/artifact.repository.js');
const { promoteAnalysisDraft } = require('../packages/database/dist/index.js');
let checks = 0;
async function check(name, fn) {
    await fn();
    checks++;
    console.log(`PASS ${name}`);
}
const g = (id = 'g') => ({
    id,
    userId: 1,
    conversationId: 'c',
    datasourceId: 1,
    writerToken: 'w',
    requestMessageId: `m-${id}`,
    messageId: `a-${id}`,
    contextUpperBound: '2026-09-15T00:00:00Z',
    schemaContextVersion: 'schema-v1',
    promptPolicyVersion: 'analysis-core-v2',
});
const def = { id: 'd', version: 1, name: '注册', description: '注册用户', status: 'active' };
const deps = { memories: [def], sourceMessageId: 'user-message', fieldAllowed: async (f) => f === 'users.platform', validateEvidence: async () => {} };
const patch = (s, p = {}, extra = {}) => patchAnalysisState(s, { expectedRevision: s.revision, reason: '确认条件', patch: p, ...extra }, deps);
function database() {
    let data = { generations: {}, states: {}, drafts: {}, writes: [] };
    const query = async (sql, p = []) => {
        if (sql.startsWith('SELECT id FROM generation')) {
            const a = data.generations[p[0]];
            return a && a.writerToken === p[3] && ['starting', 'running'].includes(a.status) ? [{ id: p[0] }] : [];
        }
        if (sql.includes('FROM analysis_state_draft')) return data.drafts[p[0]] ? [structuredClone(data.drafts[p[0]])] : [];
        if (sql.includes('FROM analysis_state WHERE')) return data.states[p[0]] ? [structuredClone(data.states[p[0]])] : [];
        if (sql.startsWith('SELECT id FROM conversation')) return [{ id: p[0] }];
        if (sql.includes('FROM data_source d')) return [{ id: 1 }];
        if (sql.includes('SELECT d.id')) return [];
        if (sql.includes('information_schema.columns') || sql.includes('FROM conversation_turn ct')) return [];
        throw new Error(`Unhandled query ${sql}`);
    };
    const execute = async (sql, p = []) => {
        data.writes.push(sql);
        if (sql.startsWith('INSERT INTO analysis_state_draft'))
            data.drafts[p[0]] = {
                generation_id: p[0],
                conversation_id: p[1],
                base_revision: p[2],
                revision: p[3],
                state: JSON.parse(p[4]),
                memories: JSON.parse(p[5]),
                context_reports: [],
            };
        else if (sql.startsWith('UPDATE analysis_state_draft SET revision')) {
            const d = data.drafts[p[2]];
            if (!d || d.revision !== p[3]) return { rowCount: 0 };
            d.revision = p[0];
            d.state = JSON.parse(p[1]);
        } else if (sql.startsWith('UPDATE analysis_state_draft SET context_reports')) data.drafts[p[1]].context_reports.push(...JSON.parse(p[0]));
        else if (sql.startsWith('INSERT INTO analysis_state(')) data.states[p[0]] = { revision: p[1], state: JSON.parse(p[2]), generation_id: p[3] };
        else if (sql.startsWith('UPDATE generation SET status=')) {
            const gen = data.generations[p[3]];
            if (
                !gen ||
                gen.writerToken !== p[5] ||
                !['starting', 'running', 'cancel_requested'].includes(gen.status) ||
                (p[0] === 'completed' && gen.status === 'cancel_requested')
            )
                return { rowCount: 0 };
            gen.status = p[0];
        }
        return { rowCount: 1 };
    };
    const db = {
        query,
        withTransaction: async (fn) => {
            const before = structuredClone(data);
            try {
                return await fn({ query: async (sql, p) => [await query(sql, p)], execute: async (sql, p) => [await execute(sql, p)] });
            } catch (e) {
                data = before;
                throw e;
            }
        },
    };
    return { db, data: () => data, add: (gen) => (data.generations[gen.id] = { ...gen, status: 'running' }) };
}
await check('whitelist, optimistic revision, source binding, filters and time validation', async () => {
    const s = newAnalysisState('c', 1, '激活');
    for (const p of [
        { datasourceId: 2 },
        { filters: [{ field: 'secret.token', operator: 'eq', value: 1 }] },
        { filters: [{ field: 'users.platform', operator: 'in', value: 'android' }] },
        { timeRange: { start: 'bad', endExclusive: 'bad', timezone: 'UTC' } },
        { memoryRefs: [{ id: 'd', version: 2 }] },
    ])
        await assert.rejects(() => patch(s, p));
    await assert.rejects(() => patch(s, {}, { expectedRevision: 0 }), /版本冲突/);
    const next = await patch(s, {
        temporaryNotes: [{ name: '临时激活', description: '一天内激活' }],
        filters: [{ field: 'users.platform', operator: 'eq', value: 'Android' }],
    });
    assert.equal(next.temporaryNotes[0].sourceMessageId, 'user-message');
    assert.equal(next.revision, 2);
    assert.deepEqual(s.filters, []);
    await assert.rejects(() => patch(s, { temporaryNotes: [{ name: 'x', description: 'y', sourceMessageId: 'forged' }] }));
});
await check('new task resets inherited conditions; condition change invalidates hypotheses', async () => {
    const s = await patch(newAnalysisState('c', 1, '原问题'), {
        memoryRefs: [{ id: 'd', version: 1 }],
        grain: 'daily',
        hypotheses: [{ id: 'h', statement: '渠道相关', status: 'open', evidenceIds: [] }],
    });
    const changed = await patch(s, { grain: 'weekly' });
    assert.deepEqual(changed.hypotheses, []);
    const reset = await patch(s, { question: '新问题' }, { mode: 'start_new_task' });
    assert.notEqual(reset.taskId, s.taskId);
    assert.equal(reset.grain, null);
    assert.deepEqual(reset.memoryRefs, []);
});
await check('evidence applicability compares conditions, not revision or question wording', async () => {
    const s = newAnalysisState('c', 1, 'q');
    const a = { datasourceId: 1, generationId: 'prior', analysisContext: { state: s } };
    assert.equal(evidenceMismatch(a, { ...s, revision: 10, question: '重画图' }, 'now'), null);
    for (const state of [
        { ...s, grain: 'daily' },
        { ...s, filters: [{ field: 'users.platform', operator: 'eq', value: 'Android' }] },
        { ...s, memoryRefs: [{ id: 'd', version: 2 }] },
        { ...s, freshness: 'current_generation' },
        { ...s, datasourceId: 2 },
        { ...s, taskId: 'other' },
    ])
        assert.ok(evidenceMismatch(a, state, 'now'));
    assert.ok(evidenceMismatch({ ...a, analysisContext: undefined }, s, 'now'));
    assert.equal(conditionSignature(s), conditionSignature({ ...s, status: 'answered' }));
});
await check('drafts remain isolated until successful finalize; failure and cancellation do not promote', async () => {
    const h = database(),
        r = new AnalysisStateRepository(h.db),
        gen = g();
    h.add(gen);
    const begun = await r.begin(gen, 1, 'q', [def]);
    assert.equal(h.data().states.c, undefined);
    await r.save(gen, begun.state.revision, await patch(begun.state, { grain: 'daily' }));
    await GenerationService.prototype.finalize.call({ db: h.db }, gen, 'completed', undefined, undefined, { type: 'done' });
    assert.equal(h.data().states.c.state.grain, 'daily');
    const revision = h.data().states.c.revision;
    for (const status of ['failed', 'cancelled']) {
        const next = g(status);
        h.add(next);
        const d = await r.begin(next, 1, 'next', [def]);
        await r.save(next, d.state.revision, await patch(d.state, { grain: status }));
        await GenerationService.prototype.finalize.call({ db: h.db }, next, status, undefined, undefined, { type: 'done' });
        assert.equal(h.data().states.c.revision, revision);
    }
});
await check('late cancellation cannot commit success or promote the draft', async () => {
    const h = database(),
        gen = g();
    h.add(gen);
    await new AnalysisStateRepository(h.db).begin(gen, 1, 'q', []);
    h.data().generations.g.status = 'cancel_requested';
    const committed = await GenerationService.prototype.finalize.call({ db: h.db }, gen, 'completed', undefined, undefined, { type: 'done' });
    assert.equal(committed, false);
    assert.equal(h.data().states.c, undefined);
    await assert.rejects(() => new AnalysisStateRepository(h.db).save(gen, 1, newAnalysisState('c', 1, 'x', 2)), /任务已停止/);
});
await check('promotion conflict rolls back generation completion and leaves newer state intact', async () => {
    const h = database(),
        gen = g();
    h.add(gen);
    await new AnalysisStateRepository(h.db).begin(gen, 1, 'q', []);
    h.data().states.c = { revision: 5, state: newAnalysisState('c', 1, 'newer', 5) };
    await assert.rejects(() => GenerationService.prototype.finalize.call({ db: h.db }, gen, 'completed', undefined, undefined, { type: 'done' }), /ANALYSIS_STATE_CONFLICT/);
    assert.equal(h.data().states.c.revision, 5);
    assert.equal(h.data().generations.g.status, 'running');
});
await check('changed memory references require reselection while existing draft snapshot remains fixed', async () => {
    const h = database(),
        r = new AnalysisStateRepository(h.db);
    h.data().states.c = { revision: 3, state: { ...newAnalysisState('c', 1, 'q', 3), memoryRefs: [{ id: 'd', version: 1 }], hypotheses: [{ id: 'h' }] } };
    const gen = g();
    h.add(gen);
    const d = await r.begin(gen, 1, 'followup', [{ ...def, version: 2 }]);
    assert.deepEqual(d.state.memoryRefs, []);
    assert.equal(d.memoryChanges.length, 1);
    assert.deepEqual(d.state.hypotheses, []);
    const same = await r.begin(gen, 1, 'followup', [{ ...def, version: 3 }]);
    assert.equal(same.memories[0].version, 2);
    const other = g('other');
    h.add(other);
    const reset = await r.begin(other, 2, 'new source', []);
    assert.notEqual(reset.state.taskId, d.state.taskId);
    assert.deepEqual(reset.state.memoryRefs, []);
});
const toolCall = (id, name = 'x', args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const group = (id, content) => [
    { role: 'assistant', content: null, tool_calls: [toolCall(id)] },
    { role: 'tool', tool_call_id: id, content },
];
await check('context selection is deterministic and preserves latest paired interaction', async () => {
    const input = {
        system: 'rules',
        tools: [],
        budget: 150,
        messages: [
            { role: 'system', content: 'old' },
            { role: 'user', content: 'current' },
            ...group('old', 'x'.repeat(4000)),
            ...group('latest', 'result'),
            { role: 'system', content: 'submit partial' },
        ],
        extras: [
            {
                id: 'history',
                category: 'recent-turn',
                priority: 4,
                messages: [
                    { role: 'user', content: 'x'.repeat(8000) },
                    { role: 'assistant', content: 'old' },
                ],
            },
        ],
    };
    const a = assembleContext(input),
        b = assembleContext(input);
    assert.deepEqual(a, b);
    assert.ok(a.report.some((r) => r.candidateId === 'action-0' && !r.selected));
    assert.ok(a.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'latest'));
    assert.ok(!a.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'old'));
    assert.throws(() => assembleContext({ ...input, budget: 1 }), /超出预算/);
    assert.throws(
        () =>
            assembleContext({
                ...input,
                messages: [
                    { role: 'system', content: '' },
                    { role: 'user', content: '' },
                    { role: 'tool', tool_call_id: 'orphan', content: '' },
                ],
            }),
        /孤立/
    );
});
await check('artifact persistence round-trips state and memory snapshots without changing legacy input', async () => {
    const s = newAnalysisState('c', 1, 'q');
    let inserted;
    const db = {
        query: async (sql, p) => {
            if (sql.startsWith('INSERT')) {
                inserted = { sql, p };
                return [{ created_at: '2026-09-15', expires_at: null }];
            }
            if (sql.startsWith('SELECT *'))
                return [
                    {
                        id: 'a',
                        generation_id: 'g',
                        user_id: 1,
                        conversation_id: 'c',
                        datasource_id: 1,
                        columns_json: [],
                        result_rows: [],
                        returned_row_count: 0,
                        is_limited: false,
                        created_at: '2026-09-15',
                        analysis_context: { state: s, memories: [def] },
                    },
                ];
            if (sql.includes('FROM data_source')) return [{}];
            throw new Error(sql);
        },
    };
    const r = new ArtifactRepository(db);
    const a = await r.createQueryArtifact({
        generationId: 'g',
        userId: 1,
        conversationId: 'c',
        datasourceId: 1,
        title: 'x',
        plan: { purpose: 'x', expectedGrain: 'one', expectedShape: 'scalar' },
        originalSql: 'select 1',
        executedSql: 'select 1',
        schemaContextVersion: 's',
        columns: [],
        rows: [],
        returnedRowCount: 0,
        isLimited: false,
        analysisContext: { state: s, memories: [def] },
    });
    assert.ok(inserted.sql.includes('analysis_context'));
    assert.equal(a.analysisContext.state.taskId, s.taskId);
    assert.equal((await r.readQueryArtifact('a', 1, 'c', 0)).artifact.analysisContext.memories[0].version, 1);
});
let callId = 0;
const streamCalls = (calls) =>
    (async function* () {
        for (const [index, c] of calls.entries()) yield { choices: [{ delta: { tool_calls: [{ index, id: c.id, function: c.function }] } }] };
    })();
const call = (name, args) => toolCall(`call-${++callId}`, name, args);
const answer = (id) => ({
    kind: 'answer',
    answer: {
        summary: '已核对结果',
        findings: id ? [{ id: 'f', kind: 'observation', text: '查询结果已核对', evidence: [{ artifactId: id, role: 'observation' }] }] : [],
        limitations: [],
        unresolvedQuestions: [],
    },
});
await check('two real adapter rounds reuse matching evidence for chart without a second SQL execution', async () => {
    const h = database(),
        artifacts = new Map();
    let sqlCount = 0,
        charts = 0,
        round = 0;
    const captured = [];
    const artifactRepository = {
        listAnalysisEvidence: async () => ({ items: [...artifacts.values()].map((a) => ({ id: a.id, title: a.title })), nextOffset: null }),
        readQueryArtifact: async (id) => {
            const artifact = artifacts.get(id);
            if (!artifact) throw new Error('missing');
            return { artifact, rows: [{ n: 1 }] };
        },
        assertUsableInGeneration: async () => {},
    };
    const schema = {
        getAllowedTableNames: async () => ['users'],
        getColumnPolicies: async () => [],
        assertDatasourceAccess: async () => {},
        getSchemaCatalogSummary: async () => ({ datasourceId: 1, tables: Array.from({ length: 25 }, (_, i) => ({ name: `table${i}`, displayName: `表${i}` })) }),
        getSchemaDetail: async () => ({ columns: [{ name: 'platform' }] }),
    };
    const llm = {
        isReasoningActive: () => false,
        streamWithTools: async (messages) => {
            captured.push(messages);
            const state = JSON.parse(messages[0].content.split('<untrusted-analysis-data>')[1].split('</untrusted-analysis-data>')[0]).state;
            const tools = messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
            if (!tools.some((t) => t.state)) return streamCalls([call('update_analysis_state', { expectedRevision: state.revision, patch: {}, reason: '确认本轮条件' })]);
            if (round === 0 && !tools.some((t) => t.queryArtifactId))
                return streamCalls([call('execute_sql_query', { sql: 'select 1', title: '计数', plan: { purpose: '核对', expectedGrain: 'one', expectedShape: 'scalar' } })]);
            if (round === 1 && !tools.some((t) => t.queryArtifactId)) return streamCalls([call('read_query_artifact', { queryArtifactId: 'artifact' })]);
            if (round === 1 && !tools.some((t) => t.chartArtifactId)) return streamCalls([call('generate_chart', { queryArtifactId: 'artifact' })]);
            return streamCalls([call('submit_analysis', answer('artifact'))]);
        },
    };
    const sql = {
        name: 'execute_sql_query',
        definition: { type: 'function', function: { name: 'execute_sql_query', parameters: { properties: { sql: {}, title: {}, plan: {} } } } },
        parseArguments: (v) => v,
        execute: async (args, ctx) => {
            sqlCount++;
            artifacts.set('artifact', {
                id: 'artifact',
                generationId: ctx.generationId,
                datasourceId: 1,
                conversationId: 'c',
                userId: 1,
                executedSql: args.sql,
                createdAt: '2026-09-15',
                isLimited: false,
                returnedRowCount: 1,
                columns: [],
                analysisContext: structuredClone(ctx.analysisContext),
            });
            return { toolResult: JSON.stringify({ queryArtifactId: 'artifact', data: [{ n: 1 }] }), blocks: [], succeeded: true };
        },
    };
    const chart = {
        name: 'generate_chart',
        definition: { type: 'function', function: { name: 'generate_chart', parameters: { properties: { queryArtifactId: {} } } } },
        parseArguments: (v) => v,
        execute: async () => {
            charts++;
            return { toolResult: JSON.stringify({ chartArtifactId: 'chart' }), blocks: [], succeeded: true };
        },
    };
    const adapter = new AnalysisRuntimeAdapter(schema, llm, sql, chart, artifactRepository, h.db);
    for (round = 0; round < 2; round++) {
        const gen = g(`g${round}`);
        h.add(gen);
        const blocks = [];
        await adapter.run({
            generation: gen,
            message: round ? '重新画图' : '计数',
            signal: new AbortController().signal,
            emitter: { send: () => {} },
            blocks,
            turnMessages: [],
            metrics: { llmCallCount: 0, toolCallCount: 0, sqlCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 },
            assertWritable: async () => {},
            checkpoint: async () => {},
            onFirstDelta: async () => {},
        });
        assert.equal(blocks.at(-1).analysis.outcome.kind, 'answer');
        await h.db.withTransaction((tx) => promoteAnalysisDraft(tx, gen.id));
    }
    assert.equal(sqlCount, 1);
    assert.equal(charts, 1);
    assert.ok(captured.some((ms) => ms.some((m) => String(m.content).includes('schemaNextOffset'))));
    assert.ok(h.data().drafts.g1.context_reports.length >= 4);
});
await check('provider context error retries once and reports reduced budget', async () => {
    let calls = 0;
    const reports = [];
    const opts = {
        messages: [
            { role: 'system', content: 'rules' },
            { role: 'user', content: 'hi' },
        ],
        turnMessages: [],
        tools: [],
        context: { signal: new AbortController().signal, assertWritable: async () => {} },
        capability: { contextWindow: 10000, responseReserve: 1000 },
        metrics: { llmCallCount: 0, toolCallCount: 0, sqlCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 },
        onEvent: () => {},
        checkpoint: async () => {},
        onFirstDelta: async () => {},
        onContext: (r) => reports.push(r),
        stream: async () => {
            if (calls++ === 0) throw Object.assign(new Error('context'), { code: 'context_length_exceeded' });
            return streamCalls([call('submit_analysis', answer())]);
        },
    };
    await new AnalysisAgent().run(opts);
    assert.equal(calls, 2);
    assert.equal(reports[1].budget, reports[0].budget * 0.75);
    let retries = 0;
    await assert.rejects(() =>
        new AnalysisAgent().run({
            ...opts,
            messages: opts.messages.slice(0, 2),
            stream: async () => {
                retries++;
                throw Object.assign(new Error('context'), { code: 'context_length_exceeded' });
            },
        })
    );
    assert.equal(retries, 2);
});
await check('historical comparison requires explicit read and labeled role; source and freshness cannot be bypassed', async () => {
    const s = newAnalysisState('c', 1, 'q');
    const artifact = { id: 'a', datasourceId: 1, generationId: 'old', analysisContext: { state: { ...s, grain: 'daily' } } };
    assert.throws(() => validateEvidenceReference(artifact, s, 'g', { role: 'observation' }, true));
    assert.throws(() => validateEvidenceReference(artifact, s, 'g', { role: 'comparison', comparisonLabel: '旧日粒度与当前条件' }, false));
    assert.doesNotThrow(() => validateEvidenceReference(artifact, s, 'g', { role: 'comparison', comparisonLabel: '旧日粒度与当前条件' }, true));
    for (const state of [
        { ...s, datasourceId: 2 },
        { ...s, freshness: 'current_generation' },
        { ...s, taskId: 'other' },
    ])
        assert.throws(() => validateEvidenceReference(artifact, state, 'g', { role: 'comparison', comparisonLabel: '历史' }, true));
});
await check('state updates cannot share a model batch with dependent queries', async () => {
    let writes = 0,
        n = 0;
    const messages = [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'q' },
    ];
    const stateTool = {
        name: 'update_analysis_state',
        definition: { type: 'function', function: { name: 'update_analysis_state', parameters: { properties: {} } } },
        parseArguments: (v) => v,
        execute: async () => {
            writes++;
            return { toolResult: '{}', blocks: [] };
        },
    };
    const sqlTool = { ...stateTool, name: 'execute_sql_query', definition: { type: 'function', function: { name: 'execute_sql_query', parameters: { properties: {} } } } };
    const outcome = await new AnalysisAgent().run({
        messages,
        turnMessages: [],
        tools: [stateTool, sqlTool],
        context: { signal: new AbortController().signal, assertWritable: async () => {} },
        capability: { contextWindow: 10000, responseReserve: 1000 },
        metrics: { llmCallCount: 0, toolCallCount: 0, sqlCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 },
        onEvent: () => {},
        checkpoint: async () => {},
        onFirstDelta: async () => {},
        onContext: () => {},
        stream: async () =>
            streamCalls(n++ === 0 ? [call('update_analysis_state', {}), call('execute_sql_query', {})] : [call('submit_analysis', { kind: 'clarification', question: '请确认' })]),
    });
    assert.equal(writes, 0);
    assert.equal(outcome.kind, 'clarification');
    assert.equal(messages.filter((m) => m.role === 'tool').length, 3);
});
await check('failed final evidence validation cannot accidentally return an accepted answer', async () => {
    let n = 0;
    const outcomes = [];
    const outcome = await new AnalysisAgent().run({
        messages: [
            { role: 'system', content: 'rules' },
            { role: 'user', content: 'q' },
        ],
        turnMessages: [],
        tools: [],
        context: { signal: new AbortController().signal, assertWritable: async () => {} },
        capability: { contextWindow: 10000, responseReserve: 1000 },
        metrics: { llmCallCount: 0, toolCallCount: 0, sqlCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 },
        onEvent: () => {},
        checkpoint: async () => {},
        onFirstDelta: async () => {},
        onContext: () => {},
        validateOutcome: async (o) => {
            outcomes.push(o.kind);
            if (o.kind === 'answer') throw new Error('条件已变化');
        },
        stream: async () => streamCalls([call('submit_analysis', n++ === 0 ? answer() : { kind: 'clarification', question: '重新确认条件' })]),
    });
    assert.equal(outcome.kind, 'clarification');
    assert.deepEqual(outcomes, ['answer', 'clarification']);
});
await check('schema and memory pages remain discoverable; permission revocation blocks schema catalog and tools', async () => {
    const { analysisTools } = require('../apps/worker/dist/analysis/analysis-tools.js');
    const { SchemaService } = require('../apps/worker/dist/database/schema.service.js');
    const cached = new SchemaService({ query: async () => [] });
    await assert.rejects(() => cached.getSchemaCatalogSummary(1, 1), /DATASOURCE_ACCESS_CHANGED/);
    let revoked = false;
    const session = {
        state: newAnalysisState('c', 1, 'q'),
        memories: Array.from({ length: 25 }, (_, i) => ({ ...def, id: `d${i}`, name: `memory${i}` })),
        observed: new Map(),
        comparisonIds: new Set(),
        loadedSchema: new Map(),
        memoryChanges: [],
        prepared: false,
    };
    const schema = {
        assertDatasourceAccess: async () => {
            if (revoked) throw new Error('DATASOURCE_ACCESS_CHANGED: revoked');
        },
        getSchemaDetail: async () => ({ table: 'users', columns: Array.from({ length: 45 }, (_, i) => ({ name: `column${i}`, type: 'text' })) }),
        getSchemaCatalogSummary: async () => ({ tables: Array.from({ length: 25 }, (_, i) => ({ name: `table${String(i).padStart(2, '0')}`, displayName: `Table ${i}` })) }),
    };
    const tools = analysisTools({
        session,
        schema,
        artifacts: {},
        states: {},
        generation: g(),
        readEvidence: async () => {
            throw new Error('unused');
        },
    });
    const ctx = { assertWritable: async () => {}, signal: new AbortController().signal };
    const run = async (name, args) => {
        const tool = tools.find((t) => t.name === name);
        return JSON.parse((await tool.execute(tool.parseArguments(args), ctx)).toolResult);
    };
    const catalog = await run('list_schema', {});
    assert.equal(catalog.nextOffset, 20);
    assert.equal((await run('list_schema', { offset: 20 })).tables.length, 5);
    const fields = await run('get_schema', { table: 'users', offset: 20 });
    assert.equal(fields.columns[0].name, 'column20');
    assert.equal(fields.nextOffset, 40);
    assert.equal((await run('list_memories', { offset: 20 })).items.length, 5);
    assert.equal((await run('read_memory', { id: 'd24' })).name, 'memory24');
    revoked = true;
    await assert.rejects(() => run('get_schema', { table: 'users' }), /数据源不可访问/);
    await assert.rejects(() => run('read_memory', { id: 'd0' }), /数据源不可访问/);
});
console.log(`${checks} S3 mock groups passed (no database, Redis, model, or browser)`);
