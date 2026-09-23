import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AnalysisAgent } = require('../apps/worker/dist/analysis/analysis-agent.js');
const { SqlExecutorAgent } = require('../apps/worker/dist/chat/agents/sql-executor.js');
let checks = 0;
const check = async (name, fn) => {
    await fn();
    checks++;
    console.log(`PASS ${name}`);
};
let id = 0;
const call = (name, args) => ({ id: `call-${++id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const answer = (kind = 'answer', findings = []) => ({
    kind,
    ...(kind === 'partial' ? { reason: '查询预算已用完' } : {}),
    answer: { summary: '分析结果', findings, limitations: kind === 'partial' ? ['尚未完成验证'] : [], unresolvedQuestions: [] },
});
const stream = (calls) =>
    (async function* () {
        for (let index = 0; index < calls.length; index++) {
            const c = calls[index];
            yield { choices: [{ delta: { tool_calls: [{ index, id: c.id, function: { name: c.function.name, arguments: c.function.arguments.slice(0, 5) } }] } }] };
            yield { choices: [{ delta: { tool_calls: [{ index, function: { arguments: c.function.arguments.slice(5) } }] } }] };
        }
    })();
function harness(responses, extras = {}) {
    const executions = [],
        seen = [],
        events = [],
        reports = [],
        messages = [],
        turnMessages = [];
    const controller = new AbortController();
    const sql = {
        name: 'execute_sql_query',
        definition: { type: 'function', function: { name: 'execute_sql_query', parameters: { type: 'object', properties: { title: {}, sql: {}, plan: {} } } } },
        parseArguments: (v) => v,
        execute: async (args) => {
            executions.push(args.sql);
            return { succeeded: true, blocks: [], toolResult: JSON.stringify({ queryArtifactId: `a${executions.length}`, isLimited: false, data: [{ n: 1 }] }) };
        },
    };
    const options = {
        messages,
        turnMessages,
        tools: [sql],
        context: { signal: controller.signal, assertWritable: async () => {}, emitter: { send: (e) => events.push(e) } },
        metrics: { llmCallCount: 0, toolCallCount: 0, sqlCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 },
        capability: { contextWindow: 100000, responseReserve: 1000 },
        stream: async (history, definitions) => {
            seen.push({ history: structuredClone(history), names: definitions.map((t) => t.function.name) });
            assert.ok(responses.length, 'Mock responses exhausted');
            const next = responses.shift();
            return typeof next === 'function' ? next() : stream(next);
        },
        onEvent: (e) => events.push(e),
        checkpoint: async () => {},
        onFirstDelta: async () => {},
        onContext: (r) => reports.push(r),
        ...extras,
    };
    return { options, sql, controller, executions, seen, events, messages, turnMessages, reports, run: () => new AnalysisAgent().run(options) };
}

const failures = [];
async function regression(name, fn) {
    try {
        await check(name, fn);
    } catch (error) {
        failures.push(name);
        console.error(`FAIL ${name}: ${error.message}`);
    }
}
await regression('PostgreSQL monthly revenue query remains authorized', async () => {
    const executor = new SqlExecutorAgent({}, {});
    const sql = `SELECT date_trunc('month', i.invoice_date)::date AS month,
        coalesce(ca.region, 'unknown') AS region,
        sum(coalesce(i.paid_amount,0) - coalesce(i.refunded_amount,0)) AS net_revenue,
        count(*) AS invoices
        FROM invoices i LEFT JOIN customer_accounts ca ON ca.id = i.account_id
        WHERE i.invoice_date >= '2025-09-01' AND i.invoice_date < '2026-09-01'
        GROUP BY 1, 2 ORDER BY 1, 2`;
    const validated = executor.validate(sql, ['invoices', 'customer_accounts']);
    assert.match(executor.ensureLimit(validated.astResult, validated.parser), /LIMIT 1000/i);
    executor.validate(sql, ['invoices', 'customer_accounts'], [{ columnName: 'account_name', access: 'deny' }]);
    assert.throws(() => executor.validate(sql, ['invoices']), /允许范围/);
    assert.throws(() => executor.validate(sql, ['invoices', 'customer_accounts'], [{ columnName: 'paid_amount', access: 'deny' }]), /不允许/);
});
await regression('clarification repairs rejected fields before exhausting calls', async () => {
    const malformed = { kind: 'clarification', question: '确认收入与时间范围？', explanation: '需要确认', answer: answer().answer };
    const h = harness([]);
    h.options.stream = async (history) => {
        const feedback = history.filter((m) => m.role === 'tool').at(-1)?.content ?? '';
        const repaired = /explanation/.test(feedback) && /answer/.test(feedback) && /question/.test(feedback);
        return stream([call('submit_analysis', repaired ? { kind: 'clarification', question: malformed.question } : malformed)]);
    };
    assert.equal((await h.run()).kind, 'clarification');
    assert.equal(h.options.metrics.llmCallCount, 2);
});
await regression('invalid submissions report protocol failure, not a quota error', async () => {
    const invalid = { kind: 'clarification', question: 'Confirm?', explanation: 'extra' };
    const h = harness([[call('submit_analysis', invalid)], [call('submit_analysis', invalid)], [call('submit_analysis', invalid)]]);
    await assert.rejects(h.run(), { code: 'ANALYSIS_NO_PROGRESS' });
    const feedback = JSON.parse(h.turnMessages.at(-1).content);
    assert.equal(feedback.requiredKind, undefined);
    assert.match(feedback.submissionGuide, /reason/);
});
await regression('parser rejection is repairable and never executes unchecked SQL', async () => {
    const { SqlQueryTool } = require('../apps/worker/dist/chat/tools/sql-query.tool.js');
    const sql = 'SELECT region, COUNT(*) AS accounts, COUNT(*) FILTER (WHERE region IS NULL) AS nulls FROM customer_accounts GROUP BY region ORDER BY accounts DESC;';
    let executions = 0;
    const executor = new SqlExecutorAgent(
        {
            queryReadOnlyWithFields: async () => {
                executions++;
                return { rows: [], fields: [] };
            },
        },
        {
            getAllowedTableNames: async () => ['customer_accounts'],
            getColumnPolicies: async () => [],
        }
    );
    const tool = new SqlQueryTool(executor, { createQueryArtifact: async () => ({ id: 'a1', resultContentHash: 'h' }) });
    const args = { title: '检查地区', sql, plan: { purpose: '检查地区', expectedGrain: '每地区', expectedShape: 'category' } };
    const h = harness(
        [[call('execute_sql_query', args)], [call('execute_sql_query', { ...args, sql: sql.replace('AS nulls', 'AS "nulls"') })], [call('submit_analysis', answer())]],
        { tools: [tool] }
    );
    Object.assign(h.options.context, { userId: 4, datasourceId: 1, generationId: 'g', conversationId: 'c', schemaContextVersion: 'v' });
    assert.equal((await h.run()).kind, 'answer');
    assert.equal(executions, 1);
    const feedback = JSON.parse(h.turnMessages.find((m) => m.role === 'tool').content);
    assert.equal(feedback.errorCode, 'SQL_VALIDATION_FAILED');
    assert.equal(feedback.retryable, true);
});
await regression('analysis steps remain ordered with completion summaries', async () => {
    const h = harness([
        [call('execute_sql_query', { title: '核对数据', sql: 'SELECT 1', plan: { purpose: '核对', expectedGrain: '一行', expectedShape: 'scalar' } })],
        [call('submit_analysis', answer())],
    ]);
    await h.run();
    assert(!h.events.some((e) => e.type === 'log_remove'));
    assert.deepEqual(
        h.events.filter((e) => e.type === 'log').map((e) => e.title),
        ['分析步骤 1', '分析步骤 2']
    );
    assert.deepEqual(
        h.events.filter((e) => e.type === 'log_update').map((e) => e.title),
        ['分析步骤 1', '分析步骤 2']
    );
    assert(h.events.filter((e) => e.type === 'log_update').every((e) => e.content.startsWith('已完成')));
});
if (failures.length) process.exitCode = 1;
