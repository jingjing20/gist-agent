import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseClient, applyPhase3Schema } from '@gist/database';
import { loadWorkspaceEnv } from '@gist/config';

loadWorkspaceEnv();
const database = new DatabaseClient();
const email = `phase3-migration-${randomUUID()}@example.test`;

async function insertMessage(id, conversationId, role, content, blocks = []) {
    await database.execute("INSERT INTO message (id,conversation_id,role,content,blocks,llm_messages) VALUES (?,?,?,?,?::jsonb,'[]'::jsonb)", [
        id,
        conversationId,
        role,
        content,
        JSON.stringify(blocks),
    ]);
}

async function insertLegacyGeneration(userId, conversationId, status, offsetSeconds, answer) {
    const generationId = randomUUID();
    const requestId = randomUUID();
    const responseId = randomUUID();
    await insertMessage(requestId, conversationId, 'user', `${status}-request`);
    await insertMessage(responseId, conversationId, 'assistant', '', answer ? [{ type: 'text', content: answer }] : []);
    await database.execute(
        `INSERT INTO generation (
            id,user_id,conversation_id,request_message_id,response_message_id,status,
            context_upper_bound,created_at,updated_at,completed_at
         ) VALUES (?,?,?,?,?,?,NOW() + (? * INTERVAL '1 second'),NOW() + (? * INTERVAL '1 second'),NOW(),NOW())`,
        [generationId, userId, conversationId, requestId, responseId, status, offsetSeconds, offsetSeconds]
    );
    return generationId;
}

try {
    // Existing-schema/empty-data path and repeated execution must both be safe.
    await applyPhase3Schema(database);
    await applyPhase3Schema(database);
    const tables = await database.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema=current_schema()
            AND table_name IN ('conversation_turn','query_artifact','chart_artifact')
          ORDER BY table_name`
    );
    assert.deepEqual(
        tables.map((row) => row.table_name),
        ['chart_artifact', 'conversation_turn', 'query_artifact']
    );

    const user = (await database.query('INSERT INTO app_user (email,password_hash,name) VALUES (?,?,?) RETURNING id', [email, 'phase3-test', 'Phase 3 Migration']))[0];
    const conversationId = randomUUID();
    await database.execute('INSERT INTO conversation (id,user_id,title) VALUES (?,?,?)', [conversationId, user.id, 'Phase 3 migration']);

    const completed = await insertLegacyGeneration(user.id, conversationId, 'completed', -30, 'completed answer');
    const failed = await insertLegacyGeneration(user.id, conversationId, 'failed', -20);
    const cancelled = await insertLegacyGeneration(user.id, conversationId, 'cancelled', -10);
    assert.equal(Number((await database.query('SELECT COUNT(*)::int AS count FROM conversation_turn WHERE conversation_id=?', [conversationId]))[0].count), 0);

    await applyPhase3Schema(database);
    const first = await database.query('SELECT id,generation_id,sequence,status,final_answer FROM conversation_turn WHERE conversation_id=? ORDER BY sequence', [conversationId]);
    assert.deepEqual(
        first.map((row) => ({ generationId: row.generation_id, sequence: row.sequence, status: row.status, finalAnswer: row.final_answer })),
        [
            { generationId: completed, sequence: 1, status: 'completed', finalAnswer: 'completed answer' },
            { generationId: failed, sequence: 2, status: 'failed', finalAnswer: null },
            { generationId: cancelled, sequence: 3, status: 'cancelled', finalAnswer: null },
        ]
    );

    await applyPhase3Schema(database);
    const second = await database.query('SELECT id,generation_id,sequence,status,final_answer FROM conversation_turn WHERE conversation_id=? ORDER BY sequence', [conversationId]);
    assert.deepEqual(second, first, 're-running the migration must not change turn identity or sequence');

    const constraints = await database.query(
        `SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_schema=current_schema() AND table_name='conversation_turn'
            AND constraint_type IN ('PRIMARY KEY','UNIQUE')`
    );
    assert.ok(constraints.length >= 3, 'turn primary key, generation uniqueness and conversation sequence uniqueness are required');

    console.log(
        JSON.stringify(
            {
                schemaCreation: 'PASS',
                existingDataBackfill: 'PASS',
                failedCancelledMapping: 'PASS',
                stableSequence: 'PASS',
                idempotency: 'PASS',
            },
            null,
            2
        )
    );
} finally {
    await database.execute('DELETE FROM app_user WHERE email=?', [email]).catch(() => undefined);
    await database.close();
}
