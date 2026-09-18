import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseClient } from '@gist/database';
import { loadWorkspaceEnv } from '@gist/config';
import { scoreAgentCase, summarizeReport } from './phase6-evaluation-core.mjs';
import { AGENT_RUNTIME_VERSIONS } from '../packages/contracts/dist/index.js';

loadWorkspaceEnv();
const root = resolve(import.meta.dirname, '..');
const benchmark = JSON.parse(await readFile(resolve(root, 'benchmarks/saas-growth/cases.json'), 'utf8'));
const thresholds = JSON.parse(await readFile(resolve(root, 'benchmarks/saas-growth/release-thresholds.json'), 'utf8'));
const api = process.env.API_BASE_URL || 'http://127.0.0.1:3000/api';
const reportDir = resolve(root, process.env.EVAL_REPORT_DIR || 'artifacts/evaluations');
const selectedIds = new Set((process.env.EVAL_CASE_IDS || '').split(',').filter(Boolean));
const cases = selectedIds.size ? benchmark.cases.filter((item) => selectedIds.has(item.id)) : benchmark.cases;
const timeoutMs = Math.max(10_000, Number(process.env.EVAL_CASE_TIMEOUT_MS) || 300_000);
const database = new DatabaseClient();

async function request(path, init = {}) {
    const response = await fetch(`${api}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
    const body = await response.json();
    if (!response.ok) throw new Error(`${init.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
}

async function waitFor(generationId, authorization) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const history = await request(`/chat/generations/${generationId}/events?after_sequence=0`, { headers: { authorization } });
        const status = history.mode === 'snapshot' ? history.snapshot.status : history.events.find((event) => event.type === 'done')?.status;
        if (status && ['completed', 'failed', 'cancelled'].includes(status)) return status;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    return 'timeout';
}

await database.connect();
const email = `phase6-eval-${randomUUID()}@example.test`;
let userId;
try {
    const registration = await request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password: randomUUID(), name: 'Phase 6 Evaluation' }) });
    userId = registration.user.id;
    const authorization = `Bearer ${registration.token}`;
    const results = [];
    for (const testCase of cases) {
        const conversation = await request('/conversations', { method: 'POST', headers: { authorization }, body: JSON.stringify({ title: `Eval ${testCase.id}` }) });
        const generation = await request('/chat', {
            method: 'POST',
            headers: { authorization, 'idempotency-key': randomUUID() },
            body: JSON.stringify({ conversationId: conversation.id, message: testCase.question }),
        });
        const status = await waitFor(generation.generationId, authorization);
        const [turn] = await database.query(`SELECT final_answer FROM conversation_turn WHERE generation_id=?`, [generation.generationId]);
        const artifacts = await database.query(`SELECT original_sql,result_rows AS rows FROM query_artifact WHERE generation_id=? ORDER BY created_at`, [generation.generationId]);
        const [metric] = await database.query(
            `SELECT m.*,EXTRACT(EPOCH FROM (g.completed_at-g.created_at))*1000 AS total_latency_ms
               FROM generation g LEFT JOIN generation_metric m ON m.generation_id=g.id WHERE g.id=?`,
            [generation.generationId]
        );
        results.push({ ...scoreAgentCase(testCase, { status, answer: turn?.final_answer, artifacts }), status, generationId: generation.generationId, metric: metric ?? null });
    }
    const release = summarizeReport(results, thresholds);
    const schemaRecall = results.filter((item) => typeof item.checks.tableRecall === 'number').reduce((sum, item) => sum + item.checks.tableRecall, 0) /
        Math.max(1, results.filter((item) => typeof item.checks.tableRecall === 'number').length);
    const report = {
        version: 1,
        benchmarkVersion: benchmark.version,
        createdAt: new Date().toISOString(),
        runtime: { provider: process.env.LLM_PROVIDER || 'openai-compatible', model: process.env.OPENAI_FAST_MODEL || process.env.OPENAI_MODEL || 'gpt-4o' },
        ...release,
        schemaRecall: Number(schemaRecall.toFixed(4)),
        results,
    };
    const latencies = results.map((item) => Number(item.metric?.total_latency_ms)).filter(Number.isFinite).sort((a, b) => a - b);
    const p95TotalLatencyMs = latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : 0;
    const averageCostMicrousd = results.length
        ? results.reduce((sum, item) => sum + Number(item.metric?.estimated_cost_microusd ?? 0), 0) / results.length
        : 0;
    report.performance = { p95TotalLatencyMs: Math.round(p95TotalLatencyMs), averageCostMicrousd: Math.round(averageCostMicrousd) };
    report.gate.passed =
        report.gate.passed &&
        schemaRecall >= thresholds.minimumSchemaRecall &&
        p95TotalLatencyMs <= thresholds.maximumP95TotalLatencyMs &&
        averageCostMicrousd <= thresholds.maximumAverageCostMicrousd;
    await database.execute(
        `INSERT INTO agent_evaluation_run (
            benchmark_version,model_provider,model_name,prompt_policy_version,toolset_version,context_policy_version,
            memory_policy_version,schema_context_version,case_count,overall_score,pass_rate,schema_recall,
            p95_total_latency_ms,average_cost_microusd,gate_passed
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            String(benchmark.version), report.runtime.provider, report.runtime.model,
            AGENT_RUNTIME_VERSIONS.promptPolicy, AGENT_RUNTIME_VERSIONS.toolset, AGENT_RUNTIME_VERSIONS.contextPolicy,
            AGENT_RUNTIME_VERSIONS.memoryPolicy, AGENT_RUNTIME_VERSIONS.schemaContext, report.summary.cases,
            report.summary.overallScore, report.summary.passRate, report.schemaRecall,
            report.performance.p95TotalLatencyMs, report.performance.averageCostMicrousd, report.gate.passed,
        ]
    );
    await mkdir(reportDir, { recursive: true });
    const output = resolve(reportDir, `phase6-${Date.now()}.json`);
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ report: output, summary: report.summary, schemaRecall: report.schemaRecall, gate: report.gate }, null, 2));
    if (!report.gate.passed) process.exitCode = 1;
} finally {
    if (userId) await database.execute('DELETE FROM app_user WHERE id=?', [userId]).catch(() => undefined);
    await database.close();
}
