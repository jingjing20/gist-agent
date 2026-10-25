const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const fromWorker = createRequire(path.resolve(__dirname, '../apps/worker/package.json'));
const telemetry = fromWorker('@gist/telemetry');
const { AnalysisAgent } = require('../apps/worker/dist/analysis/analysis-agent.js');
const { resolveModelCapability } = require('../apps/worker/dist/chat/model-capabilities.js');
test('production agent records rejected arguments, returned failures and finish_analysis as ended tool spans', async () => {
    Object.assign(process.env, { AGENTSCOPE_ENABLED: 'true', AGENTSCOPE_CAPTURE_CONTENT: 'true', AGENTSCOPE_ENDPOINT: 'http://localhost:3100', AGENTSCOPE_API_KEY: 'synthetic' });
    const original = globalThis.fetch,
        events = [];
    globalThis.fetch = async (_url, init) => {
        const batch = JSON.parse(init.body).events;
        events.push(...batch);
        return new Response(JSON.stringify({ accepted: batch.length, duplicates: 0, request_id: 'test' }), { status: 202 });
    };
    let round = 0,
        executed = 0;
    const metrics = { llmCallCount: 0, toolCallCount: 0, sqlCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 };
    try {
        const outcome = await telemetry.traceAgent('fixture-generation', async () =>
            new AnalysisAgent().run({
                messages: [{ role: 'user', content: 'Run this fixture in English.' }],
                turnMessages: [],
                metrics,
                capability: resolveModelCapability('gpt-4o'),
                context: { signal: new AbortController().signal, assertWritable: async () => {}, emitter: { send() {} } },
                tools: [
                    {
                        name: 'fixture',
                        definition: {
                            type: 'function',
                            function: { name: 'fixture', description: 'Fixture', parameters: { type: 'object', properties: {}, additionalProperties: false } },
                        },
                        parseArguments: () => ({}),
                        execute: async () => {
                            executed++;
                            return { succeeded: false, blocks: [], toolResult: '{"error":"fixture failure"}' };
                        },
                    },
                ],
                stream: async (messages) => {
                    round++;
                    assert.ok(round <= 3);
                    const name = round === 3 ? 'finish_analysis' : 'fixture';
                    const args = round === 1 ? '{"unexpected":true}' : round === 2 ? '{}' : '{"status":"complete","reason":null,"missingItems":[]}';
                    return telemetry.traceModelStream(
                        'fixture',
                        async () => ({
                            async *[Symbol.asyncIterator]() {
                                if (round === 3) yield { choices: [{ delta: { content: 'Fixture complete.' } }] };
                                yield {
                                    choices: [
                                        {
                                            delta: { tool_calls: [{ index: 0, id: 'call-' + round, type: 'function', function: { name, arguments: args } }] },
                                            finish_reason: 'tool_calls',
                                        },
                                    ],
                                };
                            },
                        }),
                        undefined,
                        { messages },
                        messages
                    );
                },
                checkpoint: async () => {},
                onFirstDelta: async () => {},
                onContext() {},
                onEvent() {},
            })
        );
        assert.equal(outcome.status, 'complete');
        assert.equal(executed, 1);
        await telemetry.flushTelemetry();
        const starts = events.filter((e) => e.type === 'span.started');
        const tools = starts.filter((e) => e.payload.kind === 'tool');
        assert.equal(tools.length, 3);
        const ends = tools.map((s) => events.find((e) => e.type === 'span.ended' && e.span_id === s.span_id));
        assert.ok(ends.every(Boolean));
        assert.deepEqual(
            ends.map((e) => e.payload.execution_status),
            ['error', 'error', 'success']
        );
        assert.ok(ends[0].payload.output.value.includes('INVALID_TOOL_ARGUMENTS'));
        assert.ok(ends[1].payload.output.value.includes('fixture failure'));
        assert.equal(tools[2].payload.name, 'tool.finish_analysis');
        assert.ok(ends[2].payload.output.value.includes('accepted'));
    } finally {
        await telemetry.shutdownTelemetry();
        globalThis.fetch = original;
    }
});
