import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AnalysisAgent } = require('../apps/worker/dist/analysis/analysis-agent.js');
const call = (name, id, args = {}) => ({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] });
async function run(withNarration, failedQuery = false) {
    const events = [];
    let round = 0;
    const stageNarration = [];
    let queryAttempts = 0;
    const replies = [
        [{ reasoning_content: '私有推理不可显示' }, call('list_schema', 'catalog')],
        [...(withNarration ? [{ content: '我先读取相关表结构。' }] : []), call('get_schema', 'schema', { table: 'product_users' })],
        [call('update_analysis_state', 'state')],
        [call('execute_sql_query', 'query', { title: '用户数', sql: 'SELECT COUNT(*) FROM product_users' })],
        [call('generate_chart', 'chart', { queryArtifactId: 'evidence', title: '用户数' })],
        [{ content: '用户总数为 ' }, { content: '1570。' }],
        [call('finish_analysis', 'finish', { status: 'complete', reason: null, missingItems: [] })],
    ];
    if (failedQuery) replies.splice(4, 0, [call('execute_sql_query', 'query-retry', { title: '用户数', sql: 'SELECT COUNT(id) FROM product_users' })]);
    const tools = ['list_schema', 'get_schema', 'update_analysis_state', 'execute_sql_query', 'generate_chart'].map((name) => ({
        name,
        definition: { type: 'function', function: { name, parameters: { properties: { table: {}, title: {}, sql: {}, queryArtifactId: {} } } } },
        parseArguments: (v) => v,
        execute: async (args, ctx) => {
            if (name !== 'update_analysis_state') {
                stageNarration.push(events.filter((e) => e.type === 'text_chunk').at(-1)?.content || '');
            }
            if (name === 'generate_chart') ctx.emitter.send({ type: 'chart', chartData: { title: args.title } });
            if (name === 'execute_sql_query' && ++queryAttempts === 1 && failedQuery)
                return {
                    succeeded: false,
                    blocks: [],
                    toolResult: JSON.stringify({ errorCode: 'SQL_PARSE_FAILED', message: 'parser cannot parse CAST(timestamp)' }),
                };
            return { succeeded: true, toolResult: JSON.stringify(name === 'execute_sql_query' ? { queryArtifactId: 'evidence', returnedRowCount: 1 } : {}), blocks: [] };
        },
    }));
    await new AnalysisAgent().run({
        messages: [{ role: 'user', content: '请分析用户数' }],
        turnMessages: [],
        tools,
        context: { signal: new AbortController().signal, assertWritable: async () => {}, emitter: { send: (e) => events.push(e) } },
        capability: { contextWindow: 100000, responseReserve: 1000 },
        metrics: { llmCallCount: 0, toolCallCount: 0, sqlCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 },
        stream: async () => {
            assert.ok(round < replies.length, '不得额外请求模型补写旁白');
            const reply = replies[round++];
            return (async function* () {
                for (const delta of reply) yield { choices: [{ delta }] };
            })();
        },
        onEvent: (e) => events.push(e),
        checkpoint: async () => {},
        onFirstDelta: async () => {},
        onContext: () => {},
    });
    for (const narration of stageNarration) assert.match(narration, /目录|表结构|查询|图表/, '无模型旁白时每个实际阶段必须在执行前有简短说明');
    const text = events
        .filter((e) => e.type === 'text_chunk')
        .map((e) => e.content)
        .join('');
    assert.doesNotMatch(text, /私有推理|分析状态|SELECT|完成状态/, '内部推理和实现细节不能进入正文');
    if (withNarration) assert.equal((text.match(/表结构/g) || []).length, 1, '模型已有说明时不重复补写');
    const chartIndex = events.findIndex((e) => e.type === 'chart');
    const finalIndex = events.findIndex((e) => e.type === 'text_chunk' && e.content.includes('用户总数'));
    assert.ok(chartIndex > 0 && finalIndex > chartIndex, '过程说明、图表、最终结论严格依次追加');
    assert.match(text, /\n\n用户总数为 1570。/, '不同阶段不能拼成同一段');
    if (failedQuery) {
        assert.match(text, /查询未成功.*调整后重新核对/, '失败时只提供简短调整说明');
        assert.doesNotMatch(text, /parser|CAST|SQL_PARSE_FAILED/, '技术错误不得泄漏到正文');
        assert.ok(
            events.some((e) => e.type === 'analysis_activity' && e.activity.status === 'warning' && e.activity.warning.includes('parser')),
            '详细错误保留在卡片'
        );
        assert.ok(
            events.some((e) => e.type === 'analysis_activity' && e.activity.details.some((d) => d.label === '提交 SQL')),
            '失败查询详情可在卡片核对'
        );
    }
}
await run(false);
await run(true);
await run(false, true);
console.log('PASS: silent and narrated model rounds, real-action fallback, no duplicate prose, chart ordering, paragraph boundaries and no extra model calls');
