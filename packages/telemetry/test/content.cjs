const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StreamOutput } = require('../dist/stream-output.js');
const telemetry = require('../dist/index.js');
test('content opt-in captures conversation, messages, tools and bounded streamed calls with credentials removed', async () => {
    process.env.AGENTSCOPE_ENABLED = 'true';
    process.env.AGENTSCOPE_CAPTURE_CONTENT = 'true';
    process.env.AGENTSCOPE_ENDPOINT = 'http://localhost:3100';
    process.env.AGENTSCOPE_API_KEY = 'test-only';
    const original = globalThis.fetch,
        events = [];
    globalThis.fetch = async (_url, init) => {
        const { events: batch } = JSON.parse(init.body);
        events.push(...batch);
        return new Response(JSON.stringify({ accepted: batch.length, duplicates: 0, request_id: 'test' }), { status: 202 });
    };
    try {
        await telemetry.traceAgent(
            'generation-1',
            async (root) => {
                await telemetry.traceTool('sql', async () => ({ succeeded: true, toolResult: '{"rows":[42],"refresh_token":"private-refresh"}' }), undefined, {
                    arguments: { sql: 'select 42', password: 'private-password' },
                });
                const messages = [
                    { role: 'system', content: 'System prompt' },
                    { role: 'user', content: 'Bearer private-token and api_key=hidden-value' },
                ];
                await telemetry.traceModel(
                    'fixture',
                    async (span) => {
                        span.setOutput({ role: 'assistant', content: 'answer' });
                    },
                    { messages },
                    messages
                );
                const chunks = [
                    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'query', arguments: '{"sql":' } }] } }] },
                    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"select 42"}' } }] }, finish_reason: 'tool_calls' }] },
                ];
                const stream = await telemetry.traceModelStream(
                    'fixture',
                    async () => ({
                        async *[Symbol.asyncIterator]() {
                            yield* chunks;
                        },
                    }),
                    undefined,
                    { messages },
                    messages
                );
                let index = 0;
                for await (const c of stream) assert.equal(c, chunks[index++]);
                const partial = await telemetry.traceModelStream('partial', async () => ({
                    async *[Symbol.asyncIterator]() {
                        yield { choices: [{ delta: { content: 'partial answer' } }] };
                        yield { choices: [] };
                    },
                }));
                for await (const c of partial) {
                    assert.ok(c);
                    break;
                }
                root.setOutput('Final answer');
            },
            { conversationId: 'conversation-1', requestMessageId: 'message-1', input: 'Question' }
        );
        await telemetry.flushTelemetry();
        const start = events.find((e) => e.type === 'span.started' && e.payload.parent_span_id === null);
        assert.equal(start.payload.input.value, 'Question');
        assert.equal(start.payload.attributes.conversation_id, 'conversation-1');
        const ends = events.filter((e) => e.type === 'span.ended');
        assert.ok(ends.some((e) => e.payload.output.value?.tool_calls?.[0]?.function?.arguments === '{"sql":"select 42"}'));
        assert.ok(ends.some((e) => e.payload.execution_status === 'canceled' && e.payload.output.value?.content === 'partial answer'));
        const serialized = JSON.stringify(events);
        for (const secret of ['private-password', 'private-token', 'hidden-value', 'private-refresh']) assert.equal(serialized.includes(secret), false);
        for (const content of ['System prompt', 'select 42', 'Final answer']) assert.equal(serialized.includes(content), true);
        assert.equal(telemetry.telemetryDiagnostics().queued, 0);
    } finally {
        await telemetry.shutdownTelemetry();
        globalThis.fetch = original;
    }
});
test('stream accumulator bounds tool fragments and reports truncation without splitting Unicode', () => {
    const output = new StreamOutput();
    output.add({ tool_calls: [{ index: 0, function: { name: 'query', arguments: '文😀'.repeat(20000) } }] });
    const result = output.result();
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result.value)) < 32768);
    assert.equal(JSON.stringify(result.value).includes('\\ud83d"'), false);
});

test('quoted credentials and nested JSON arguments are redacted before storage', () => {
    const { redactText } = require('../dist/redaction.js');
    const text = redactText('password="hidden multiple words" authorization: Basic abcdefghijkl==');
    assert.equal(text.includes('hidden'), false);
    assert.equal(text.includes('abcdefgh'), false);
    const nested = redactText({ arguments: '{"writerToken":"private-writer","sql":"select 42"}' });
    assert.equal(JSON.stringify(nested).includes('private-writer'), false);
    assert.equal(JSON.stringify(nested).includes('select 42'), true);
});
