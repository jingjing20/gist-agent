import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rankSchemaCatalog } from '../apps/worker/dist/database/schema.service.js';
import { RetentionService } from '../apps/worker/dist/retention/retention.service.js';
import { PHASE6_SCHEMA_SQL } from '../packages/database/dist/index.js';
import { scoreAgentCase, summarizeReport } from './phase6-evaluation-core.mjs';

const tables = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    datasource_id: 1,
    schema_name: 'public',
    table_name: index === 73 ? 'subscription_revenue_daily' : `decoy_table_${String(index).padStart(3, '0')}`,
    display_name: index === 73 ? '订阅收入日报' : `无关业务表 ${index}`,
    description: index === 73 ? '每日订阅收入、MRR、续费和流失金额' : '通用占位数据',
    dataset_key: 'scale_test', source_type: 'preset', is_agent_visible: true, created_by: null, created_at: new Date().toISOString(),
}));
const startedAt = performance.now();
const selected = rankSchemaCatalog('请分析 subscription_revenue_daily 的 MRR 和续费趋势', tables).slice(0, 12);
assert.equal(selected[0].table_name, 'subscription_revenue_daily');
assert.ok(performance.now() - startedAt < 100, '100-table ranking must finish under 100ms');
assert.ok(selected.length <= 12, 'retrieval must respect the configured detail limit');

assert.match(PHASE6_SCHEMA_SQL, /generation_metric/);
assert.match(PHASE6_SCHEMA_SQL, /generation_trace_span/);
assert.match(PHASE6_SCHEMA_SQL, /agent_evaluation_run/);
assert.match(PHASE6_SCHEMA_SQL, /retention_policy/);
assert.match(PHASE6_SCHEMA_SQL, /retention_cleanup_audit/);

const cleanupCalls = [];
const fakeDatabase = {
    async query() { return [
        { resource_type: 'generation_event', retention_days: 30 },
        { resource_type: 'memory_record', retention_days: 365 },
        { resource_type: 'query_artifact', retention_days: 30 },
    ]; },
    async withTransaction(worker) {
        return worker({
            async execute(sql) {
                cleanupCalls.push(sql);
                return [{ rowCount: sql.startsWith('DELETE') ? 2 : 1 }];
            },
        });
    },
    async execute() { return { rowCount: 1 }; },
};
const cleanup = await new RetentionService(fakeDatabase).runOnce();
assert.deepEqual(cleanup, { query_artifact: 2, generation_event: 2, memory_record: 2 });
assert.equal(cleanupCalls.filter((sql) => sql.startsWith('INSERT INTO retention_cleanup_audit')).length, 3);

const benchmark = JSON.parse(await readFile(new URL('../benchmarks/saas-growth/cases.json', import.meta.url), 'utf8'));
const sample = benchmark.cases.find((item) => item.type === 'sql');
const artifact = { originalSql: sample.sql, rows: sample.expected.rows };
const score = scoreAgentCase(sample, { status: 'completed', answer: JSON.stringify(sample.expected.rows), artifacts: [artifact] });
assert.equal(score.score, 100);
assert.equal(score.passed, true);
const report = summarizeReport([score], { minimumOverallScore: 80, minimumPassRate: 0.9 });
assert.equal(report.gate.passed, true);

console.log(JSON.stringify({ schemaCandidates: tables.length, schemaSelected: selected.length, targetRank: 1, evaluatorScore: score.score, retentionContracts: 3 }, null, 2));
