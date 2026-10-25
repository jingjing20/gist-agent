// Run after building. --real-model is explicit authorization to call the configured provider.
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');
const assert = require('node:assert/strict');
const requireWorker = createRequire(path.resolve(__dirname, '../apps/worker/package.json'));
// Keep this explicit verification scoped to the user's local AgentScope server.
process.env.LANGSMITH_TRACING = 'false';
process.env.LANGCHAIN_TRACING_V2 = 'false';
const { LlmClient } = requireWorker('@gist/llm');
const telemetry = requireWorker('@gist/telemetry');
const { AnalysisAgent } = require('../apps/worker/dist/analysis/analysis-agent.js');
const { resolveModelCapability } = require('../apps/worker/dist/chat/model-capabilities.js');
async function main() {
    if (!process.argv.includes('--real-model')) throw new Error('Pass --real-model to allow a small real provider request');
    const llm = new LlmClient();
    assert.equal(process.env.AGENTSCOPE_ENABLED, 'true', 'Enable AgentScope in local .env first');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Verification time limit reached')), 60000);
    const metrics = { llmCallCount: 0, toolCallCount: 0, sqlCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 };
    const messages = [
        {
            role: 'system',
            content:
                'This is a tiny synthetic instrumentation check. Call verify_fixture exactly once, then write one short English sentence using its result, then call finish_analysis separately with status complete, reason null and missingItems []. Do not ask questions. Never repeat the tool.',
        },
        { role: 'user', content: 'Use the verification tool and report whether its synthetic value is 42. Answer briefly in English.' },
    ];
    let toolCalls = 0;
    let traceId;
    try {
        const outcome = await telemetry.traceAgent(
            undefined,
            async (root) => {
                traceId = root?.traceId;
                const result = await new AnalysisAgent().run({
                    messages,
                    turnMessages: [],
                    metrics,
                    capability: resolveModelCapability(process.env.OPENAI_MODEL || 'gpt-4o'),
                    context: { signal: controller.signal, assertWritable: async () => {}, emitter: { send() {} } },
                    tools: [
                        {
                            name: 'verify_fixture',
                            definition: {
                                type: 'function',
                                function: {
                                    name: 'verify_fixture',
                                    description: 'Read a synthetic local fixture, value 42. No real database access.',
                                    parameters: { type: 'object', properties: {}, additionalProperties: false },
                                },
                            },
                            parseArguments: () => ({}),
                            execute: async () => {
                                toolCalls++;
                                return { succeeded: true, blocks: [], toolResult: JSON.stringify({ value: 42, synthetic: true }) };
                            },
                        },
                    ],
                    stream: async (history, tools) => {
                        if (metrics.llmCallCount > 4) throw new Error('Model call budget exceeded');
                        return llm.streamWithTools(history, tools, { signal: controller.signal, reasoningEnabled: false });
                    },
                    checkpoint: async () => {},
                    onFirstDelta: async () => {},
                    onContext() {},
                    onEvent() {},
                });
                root?.setOutput(result);
                return result;
            },
            { conversationId: randomUUID(), requestMessageId: randomUUID(), input: messages[1].content }
        );
        assert.equal(outcome.status, 'complete', 'Synthetic analysis did not complete');
        assert.ok(toolCalls >= 1, 'Model did not call the synthetic tool');
        assert.ok(metrics.llmCallCount <= 4, 'Model call budget exceeded');
        const receipt = await telemetry.flushTelemetry();
        assert.equal(receipt?.pending, 0, 'Telemetry was not fully accepted');
        console.log(
            JSON.stringify({
                traceId,
                toolCalls,
                modelCalls: metrics.llmCallCount,
                outcome: outcome.status,
                accepted: telemetry.telemetryDiagnostics()?.accepted,
                bodyCapture: process.env.AGENTSCOPE_CAPTURE_CONTENT === 'true',
            })
        );
    } finally {
        clearTimeout(timeout);
        await telemetry.shutdownTelemetry();
    }
}
main().catch(() => {
    console.error('AgentScope verification failed; check local service/configuration. No request or secret is printed.');
    process.exitCode = 1;
});
