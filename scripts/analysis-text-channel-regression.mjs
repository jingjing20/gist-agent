import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AnalysisAgent } = require('../apps/worker/dist/analysis/analysis-agent.js');
async function run(question, replies, capturedEvents = []) {
    const events = capturedEvents;
    const messages = [
        { role: 'system', content: '回答问题' },
        { role: 'user', content: question },
    ];
    const tool = {
        name: 'list_schema',
        definition: { type: 'function', function: { name: 'list_schema', parameters: { type: 'object', properties: {} } } },
        parseArguments: (v) => v,
        execute: async () => ({ succeeded: true, toolResult: '{"tables":[]}', blocks: [] }),
    };
    let calls = 0;
    const outcome = await new AnalysisAgent().run({
        messages,
        turnMessages: [],
        tools: [tool],
        context: { signal: new AbortController().signal, assertWritable: async () => {} },
        capability: { contextWindow: 100000, responseReserve: 1000 },
        metrics: { llmCallCount: 0, toolCallCount: 0, sqlCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 },
        stream: async () => {
            const reply = replies[calls++];
            assert.ok(reply, 'unexpected extra model call');
            return (async function* () {
                for (const delta of typeof reply === 'function' ? reply() : reply) yield { choices: [{ delta }] };
            })();
        },
        onEvent: (event) => events.push(event),
        checkpoint: async () => {},
        onFirstDelta: async () => {},
        onContext: () => {},
    });
    return { events, outcome, calls };
}
const liveEvents = [];
await run(
    '首周激活率是多少？',
    [
        function* () {
            yield { content: '首周激活率' };
            assert.equal(
                liveEvents
                    .filter((e) => e.type === 'text_chunk')
                    .map((e) => e.content)
                    .join(''),
                '首周激活率',
                '中文首段应在模型结束前实时发布'
            );
            yield { content: '约为 49.3%。' };
            assert.equal(
                liveEvents
                    .filter((e) => e.type === 'text_chunk')
                    .map((e) => e.content)
                    .join(''),
                '首周激活率约为 49.3%。',
                '后续分片应实时发布'
            );
        },
    ],
    liveEvents
);
const preamble = "I'll start by exploring the schema to understand what data is available for this analysis.";
const toolCall = { tool_calls: [{ index: 0, id: 'schema-1', function: { name: 'list_schema', arguments: '{}' } }] };
const answer = '首周激活率约为 49.3%，不同规模和行业存在差异。';
const h = await run('首周激活率是多少？', [[{ content: preamble }, toolCall], [{ content: answer }]]);
assert.equal(
    h.events
        .filter((e) => e.type === 'text_chunk')
        .map((e) => e.content)
        .join(''),
    answer,
    '工具轮英文旁白不能泄漏到正文'
);
const english = 'The activation rate is about half of all registered users and varies across customer segments.';
const corrected = await run('首周激活率是多少？', [[{ content: english }], [{ content: answer }]]);
assert.equal(corrected.calls, 2);
assert.equal(
    corrected.events
        .filter((e) => e.type === 'text_chunk')
        .map((e) => e.content)
        .join(''),
    answer,
    '不合语言要求的回答应在展示前重试'
);
const allowed = await run('请用英文回答首周激活率', [[{ content: english }]]);
assert.equal(allowed.calls, 1);
assert.equal(allowed.outcome.blocks[0].content, english);
const technical = '激活率按 `activated_at` 与 `signup_at` 的间隔计算。\n```sql\nSELECT COUNT(*) FROM product_users WHERE activated_at IS NOT NULL;\n```';
const identifiers = await run('怎么算激活率？', [[{ content: technical }]]);
assert.equal(identifiers.calls, 1);
const rejectedEvents = [];
await assert.rejects(run('首周激活率是多少？', [[{ content: english }], [{ content: english }]], rejectedEvents), { code: 'RESPONSE_LANGUAGE_MISMATCH' });
assert.ok(!rejectedEvents.some((event) => event.type === 'text_chunk'), '修正失败也不能先展示英文回答');
const narrativeEvents = [];
await run(
    '请分析激活率',
    [
        function* () {
            yield { content: '先核对激活口径。' };
            assert.equal(narrativeEvents.at(-1).content, '先核对激活口径。', '中文说明应在工具开始前实时展示');
            yield toolCall;
        },
        [{ content: answer }],
    ],
    narrativeEvents
);
const chunkedEnglish = preamble.match(/.{1,3}/g).map((content) => ({ content }));
const chunked = await run('请分析激活率', [[...chunkedEnglish, toolCall], [{ content: answer }]]);
assert.equal(
    chunked.events
        .filter((e) => e.type === 'text_chunk')
        .map((e) => e.content)
        .join(''),
    answer,
    '英文按小分片到达也不得泄漏'
);
console.log('PASS: live Chinese narration and answers, withheld English, language retry, explicit English and SQL');
