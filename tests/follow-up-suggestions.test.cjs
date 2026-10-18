// Run after pnpm --filter @gist/worker... build
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildFollowUpContext, generateSuggestions } = require('../apps/worker/dist/analysis/follow-up-suggestions.js');
const state = { question: 'DAU趋势？', timeRange: null, comparisonRange: null, grain: 'day', filters: [], temporaryNotes: [], openQuestions: [], hypotheses: [] };
const outcome = { status: 'complete', reason: null, missingItems: [] };
test('passes authorized source fields and final answer without process narration', () => {
    const context = buildFollowUpContext({
        state,
        outcome,
        schema: [
            {
                table: 'metrics',
                columns: [
                    { name: 'date', type: 'date' },
                    { name: 'active_users', type: 'integer', description: 'DAU' },
                ],
            },
        ],
        blocks: [
            { type: 'text', content: '我先查数据' },
            { type: 'text', content: 'DAU先升后平稳' },
            { type: 'text', content: '', analysis: {} },
        ],
    });
    assert.equal(context.answer, 'DAU先升后平稳');
    assert.equal(context.schema[0].columns[1].name, 'active_users');
});
test('large schema is compacted without silently skipping recommendations', () => {
    const context = buildFollowUpContext({
        state,
        outcome,
        schema: Array.from({ length: 8 }, (_, i) => ({
            table: `t${i}`,
            columns: Array.from({ length: 100 }, (_, j) => ({ name: `field${j}`, type: 'text', description: '说明'.repeat(500) })),
        })),
        blocks: [{ type: 'text', content: '结论'.repeat(6000) }],
    });
    assert.ok(JSON.stringify(context).length <= 16000);
    assert.ok(context.schema[0].columns.length > 0);
});
function input(raw, diagnostics) {
    return {
        question: '原问题',
        context: {},
        signal: new AbortController().signal,
        metrics: { llmCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 },
        onDiagnostic: (d) => diagnostics.push(d),
        llm: {
            async streamWithTools() {
                return (async function* () {
                    yield { choices: [{ delta: { content: raw } }] };
                })();
            },
        },
    };
}
test('structured recommendations are filtered and diagnosed', async () => {
    const diagnostics = [];
    const items = await generateSuggestions(input(JSON.stringify({ questions: ['原问题', '按渠道看？', '按渠道看？', ''], emptyReason: null }), diagnostics));
    assert.deepEqual(
        items.map((i) => i.text),
        ['按渠道看？']
    );
    assert.equal(diagnostics[0].status, 'generated');
    assert.equal(diagnostics[0].filteredCount, 3);
});
test('empty result preserves model explanation', async () => {
    const diagnostics = [];
    assert.deepEqual(await generateSuggestions(input('{"questions":[],"emptyReason":"缺少可细分字段"}', diagnostics)), []);
    assert.equal(diagnostics[0].status, 'empty');
    assert.equal(diagnostics[0].reason, '缺少可细分字段');
});
test('malformed output fails instead of being treated as no useful recommendations', async () => {
    await assert.rejects(generateSuggestions(input('{"questions":[7],"emptyReason":null}', [])));
});
test('already cancelled requests never call the model', async () => {
    const request = input('{"questions":[],"emptyReason":"无"}', []);
    request.signal = AbortSignal.abort(new Error('cancelled'));
    request.llm.streamWithTools = () => {
        assert.fail('model must not be called');
    };
    await assert.rejects(generateSuggestions(request), /cancelled/);
});

test('valid questions survive an unnecessary model explanation', async () => {
    const diagnostics = [];
    const items = await generateSuggestions(input('{"questions":["我想按月对比？"],"emptyReason":"已有下一步"}', diagnostics));
    assert.equal(items.length, 1);
    assert.equal(diagnostics[0].status, 'generated');
});

test('oversized external context is diagnosed without calling the model', async () => {
    const diagnostics = [];
    const request = input('', diagnostics);
    request.context = { text: 'x'.repeat(19000) };
    request.llm.streamWithTools = () => assert.fail('model must not be called');
    assert.deepEqual(await generateSuggestions(request), []);
    assert.equal(diagnostics[0].status, 'context_too_large');
});

test('cancellation during streaming discards partial recommendations', async () => {
    const controller = new AbortController();
    const request = input('', []);
    request.signal = controller.signal;
    request.llm.streamWithTools = async () =>
        (async function* () {
            yield { choices: [{ delta: { content: '{"questions":[' } }] };
            controller.abort(new Error('cancelled while streaming'));
            yield { choices: [{ delta: { content: '"问题"],"emptyReason":null}' } }] };
        })();
    await assert.rejects(generateSuggestions(request), /cancelled while streaming/);
});
