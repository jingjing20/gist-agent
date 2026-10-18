// Build first: pnpm --filter @gist/worker... build
// DB_PORT=15432 node scripts/verify-follow-up.cjs <conversation-id> [--expect-nonempty]
// Reads saved analysis and calls the configured model; never changes conversation data.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'apps/worker/package.json'));
const { LlmClient } = workerRequire('@gist/llm');
const { DatabaseClient } = workerRequire('@gist/database');
const { SchemaService } = require('../apps/worker/dist/database/schema.service.js');
const followUp = require('../apps/worker/dist/analysis/follow-up-suggestions.js');
async function main() {
    const conversationId = process.argv[2];
    assert.match(conversationId || '', /^[0-9a-f-]{36}$/i, 'Provide a conversation UUID');
    const llm = new LlmClient(); // loads workspace environment
    const db = new DatabaseClient();
    try {
        const [row] = await db.query(
            `SELECT g.id,g.user_id,g.datasource_id,q.content question,m.blocks
          FROM generation g JOIN message q ON q.id=g.request_message_id JOIN message m ON m.id=g.response_message_id
          WHERE g.conversation_id=? AND g.status='completed' ORDER BY g.created_at DESC LIMIT 1`,
            [conversationId]
        );
        assert.ok(row, 'No completed analysis found');
        const analysis = row.blocks.findLast((b) => b.analysis)?.analysis;
        assert.ok(analysis?.outcome, 'No analysis outcome found');
        const schema = new SchemaService(db);
        const names = analysis.snapshot.schemaTables;
        const details = (await Promise.all(names.slice(0, 6).map((name) => schema.getSchemaDetail(row.datasource_id, row.user_id, name)))).filter(Boolean);
        const context = followUp.buildFollowUpContext({ state: analysis.state, outcome: analysis.outcome, schema: details, blocks: row.blocks });
        const started = Date.now();
        const items = await followUp.generateSuggestions({
            llm,
            question: row.question,
            context,
            signal: new AbortController().signal,
            metrics: { llmCallCount: 0, inputTokensEstimated: 0, outputTokensEstimated: 0 },
            onDiagnostic: (d) => console.log('diagnostic', JSON.stringify(d)),
        });
        console.log(JSON.stringify({ conversationId, generationId: row.id, question: row.question, schemaTables: names, durationMs: Date.now() - started, items }, null, 2));
        if (process.argv.includes('--expect-nonempty')) assert.ok(items.length > 0, 'Expected at least one follow-up question');
    } finally {
        await db.close();
    }
}
main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
});
