import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStreamRequest } = require('../packages/llm/dist/index.js');
const withoutCurrentResponse = [
    { role: 'system', content: 'system' },
    { role: 'user', content: '分析趋势' },
];
const reasoningHistory = withoutCurrentResponse;
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

console.log('LLM reasoning request controls: PASS');
