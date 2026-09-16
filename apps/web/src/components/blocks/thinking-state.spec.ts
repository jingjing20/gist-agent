import assert from 'node:assert/strict';
import { initialThinkingExpanded, thinkingStateKey } from './thinking-state';

assert.equal(initialThinkingExpanded(true), true, '生成中应默认展开思考过程');
assert.equal(initialThinkingExpanded(false), false, '生成完成后应默认收起思考过程');
assert.notEqual(
    thinkingStateKey(true),
    thinkingStateKey(false),
    '生成状态结束时应重建折叠状态，以便自动收起'
);

console.log('thinking block state regression: ok');
