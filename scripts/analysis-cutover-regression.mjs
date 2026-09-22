import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { ANALYSIS_RUNTIME_VERSIONS } = require('../packages/contracts/dist/index.js');
const { GenerationService } = require('../apps/api/dist/chat/generation.service.js');
const { ChatService } = require('../apps/worker/dist/chat/chat.service.js');
const { LlmClient } = require('../packages/llm/dist/index.js');
let count = 0;
async function check(name, fn) {
    await fn();
    count++;
    console.log(`PASS ${name}`);
}
function apiFixture({ existing = false, active = false } = {}) {
    const writes = [],
        reads = [];
    const service = Object.create(GenerationService.prototype); // No Redis client or database connection.
    service.db = {
        withTransaction: async (fn) =>
            fn({
                query: async (sql, params) => {
                    reads.push(sql);
                    if (sql.includes('idempotency_key')) return [existing ? [{ id: 'original', request_hash: 'hash', conversation_id: 'c' }] : []];
                    if (sql.includes('SELECT datasource_id')) return [[{ datasource_id: 1 }]];
                    if (sql.includes('SELECT COUNT')) return [[{ count: 0 }]];
                    if (sql.includes('clock_timestamp')) return [[{ context_upper_bound: '2026-09-21T00:00:00Z' }]];
                    if (sql.includes("status IN ('pending'")) return [active ? [{ id: 'running' }] : []];
                    return [[]];
                },
                execute: async (sql, params) => {
                    writes.push({ sql, params });
                    return [{ rowCount: 1 }];
                },
            }),
    };
    return { writes, reads, run: () => service.createTurn(1, 'c', 'question', 1, 'key', 'hash', false) };
}
await check('conversations stamp the sole runtime, obsolete selection is ignored', async () => {
    const previous = process.env.ANALYSIS_CORE;
    try {
        for (const obsolete of ['legacy', 'new', 'invalid']) {
            process.env.ANALYSIS_CORE = obsolete;
            const h = apiFixture();
            await h.run();
            const generation = h.writes.find((w) => w.sql.includes('INSERT INTO generation'));
            for (const version of Object.values(ANALYSIS_RUNTIME_VERSIONS)) assert.ok(generation.params.includes(version));
            assert.ok(h.writes.findIndex((w) => w.sql.includes('outbox_event')) > h.writes.indexOf(generation));
        }
    } finally {
        if (previous === undefined) delete process.env.ANALYSIS_CORE;
        else process.env.ANALYSIS_CORE = previous;
    }
});
await check('idempotent replay keeps original generation and active conversation retains serialization', async () => {
    const replay = apiFixture({ existing: true });
    assert.equal((await replay.run()).generationId, 'original');
    assert.equal(replay.writes.length, 0);
    const active = apiFixture({ active: true });
    await assert.rejects(active.run, (e) => e.getResponse().code === 'CONVERSATION_GENERATION_ACTIVE');
    assert.equal(active.writes.length, 0);
});
function workerFixture(run) {
    let calls = 0;
    const finals = [];
    const generations = {
        emitter: () => ({ send() {} }),
        isCancelRequested: async () => false,
        recordSpan: async () => {},
        recordExecutionMetrics: async () => {},
        drain: async () => {},
        finalize: async (_g, status, _detail, code) => {
            finals.push({ status, code });
            return true;
        },
    };
    const worker = new ChatService(
        {},
        generations,
        {},
        {
            run: async (input) => {
                calls++;
                await run?.(input);
            },
        }
    );
    worker.logger = { error() {}, warn() {} };
    return {
        worker,
        finals,
        calls: () => calls,
        run: (version) => worker.runGeneration({ id: 'g', userId: 1, conversationId: 'c', promptPolicyVersion: version }, 'question', 1, () => false),
    };
}
await check('retired and unknown queued tasks fail explicitly without invoking any analysis', async () => {
    for (const version of [undefined, 'prompt-policy-v5', 'analysis-core-v1', 'analysis-core-v999']) {
        const h = workerFixture();
        await h.run(version);
        assert.equal(h.calls(), 0);
        assert.deepEqual(h.finals, [{ status: 'failed', code: 'ANALYSIS_PROTOCOL_ERROR' }]);
    }
});
await check('current runtime completes and cancellation still finalizes separately', async () => {
    const h = workerFixture();
    await h.run(ANALYSIS_RUNTIME_VERSIONS.promptPolicy);
    assert.equal(h.calls(), 1);
    assert.equal(h.finals[0].status, 'completed');
    const { GenerationExecutionError } = require('../apps/worker/dist/chat/generation-errors.js');
    const cancel = workerFixture(async () => {
        throw new GenerationExecutionError('CANCELLED', '已取消');
    });
    await cancel.run(ANALYSIS_RUNTIME_VERSIONS.promptPolicy);
    assert.deepEqual(cancel.finals, [{ status: 'cancelled', code: 'CANCELLED' }]);
});
await check('mock provider emits a valid structured clarification instead of unsupported free text', async () => {
    const previous = process.env.LLM_PROVIDER;
    try {
        process.env.LLM_PROVIDER = 'mock';
        const client = Object.create(LlmClient.prototype);
        const stream = await client.streamWithTools([], [{ type: 'function', function: { name: 'submit_analysis' } }]);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const call = chunks[0].choices[0].delta.tool_calls[0];
        assert.equal(call.function.name, 'submit_analysis');
        assert.equal(JSON.parse(call.function.arguments).kind, 'clarification');
    } finally {
        if (previous === undefined) delete process.env.LLM_PROVIDER;
        else process.env.LLM_PROVIDER = previous;
    }
});
await check('retired runtime modules are absent from source and clean build output', async () => {
    for (const path of ['chat/prompt-builder', 'chat/agent-orchestrator', 'chat/agents/semantic-distiller.service', 'chat/tools/tool-registry', 'memory/memory.service']) {
        assert.equal(existsSync(new URL(`../apps/worker/src/${path}.ts`, import.meta.url)), false);
        assert.equal(existsSync(new URL(`../apps/worker/dist/${path}.js`, import.meta.url)), false);
    }
    assert.equal(existsSync(new URL('../apps/api/dist/memory/memory.controller.js', import.meta.url)), false);
});
console.log(`S5 cutover: ${count} groups passed (mock only; no semantic, DB or interaction acceptance)`);
