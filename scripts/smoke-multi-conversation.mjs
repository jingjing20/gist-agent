import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseClient } from '@gist/database';
import { loadWorkspaceEnv } from '@gist/config';
import { AGENT_RUNTIME_VERSIONS } from '../packages/contracts/dist/index.js';

loadWorkspaceEnv();
const api = process.env.API_BASE_URL || 'http://127.0.0.1:3000/api';
const email = `smoke-${randomUUID()}@example.test`;
const database = new DatabaseClient();

async function request(path, init = {}) {
    const response = await fetch(`${api}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${init.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
}

async function waitFor(generationId, token) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const history = await request(`/chat/generations/${generationId}/events?after_sequence=0`, {
            headers: { authorization: `Bearer ${token}` },
        });
        if (history.mode === 'events') {
            const done = history.events.find((event) => event.type === 'done');
            if (done) return { status: done.status || 'completed', eventCount: history.events.length, error: done.error };
        } else if (['completed', 'failed', 'cancelled'].includes(history.snapshot.status)) {
            return { status: history.snapshot.status, eventCount: history.snapshot.sequence, error: history.snapshot.error };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`generation ${generationId} timed out`);
}

try {
    const registration = await request('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'smoke-password', name: 'Smoke' }),
    });
    const authorization = `Bearer ${registration.token}`;
    const conversations = await Promise.all([
        request('/conversations', { method: 'POST', headers: { authorization }, body: JSON.stringify({ title: 'Smoke A' }) }),
        request('/conversations', { method: 'POST', headers: { authorization }, body: JSON.stringify({ title: 'Smoke B' }) }),
    ]);
    const generations = await Promise.all(
        conversations.map((conversation, index) =>
            request('/chat', {
                method: 'POST',
                headers: { authorization, 'idempotency-key': randomUUID() },
                body: JSON.stringify({ conversationId: conversation.id, message: `并发测试 ${index + 1}` }),
            })
        )
    );
    const results = await Promise.all(generations.map((generation) => waitFor(generation.generationId, registration.token)));
    if (results.some((result) => result.status !== 'completed')) throw new Error(`unexpected statuses: ${JSON.stringify(results)}`);

    const generationIds = generations.map((generation) => generation.generationId);
    const placeholders = generationIds.map(() => '?').join(',');
    const persisted = await database.query(
        `SELECT id,error_code,first_token_at,model_provider,model_name,prompt_policy_version,toolset_version,
            context_policy_version,memory_policy_version,schema_context_version
       FROM generation WHERE id IN (${placeholders}) ORDER BY id`,
        generationIds
    );
    assert.equal(persisted.length, generationIds.length);
    for (const row of persisted) {
        assert.equal(row.error_code, null);
        assert.ok(row.first_token_at, `missing first_token_at for ${row.id}`);
        assert.ok(row.model_provider);
        assert.ok(row.model_name);
        assert.equal(row.prompt_policy_version, AGENT_RUNTIME_VERSIONS.promptPolicy);
        assert.equal(row.toolset_version, AGENT_RUNTIME_VERSIONS.toolset);
        assert.equal(row.context_policy_version, AGENT_RUNTIME_VERSIONS.contextPolicy);
        assert.equal(row.memory_policy_version, AGENT_RUNTIME_VERSIONS.memoryPolicy);
        assert.equal(row.schema_context_version, AGENT_RUNTIME_VERSIONS.schemaContext);
    }
    const attempts = await database.query(`SELECT generation_id,received_first_delta FROM generation_attempt WHERE generation_id IN (${placeholders})`, generationIds);
    assert.equal(attempts.length, generationIds.length);
    assert.ok(attempts.every((attempt) => attempt.received_first_delta === true));
    console.log(JSON.stringify({ conversations: conversations.length, generations: results }, null, 2));
} finally {
    const owner = (await database.query('SELECT id FROM app_user WHERE email=?', [email]).catch(() => []))[0];
    if (owner) {
        const ownedGenerations = await database.query('SELECT id FROM generation WHERE user_id=?', [owner.id]).catch(() => []);
        if (ownedGenerations.length) {
            const placeholders = ownedGenerations.map(() => '?').join(',');
            await database
                .execute(
                    `DELETE FROM outbox_event WHERE aggregate_id IN (${placeholders})`,
                    ownedGenerations.map((row) => row.id)
                )
                .catch(() => undefined);
        }
    }
    await database.execute('DELETE FROM app_user WHERE email=?', [email]).catch(() => undefined);
    await database.close();
}
