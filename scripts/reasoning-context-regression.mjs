import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PromptBuilder } = require('../apps/worker/dist/chat/prompt-builder.js');
const { createStreamRequest } = require('../packages/llm/dist/index.js');

const user = (id, content = '分析趋势') => ({
    id,
    role: 'user',
    content,
    blocks: [],
    llm_messages: [],
    created_at: '2026-09-13T12:00:00.000Z',
});

const assistant = (id, llmMessages, blocks = []) => ({
    id,
    role: 'assistant',
    content: '',
    blocks,
    llm_messages: llmMessages,
    created_at: '2026-09-13T12:00:00.000Z',
});

async function buildMessages(rows, options) {
    const builder = new PromptBuilder({}, { getMessages: async () => rows });
    return builder.buildMessages('conversation', 4, 'system', options);
}

const currentResponse = assistant('current-response', [{ role: 'assistant', content: '', reasoning_content: '尚未完成的推理' }]);
const withoutCurrentResponse = await buildMessages([user('current-user'), currentResponse], { reasoningEnabled: true, excludeMessageIds: ['current-response'] });
assert.deepEqual(
    withoutCurrentResponse.map((message) => message.role),
    ['system', 'user']
);

const compatibleHistory = assistant('completed-response', [
    {
        role: 'assistant',
        content: '准备查询',
        reasoning_content: '先检查数据范围',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'execute_sql_query', arguments: '{"sql":"select 1"}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: '[]' },
    { role: 'assistant', content: '没有数据', reasoning_content: '根据结果给出结论' },
]);
const legacyHistory = assistant('legacy-response', [], [{ type: 'text', content: '旧回复' }]);
const reasoningHistory = await buildMessages([user('old-user'), legacyHistory, user('new-user'), compatibleHistory], { reasoningEnabled: true });
const historicalAssistants = reasoningHistory.filter((message) => message.role === 'assistant');
assert.equal(historicalAssistants.length, 2);
assert.ok(historicalAssistants.every((message) => typeof message.reasoning_content === 'string'));
assert.ok(!reasoningHistory.some((message) => message.content === '旧回复'));

const tools = [{ type: 'function', function: { name: 'test', parameters: { type: 'object', properties: {} } } }];
const enabledRequest = createStreamRequest({
    model: 'deepseek-v4-pro',
    messages: reasoningHistory,
    tools,
    reasoningEnabled: true,
    supportsThinkingControl: true,
    reasoningEffort: 'high',
});
assert.deepEqual(enabledRequest.thinking, { type: 'enabled' });
assert.equal(enabledRequest.reasoning_effort, 'high');

const disabledRequest = createStreamRequest({
    model: 'deepseek-v4-pro',
    messages: withoutCurrentResponse,
    tools,
    reasoningEnabled: false,
    supportsThinkingControl: true,
});
assert.deepEqual(disabledRequest.thinking, { type: 'disabled' });
assert.ok(!('reasoning_effort' in disabledRequest));

const genericRequest = createStreamRequest({
    model: 'gpt-4o',
    messages: withoutCurrentResponse,
    tools,
    reasoningEnabled: false,
    supportsThinkingControl: false,
});
assert.ok(!('thinking' in genericRequest));

const nonReasoningHistory = await buildMessages([user('plain-user'), compatibleHistory], { reasoningEnabled: false });
assert.ok(nonReasoningHistory.filter((message) => message.role === 'assistant').every((message) => !('reasoning_content' in message)));

console.log('reasoning context regression: PASS');
