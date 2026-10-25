const { test } = require('node:test');
const assert = require('node:assert/strict');
const telemetry = require('../dist/index.js');
test('disabled integration keeps callback value and original error without network', async () => {
    process.env.AGENTSCOPE_ENABLED = 'false';
    const value = { ok: true };
    assert.equal(await telemetry.traceAgent(undefined, async () => value), value);
    const error = new Error('business');
    await assert.rejects(
        telemetry.traceAgent(undefined, async () => {
            throw error;
        }),
        (e) => e === error
    );
});
test('real SDK preserves concurrent parentage, tool failures, stream chunks/cancellation, and hard-disables every body', async () => {
    process.env.AGENTSCOPE_ENABLED = 'true';
    process.env.AGENTSCOPE_ENDPOINT = 'http://localhost:3100';
    process.env.AGENTSCOPE_API_KEY = 'synthetic-test';
    process.env.AGENTSCOPE_CAPTURE_CONTENT = 'true'; // Not an accepted override: privacy stays off.
    const original = globalThis.fetch;
    const events = [];
    globalThis.fetch = async (_url, init) => {
        const batch = JSON.parse(init.body);
        events.push(...batch.events);
        return new Response(JSON.stringify({ accepted: batch.events.length, duplicates: 0, request_id: 'test' }), { status: 202 });
    };
    try {
        await Promise.all(
            ['one', 'two'].map((id) =>
                telemetry.traceAgent(id, async (root) => {
                    await telemetry.traceTool('fixture', async () => ({ succeeded: false }));
                    await telemetry.traceModel('test-model', async (span) => {
                        span?.setUsage(telemetry.modelUsage({ prompt_tokens: 2, completion_tokens: 1 }));
                        return 'secret-output';
                    });
                    const chunk = { choices: [{ delta: { content: 'secret-stream' }, finish_reason: 'stop' }] };
                    const stream = await telemetry.traceModelStream('stream-model', async () => ({
                        async *[Symbol.asyncIterator]() {
                            yield chunk;
                        },
                    }));
                    for await (const received of stream) assert.equal(received, chunk);
                    if (id === 'one') {
                        const upstream = new Error('upstream-stream-private');
                        const broken = await telemetry.traceModelStream('broken-model', async () => ({
                            async *[Symbol.asyncIterator]() {
                                throw upstream;
                            },
                        }));
                        await assert.rejects(
                            async () => {
                                for await (const chunk of broken) void chunk;
                            },
                            (e) => e === upstream
                        );
                    } else {
                        let returned = false;
                        const early = await telemetry.traceModelStream('early-return-model', async () => ({
                            async *[Symbol.asyncIterator]() {
                                try {
                                    yield chunk;
                                    yield chunk;
                                } finally {
                                    returned = true;
                                }
                            },
                        }));
                        for await (const part of early) {
                            assert.equal(part, chunk);
                            break;
                        }
                        assert.equal(returned, true);
                    }

                    if (id === 'two') root.end({ status: 'canceled' });
                })
            )
        );
        const error = new Error('upstream secret');
        await assert.rejects(
            telemetry.traceAgent('error', async () => {
                throw error;
            }),
            (e) => e === error
        );
        await telemetry.flushTelemetry();
        const starts = events.filter((e) => e.type === 'span.started');
        const ends = events.filter((e) => e.type === 'span.ended');
        const roots = starts.filter((e) => e.payload.parent_span_id === null);
        assert.equal(roots.length, 3);
        for (const root of roots.slice(0, 2)) assert.equal(starts.filter((e) => e.payload.parent_span_id === root.span_id).length, 4);
        assert.equal(ends.filter((e) => e.payload.execution_status === 'canceled').length, 2);
        assert.equal(ends.filter((e) => e.payload.execution_status === 'error').length, 4);
        assert.equal(
            events.every((e) => (e.type === 'span.started' ? e.payload.input.status === 'disabled' : e.payload.output.status === 'disabled')),
            true
        );
        assert.equal(JSON.stringify(events).includes('secret-output'), false);
        assert.equal(JSON.stringify(events).includes('secret-stream'), false);
        assert.equal(JSON.stringify(events).includes('upstream secret'), false);
        assert.equal(telemetry.telemetryDiagnostics().queued, 0);
    } finally {
        await telemetry.shutdownTelemetry();
        globalThis.fetch = original;
    }
});
