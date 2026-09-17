import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatService } = require('../apps/worker/dist/chat/chat.service.js');
const { GenerationExecutionError } = require('../apps/worker/dist/chat/generation-errors.js');
const { ToolRegistry } = require('../apps/worker/dist/chat/tools/tool-registry.js');

const chunk = (delta) => ({ choices: [{ delta }] });

function streamOf(chunks) {
    return (async function* () {
        yield* chunks;
    })();
}

function failingStream(error) {
    return (async function* () {
        yield chunk({ content: 'partial' });
        throw error;
    })();
}

class MockLlm {
    constructor(responses) {
        this.responses = [...responses];
    }

    isReasoningActive(requested) {
        return requested;
    }

    async streamWithTools() {
        assert.ok(this.responses.length > 0, 'mock LLM response queue exhausted');
        const response = this.responses.shift();
        if (response instanceof Error) throw response;
        return response;
    }
}

function createQueryTool({ executions, executeError, results = [] } = {}) {
    return {
        name: 'execute_sql_query',
        definition: {
            type: 'function',
            function: {
                name: 'execute_sql_query',
                description: 'mock query',
                parameters: { type: 'object' },
            },
        },
        parseArguments(value) {
            assert.equal(typeof value?.title, 'string');
            assert.equal(typeof value?.sql, 'string');
            return { title: value.title, sql: value.sql };
        },
        async execute(args) {
            executions?.push(args);
            if (executeError) throw executeError;
            if (results.length > 0) return results.shift();
            return {
                toolResult: JSON.stringify([{ value: 1 }]),
                blocks: [{ type: 'table', rows: [{ value: 1 }] }],
                succeeded: true,
            };
        },
    };
}

function createChartTool(executions) {
    return {
        name: 'generate_chart',
        definition: {
            type: 'function',
            function: { name: 'generate_chart', description: 'mock chart', parameters: { type: 'object' } },
        },
        parseArguments(value) {
            assert.equal(typeof value?.title, 'string');
            return value;
        },
        async execute(args) {
            executions.push(args);
            return { toolResult: 'chart rendered', blocks: [{ type: 'chart' }] };
        },
    };
}

function createService({ responses, tool = createQueryTool(), tools, generations, promptBuilder } = {}) {
    const registry = new ToolRegistry(tools ?? [tool]);
    const service = new ChatService({}, new MockLlm(responses ?? []), registry, promptBuilder ?? {}, { updateStateAsync() {} }, generations ?? {}, {});
    service.logger = { error() {}, warn() {}, log() {} };
    return service;
}

async function runLoop(service, options = {}) {
    const events = [];
    const messages = options.messages ?? [];
    const turnMessages = [];
    const blocks = [];
    let firstDeltaCount = 0;
    const outcome = await service.runAgentLoop(
        { send: (event) => events.push(event) },
        messages,
        turnMessages,
        blocks,
        null,
        1,
        options.reasoningEnabled ?? false,
        options.signal,
        async () => undefined,
        async () => {
            firstDeltaCount += 1;
        },
        async () => undefined
    );
    return { outcome, events, messages, turnMessages, blocks, firstDeltaCount };
}

async function expectCode(promise, code) {
    await assert.rejects(promise, (error) => {
        assert.ok(error instanceof GenerationExecutionError);
        assert.equal(error.code, code);
        return true;
    });
}

await expectCode(runLoop(createService({ responses: [streamOf([])] })), 'EMPTY_LLM_RESPONSE');
await expectCode(runLoop(createService({ responses: [streamOf([chunk({ reasoning_content: 'hidden only' })])] })), 'EMPTY_LLM_RESPONSE');

const direct = await runLoop(
    createService({
        responses: [streamOf([chunk({ content: '最终' }), chunk({ content: '答案' })])],
    })
);
assert.deepEqual(direct.outcome, { kind: 'completed', state: 'COMPLETED' });
assert.equal(direct.turnMessages.at(-1)?.content, '最终答案');
assert.deepEqual(
    direct.events.filter((event) => event.type === 'text_chunk').map((event) => event.content),
    ['最终', '答案']
);
assert.equal(direct.firstDeltaCount, 1);

const executions = [];
const toolLoop = await runLoop(
    createService({
        tool: createQueryTool({ executions }),
        responses: [
            streamOf([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: 'query-1',
                            function: { name: 'execute_sql_query', arguments: '{"title":"查询","sql":"SEL' },
                        },
                    ],
                }),
                chunk({ tool_calls: [{ index: 0, function: { arguments: 'ECT 1"}' } }] }),
            ]),
            streamOf([chunk({ content: '查询完成' })]),
        ],
    })
);
assert.deepEqual(executions, [{ title: '查询', sql: 'SELECT 1' }]);
assert.deepEqual(
    toolLoop.turnMessages.map((message) => message.role),
    ['assistant', 'tool', 'assistant']
);
assert.equal(toolLoop.turnMessages[1].tool_call_id, 'query-1');
assert.equal(toolLoop.outcome.kind, 'completed');

