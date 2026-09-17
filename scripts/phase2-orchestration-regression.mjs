import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentOrchestrator } = require('../apps/worker/dist/chat/agent-orchestrator.js');
const { GenerationExecutionError } = require('../apps/worker/dist/chat/generation-errors.js');
const { SqlQueryTool } = require('../apps/worker/dist/chat/tools/sql-query.tool.js');
const { GenerateChartTool } = require('../apps/worker/dist/chat/tools/generate-chart.tool.js');
const { ToolRegistry } = require('../apps/worker/dist/chat/tools/tool-registry.js');

const sql = new SqlQueryTool({ execute: async () => ({ rows: [], columns: [], rowCount: 0, finalSql: '', wasFixed: false }) });
const chart = new GenerateChartTool();
const registry = new ToolRegistry([sql, chart]);
const call = (name, args) => ({ id: `${name}-id`, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const codeOf = (fn) => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof GenerationExecutionError);
    return error.code;
  }
  assert.fail('expected workflow error');
};

assert.equal(codeOf(() => new AgentOrchestrator().parseBatch([call('execute_sql_query', '{')], registry)), 'INVALID_TOOL_ARGUMENTS');
assert.equal(codeOf(() => new AgentOrchestrator().parseBatch([call('execute_sql_query', { title: '查询', sql: '   ' })], registry)), 'INVALID_TOOL_ARGUMENTS');
assert.equal(codeOf(() => new AgentOrchestrator().parseBatch([call('generate_chart', { chartType: 'bar', title: 'x', xAxis: ['a'], series: [{ name: 'n', data: [1] }] })], registry)), 'INVALID_STATE_TRANSITION');
assert.equal(codeOf(() => new AgentOrchestrator().parseBatch([call('analyze_result', { needsChart: true })], registry)), 'INVALID_STATE_TRANSITION');

const failedQueryWorkflow = new AgentOrchestrator();
failedQueryWorkflow.beforeTool('execute_sql_query');
failedQueryWorkflow.afterTool('execute_sql_query', false);
assert.equal(codeOf(() => failedQueryWorkflow.parseBatch([call('generate_chart', { chartType: 'bar', title: 'x', xAxis: ['a'], series: [{ name: 'n', data: [1] }] })], registry)), 'INVALID_STATE_TRANSITION');

const workflow = new AgentOrchestrator();
const query = workflow.parseBatch([call('execute_sql_query', { title: '查询日活', sql: 'SELECT 1' })], registry)[0];
workflow.beforeTool(query.call.function.name);
assert.equal(workflow.getState(), 'QUERYING');
workflow.afterTool(query.call.function.name);
assert.equal(workflow.getState(), 'RESULT_VALIDATION');

const validChart = { chartType: 'line', title: '趋势', xAxis: ['周一', '周二'], series: [{ name: 'DAU', data: [1, 2] }] };
workflow.parseBatch([call('generate_chart', validChart)], registry);
workflow.beforeTool('generate_chart');
assert.equal(workflow.getState(), 'CHART_PLANNING');
workflow.afterTool('generate_chart');
assert.equal(workflow.getState(), 'SYNTHESIZING');
assert.deepEqual(workflow.complete(), { kind: 'completed', state: 'COMPLETED' });

assert.equal(codeOf(() => new AgentOrchestrator().exhausted()), 'MAX_AGENT_ITERATIONS_EXCEEDED');
assert.throws(() => chart.parseArguments({ ...validChart, series: [{ name: 'DAU', data: [1] }] }), /长度不一致/);

console.log('phase2 orchestration regression: PASS');
