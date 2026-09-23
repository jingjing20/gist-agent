import { DatabaseClient, applyCurrentSchema } from '@gist/database';
const reset = process.argv.includes('--reset-analysis');
if (process.argv.slice(2).some((arg) => arg !== '--reset-analysis')) throw new Error('Only --reset-analysis is supported');
const db = new DatabaseClient();
// Explicit scope: business source tables, accounts and access policy are never dropped.
const analysisTables = [
    'analysis_state_draft',
    'analysis_state',
    'business_definition_candidate',
    'business_definition_revision',
    'business_definition',
    'business_definition_seed_import',
    'datasource_memory_candidate',
    'datasource_memory_revision',
    'datasource_memory',
    'chart_artifact',
    'query_artifact',
    'conversation_turn',
    'generation_trace_span',
    'generation_metric',
    'generation_event',
    'generation_attempt',
    'outbox_event',
    'memory_change_audit',
    'memory_record',
    'message_block',
    'generation',
    'message',
    'conversation',
    'retention_cleanup_audit',
    'retention_policy',
];
try {
    const target = await db.query('SELECT current_database() AS database,current_schema() AS schema,inet_server_addr() AS server,inet_server_port() AS port');
    if (target[0].schema !== 'public') throw new Error('Migration expects the project schema public');
    console.log(JSON.stringify({ target: target[0], resetAnalysis: reset }));
    await db.withTransaction(async (tx) => {
        await tx.query("SET LOCAL lock_timeout='5s'");
        await tx.query("SET LOCAL statement_timeout='30s'");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('gist-agent:current-schema',0))");
        if (reset) {
            const [present] = await tx.query("SELECT to_regclass('public.generation') AS generation");
            if (present[0].generation) {
                await tx.query('LOCK TABLE conversation,generation IN ACCESS EXCLUSIVE MODE');
                const [active] = await tx.query("SELECT id FROM generation WHERE status IN ('pending','starting','running','cancel_requested') LIMIT 1");
                if (active.length) throw new Error('Active analysis tasks exist; stop task creation and finish/cancel them before reset');
            }
            // No CASCADE: any unexpected dependency aborts the transaction instead of deleting unrelated data.
            await tx.query(`DROP TABLE IF EXISTS ${analysisTables.map((name) => `public."${name}"`).join(',')}`);
        } else {
            // Replace only the retired business-definition storage. Keep conversations and analysis rows.
            await tx.query(`DROP TABLE IF EXISTS public.business_definition_candidate, public.business_definition_revision, public.business_definition, public.business_definition_seed_import`);
            await tx.query(`ALTER TABLE IF EXISTS public.analysis_state_draft DROP COLUMN IF EXISTS definitions, ADD COLUMN IF NOT EXISTS memories JSONB NOT NULL DEFAULT '[]'::jsonb`);
            await tx.query(`ALTER TABLE IF EXISTS public.query_artifact ADD COLUMN IF NOT EXISTS result_quality JSONB, ADD COLUMN IF NOT EXISTS analysis_context JSONB`);
        }
        await applyCurrentSchema(tx);
        const [tables] = await tx.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
        const names = new Set(tables.map((row) => row.tablename));
        const [columns] = await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='query_artifact'");
        const [draftColumns] = await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='analysis_state_draft'");
        if (!draftColumns.some((row) => row.column_name === 'memories')) throw new Error('Outdated analysis state schema: memories missing; use --reset-analysis');
        for (const field of ['analysis_context', 'result_quality']) {
            if (!columns.some((row) => row.column_name === field)) throw new Error(`Outdated evidence schema: ${field} missing; use --reset-analysis`);
        }

        for (const required of [
            'analysis_state',
            'analysis_state_draft',
            'datasource_memory',
            'datasource_memory_revision',
            'datasource_memory_candidate',
            'query_artifact',
            'generation',
        ]) {
            if (!names.has(required)) throw new Error(`Missing required table: ${required}`);
        }
        {
            for (const removed of ['business_definition_candidate', 'business_definition_revision', 'business_definition', 'business_definition_seed_import']) {
                if (names.has(removed)) throw new Error(`Retired schema found: ${removed}; use --reset-analysis to discard old test conversations`);
            }
        }
    });
    console.log(JSON.stringify({ status: 'committed', resetAnalysis: reset, message: 'Current schema applied; accounts and business source tables preserved' }));
} catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error.code, message: error.message }));
    process.exitCode = 1;
} finally {
    await db.close();
}
