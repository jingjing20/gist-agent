import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentOrchestrator } = require('../apps/worker/dist/chat/agent-orchestrator.js');
const { GenerationExecutionError } = require('../apps/worker/dist/chat/generation-errors.js');
const { SqlQueryTool } = require('../apps/worker/dist/chat/tools/sql-query.tool.js');
const { GenerateChartTool } = require('../apps/worker/dist/chat/tools/generate-chart.tool.js');
const { ToolRegistry } = require('../apps/worker/dist/chat/tools/tool-registry.js');

const artifacts = {
    readQueryArtifact: async () => {
        throw new Error('not used by parser regression');
    },
    createQueryArtifact: async () => {
        throw new Error('not used by parser regression');
    },
    createChartArtifact: async () => {
        throw new Error('not used by parser regression');
    },
};
const sql = new SqlQueryTool({ execute: async () => ({ rows: [], columns: [], rowCount: 0, finalSql: '', wasFixed: false, isLimited: false }) }, artifacts);
const chart = new GenerateChartTool(artifacts);
const registry = new ToolRegistry([sql, chart]);
const call = (name, args) => ({ id: `${name}-id`, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const codeOf = (fn) => {
    try {
        fn();
    } catch (error) {
        assert.ok(error instanceof GenerationExecutionError);
        return error.code;
    }
    assert.fail('expected workflow error');
};

assert.equal(
    codeOf(() => new AgentOrchestrator().parseBatch([call('execute_sql_query', '{')], registry)),
    'INVALID_TOOL_ARGUMENTS'
);
const plan = { purpose: '验证', expectedGrain: '单行', expectedShape: 'scalar' };
assert.equal(
    codeOf(() => new AgentOrchestrator().parseBatch([call('execute_sql_query', { title: '查询', sql: '   ', plan })], registry)),
    'INVALID_TOOL_ARGUMENTS'
);
assert.equal(
    codeOf(() =>
        new AgentOrchestrator().parseBatch(
            [call('generate_chart', { queryArtifactId: 'artifact', chartType: 'bar', title: 'x', xField: 'label', yFields: [{ field: 'value', label: '值' }] })],
            registry
        )
    ),
    'INVALID_STATE_TRANSITION'
);
assert.equal(
    codeOf(() => new AgentOrchestrator().parseBatch([call('analyze_result', { needsChart: true })], registry)),
    'INVALID_STATE_TRANSITION'
);

const failedQueryWorkflow = new AgentOrchestrator();
failedQueryWorkflow.beforeTool('execute_sql_query');
failedQueryWorkflow.afterTool('execute_sql_query', false);
assert.equal(
    codeOf(() =>
        failedQueryWorkflow.parseBatch(
            [call('generate_chart', { queryArtifactId: 'artifact', chartType: 'bar', title: 'x', xField: 'label', yFields: [{ field: 'value', label: '值' }] })],
            registry
        )
    ),
    'INVALID_STATE_TRANSITION'
);

const workflow = new AgentOrchestrator();
const query = workflow.parseBatch([call('execute_sql_query', { title: '查询日活', sql: 'SELECT 1', plan })], registry)[0];
workflow.beforeTool(query.call.function.name);
assert.equal(workflow.getState(), 'QUERYING');
workflow.afterTool(query.call.function.name);
assert.equal(workflow.getState(), 'RESULT_VALIDATION');

const validChart = { queryArtifactId: 'artifact', chartType: 'line', title: '趋势', xField: 'day', yFields: [{ field: 'dau', label: 'DAU' }] };
workflow.parseBatch([call('generate_chart', validChart)], registry);
workflow.beforeTool('generate_chart');
assert.equal(workflow.getState(), 'CHART_PLANNING');
workflow.afterTool('generate_chart');
assert.equal(workflow.getState(), 'SYNTHESIZING');
assert.deepEqual(workflow.complete(), { kind: 'completed', state: 'COMPLETED' });

assert.equal(
    codeOf(() => new AgentOrchestrator().exhausted()),
    'MAX_AGENT_ITERATIONS_EXCEEDED'
);
assert.throws(() => chart.parseArguments({ ...validChart, yFields: [] }), /非空数组/);

console.log('phase2 orchestration regression: PASS');