await expectCode(
    runLoop(
        createService({
            responses: [
                streamOf([
                    chunk({
                        tool_calls: [{ index: 0, id: 'query-invalid', function: { name: 'execute_sql_query', arguments: '{' } }],
                    }),
                ]),
            ],
        })
    ),
    'INVALID_TOOL_ARGUMENTS'
);

const retriedQueries = [];
const chartExecutions = [];
const retryingQueryTool = createQueryTool({
    executions: retriedQueries,
    results: [
        { toolResult: 'SQL 执行出错', blocks: [], succeeded: false },
        { toolResult: '[{"label":"A","value":1}]', blocks: [{ type: 'table' }], succeeded: true },
    ],
});
const retryAndChart = await runLoop(
    createService({
        tools: [retryingQueryTool, createChartTool(chartExecutions)],
        responses: [
            streamOf([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: 'query-failed',
                            function: { name: 'execute_sql_query', arguments: '{"title":"首次查询","sql":"SELECT bad"}' },
                        },
                    ],
                }),
            ]),
            streamOf([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: 'query-retry',
                            function: { name: 'execute_sql_query', arguments: '{"title":"修正查询","sql":"SELECT 1"}' },
                        },
                    ],
                }),
            ]),
            streamOf([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: 'chart-1',
                            function: { name: 'generate_chart', arguments: '{"title":"结果图"}' },
                        },
                    ],
                }),
            ]),
            streamOf([chunk({ content: '已完成修正查询与图表' })]),
        ],
    })
);
assert.deepEqual(
    retriedQueries.map((query) => query.sql),
    ['SELECT bad', 'SELECT 1']
);
assert.deepEqual(chartExecutions, [{ title: '结果图' }]);
assert.deepEqual(
    retryAndChart.turnMessages.map((message) => message.role),
    ['assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant']
);
assert.equal(retryAndChart.outcome.kind, 'completed');

await expectCode(runLoop(createService({ responses: [new Error('provider unavailable')] })), 'LLM_REQUEST_FAILED');
await expectCode(runLoop(createService({ responses: [failingStream(new Error('socket closed'))] })), 'LLM_REQUEST_FAILED');
await expectCode(
    runLoop(
        createService({
            tool: createQueryTool({ executeError: new Error('database unavailable') }),
            responses: [
                streamOf([
                    chunk({
                        tool_calls: [
                            {
                                index: 0,
                                id: 'query-error',
                                function: { name: 'execute_sql_query', arguments: '{"title":"查询","sql":"SELECT 1"}' },
                            },
                        ],
                    }),
                ]),
            ],
        })
    ),
    'TOOL_EXECUTION_FAILED'
);

const cancelled = new AbortController();
cancelled.abort(new GenerationExecutionError('CANCELLED', '已取消'));
await expectCode(runLoop(createService({ responses: [] }), { signal: cancelled.signal }), 'CANCELLED');

const repeatedToolCalls = Array.from({ length: 15 }, (_, index) =>
    streamOf([
        chunk({
            tool_calls: [
                {
                    index: 0,
                    id: `query-${index}`,
                    function: { name: 'execute_sql_query', arguments: '{"title":"查询","sql":"SELECT 1"}' },
                },
            ],
        }),
    ])
);
await expectCode(runLoop(createService({ responses: repeatedToolCalls })), 'MAX_AGENT_ITERATIONS_EXCEEDED');

let finalized;
const generations = {
    emitter: () => ({ send() {} }),
    checkpointMessage: async () => undefined,
    markFirstDelta: async () => undefined,
    assertWritable: async () => undefined,
    isCancelRequested: async () => false,
    drain: async () => undefined,
    finalize: async (_generation, status, errorDetail, errorCode, terminal, payload) => {
        finalized = { status, errorDetail, errorCode, terminal, payload };
        return true;
    },
};
const emptyGenerationService = createService({
    responses: [streamOf([])],
    generations,
    promptBuilder: {
        buildSystemPrompt: async () => 'system',
        buildMessages: async () => [{ role: 'system', content: 'system' }],
    },
});
await emptyGenerationService.runGeneration(
    {
        id: 'generation-empty',
        conversationId: 'conversation-1',
        userId: 1,
        messageId: 'response-1',
        requestMessageId: 'request-1',
        reasoningEnabled: false,
        contextUpperBound: new Date(),
        writerToken: 'writer-1',
    },
    'question',
    null,
    () => false
);
assert.equal(finalized.status, 'failed');
assert.equal(finalized.errorCode, 'EMPTY_LLM_RESPONSE');
assert.equal(finalized.terminal.status, 'failed');
assert.equal(finalized.terminal.errorCode, 'EMPTY_LLM_RESPONSE');
assert.equal(finalized.payload.blocks.at(-1)?.errorCode, 'EMPTY_LLM_RESPONSE');

console.log('phase2 agent loop integration: PASS');
