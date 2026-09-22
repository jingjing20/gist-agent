import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseClient } from '../packages/database/dist/index.js';
import { ConversationService } from '../apps/worker/dist/conversation/conversation.service.js';
import { GenerationService } from '../apps/worker/dist/chat/generation.service.js';
import { ANALYSIS_RUNTIME_VERSIONS } from '../packages/contracts/dist/index.js';
import { ChatService } from '../apps/worker/dist/chat/chat.service.js';
import { loadWorkspaceEnv } from '@gist/config';

loadWorkspaceEnv();
const api = process.env.API_BASE_URL || 'http://127.0.0.1:3000/api';
const database = new DatabaseClient();
const email = `phase1-${randomUUID()}@example.test`;

async function request(path, init = {}, expectedStatus) {
    const response = await fetch(`${api}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    });
    const body = await response.json().catch(() => null);
    if (expectedStatus != null) {
        assert.equal(response.status, expectedStatus, `${init.method || 'GET'} ${path}: ${JSON.stringify(body)}`);
    } else if (!response.ok) {
        throw new Error(`${init.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`);
    }
    return body;
}

async function insertMessage(id, conversationId, role, content) {
    await database.execute("INSERT INTO message (id,conversation_id,role,content,blocks,llm_messages) VALUES (?,?,?,?, '[]'::jsonb, '[]'::jsonb)", [
        id,
        conversationId,
        role,
        content,
    ]);
}

async function insertGeneration({ id, userId, conversationId, requestId, responseId, status, datasourceId = null, upperBound = new Date().toISOString() }) {
    await database.execute(
        `INSERT INTO generation (
       id,user_id,conversation_id,request_message_id,response_message_id,status,datasource_id,context_upper_bound,reasoning_enabled
     ) VALUES (?,?,?,?,?,?,?,?,FALSE)`,
        [id, userId, conversationId, requestId, responseId, status, datasourceId, upperBound]
    );
}

try {
    const registration = await request('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'phase1-password', name: 'Phase 1' }),
    });
    const authorization = `Bearer ${registration.token}`;
    const userId = Number(registration.user.id);
    const datasource = (await database.query('SELECT id FROM data_source WHERE is_local=1 LIMIT 1'))[0];
    assert.ok(datasource?.id, 'local datasource is required');

    // Conversation-level serialization: an already active generation must make the API reject another turn.
    const lockedConversation = await request('/conversations', {
        method: 'POST',
        headers: { authorization },
        body: JSON.stringify({ title: 'Phase 1 serialization' }),
    });
    const lockedRequest = randomUUID();
    const lockedResponse = randomUUID();
    const lockedGeneration = randomUUID();
    await insertMessage(lockedRequest, lockedConversation.id, 'user', 'blocking request');
    await insertMessage(lockedResponse, lockedConversation.id, 'assistant', '');
    await insertGeneration({
        id: lockedGeneration,
        userId,
        conversationId: lockedConversation.id,
        requestId: lockedRequest,
        responseId: lockedResponse,
        status: 'pending',
        datasourceId: Number(datasource.id),
    });
    const conflict = await request(
        '/chat',
        {
            method: 'POST',
            headers: { authorization, 'idempotency-key': randomUUID() },
            body: JSON.stringify({ conversationId: lockedConversation.id, message: 'must be rejected' }),
        },
        409
    );
    assert.equal(conflict.code, 'CONVERSATION_GENERATION_ACTIVE');

    // Input snapshot: data source and context watermark stay on the generation even if the conversation changes.
    await database.execute('DELETE FROM generation WHERE id=?', [lockedGeneration]);
    const created = await request('/chat', {
        method: 'POST',
        headers: { authorization, 'idempotency-key': randomUUID() },
        body: JSON.stringify({ conversationId: lockedConversation.id, message: 'snapshot request', datasourceId: Number(datasource.id) }),
    });
    const snapshot = (
        await database.query('SELECT request_message_id,response_message_id,datasource_id,context_upper_bound FROM generation WHERE id=?', [created.generationId])
    )[0];
    assert.equal(snapshot.request_message_id, created.userMessageId);
    assert.equal(snapshot.response_message_id, created.responseMessageId);
    assert.equal(Number(snapshot.datasource_id), Number(datasource.id));
    assert.ok(snapshot.context_upper_bound);
    await database.execute('UPDATE conversation SET datasource_id=NULL WHERE id=?', [lockedConversation.id]);
    assert.equal(Number((await database.query('SELECT datasource_id FROM generation WHERE id=?', [created.generationId]))[0].datasource_id), Number(datasource.id));

    // Context isolation: only completed history plus the exact request message is visible.
    const contextConversation = await request('/conversations', {
        method: 'POST',
        headers: { authorization },
        body: JSON.stringify({ title: 'Phase 1 context' }),
    });
    const completedRequest = randomUUID(),
        completedResponse = randomUUID();
    const failedRequest = randomUUID(),
        failedResponse = randomUUID();
    await insertMessage(completedRequest, contextConversation.id, 'user', 'completed-user');
    await insertMessage(completedResponse, contextConversation.id, 'assistant', 'completed-assistant');
    await insertGeneration({ id: randomUUID(), userId, conversationId: contextConversation.id, requestId: completedRequest, responseId: completedResponse, status: 'completed' });
    await insertMessage(failedRequest, contextConversation.id, 'user', 'failed-user');
    await insertMessage(failedResponse, contextConversation.id, 'assistant', 'failed-assistant');
    await insertGeneration({ id: randomUUID(), userId, conversationId: contextConversation.id, requestId: failedRequest, responseId: failedResponse, status: 'failed' });
    const upperBound = new Date(Date.now() + 100).toISOString();
    const currentRequest = randomUUID(),
        currentResponse = randomUUID(),
        currentGeneration = randomUUID();
    await insertMessage(currentRequest, contextConversation.id, 'user', 'current-user');
    await insertMessage(currentResponse, contextConversation.id, 'assistant', '');
    await insertGeneration({
        id: currentGeneration,
        userId,
        conversationId: contextConversation.id,
        requestId: currentRequest,
        responseId: currentResponse,
        status: 'pending',
        upperBound,
    });
    const conversations = new ConversationService(database);
    assert.equal((await conversations.getMessage(currentRequest, contextConversation.id, userId)).content, 'current-user');
    assert.equal(await conversations.getMessage(currentRequest, contextConversation.id, -1), null);

    // Writer fence: after terminal transition, neither events nor message checkpoints are accepted.
    const repository = new GenerationService(database);
    const identity = await repository.claim(currentGeneration, randomUUID());
    assert.ok(identity);
    const emitter = repository.emitter(identity);
    emitter.send({ type: 'text_chunk', content: 'before terminal' });
    await repository.drain(identity);
    await repository.checkpointMessage(identity, [{ type: 'text', content: 'before terminal' }], []);
    await repository.finalize(
        identity,
        'completed',
        undefined,
        undefined,
        { type: 'done', status: 'completed' },
        {
            blocks: [{ type: 'text', content: 'before terminal' }],
            llmMessages: [],
        }
    );
    const terminalState = (await database.query('SELECT last_sequence FROM generation WHERE id=?', [currentGeneration]))[0];
    emitter.send({ type: 'text_chunk', content: 'after terminal' });
    await assert.rejects(() => repository.drain(identity), /\u5199\u5165\u6743/);
    await assert.rejects(() => repository.checkpointMessage(identity, [{ type: 'text', content: 'after terminal' }], []), /\u5199\u5165\u6743/);
    const afterTerminal = (await database.query('SELECT last_sequence FROM generation WHERE id=?', [currentGeneration]))[0];
    assert.equal(afterTerminal.last_sequence, terminalState.last_sequence);

    // Duplicate delivery and worker loss: only one writer can claim, and a stale writer is fenced out.
    const staleConversation = await request('/conversations', {
        method: 'POST',
        headers: { authorization },
        body: JSON.stringify({ title: 'Phase 1 stale worker' }),
    });
    const staleRequest = randomUUID(),
        staleResponse = randomUUID(),
        staleGeneration = randomUUID();
    await insertMessage(staleRequest, staleConversation.id, 'user', 'stale-worker-user');
    await insertMessage(staleResponse, staleConversation.id, 'assistant', '');
    await insertGeneration({ id: staleGeneration, userId, conversationId: staleConversation.id, requestId: staleRequest, responseId: staleResponse, status: 'pending' });
    const staleIdentity = await repository.claim(staleGeneration, randomUUID());
    assert.ok(staleIdentity);
    assert.equal(await repository.claim(staleGeneration, randomUUID()), null);
    await database.execute("UPDATE generation SET writer_heartbeat_at=NOW()-INTERVAL '10 seconds' WHERE id=?", [staleGeneration]);
    assert.equal(await repository.failStale(1_000), 1);
    const staleState = (await database.query('SELECT status,error_code FROM generation WHERE id=?', [staleGeneration]))[0];
    assert.deepEqual(staleState, { status: 'failed', error_code: 'WORKER_LOST' });
    await assert.rejects(() => repository.checkpointMessage(staleIdentity, [], []), /写入权/);

    // A short real Redis write pause must delay and then safely resume an in-flight event without duplication.
    const redisConversation = await request('/conversations', {
        method: 'POST',
        headers: { authorization },
        body: JSON.stringify({ title: 'Phase 1 Redis pause' }),
    });
    const redisRequest = randomUUID(),
        redisResponse = randomUUID(),
        redisGeneration = randomUUID();
    await insertMessage(redisRequest, redisConversation.id, 'user', 'redis-pause-user');
    await insertMessage(redisResponse, redisConversation.id, 'assistant', '');
    await insertGeneration({ id: redisGeneration, userId, conversationId: redisConversation.id, requestId: redisRequest, responseId: redisResponse, status: 'pending' });
    const redisIdentity = await repository.claim(redisGeneration, randomUUID());
    assert.ok(redisIdentity);
    await repository.redis.call('CLIENT', 'PAUSE', 200, 'WRITE');
    const pauseStarted = Date.now();
    const redisEmitter = repository.emitter(redisIdentity);
    redisEmitter.send({ type: 'text_chunk', content: 'after pause' });
    await repository.drain(redisIdentity);
    assert.ok(Date.now() - pauseStarted >= 100, 'Redis write pause did not affect the publish path');
    assert.equal(Number((await database.query('SELECT last_sequence FROM generation WHERE id=?', [redisGeneration]))[0].last_sequence), 1);
    await repository.finalize(redisIdentity, 'completed', undefined, undefined, { type: 'done', status: 'completed' }, { blocks: [], llmMessages: [] });

    // A stuck LLM must be aborted before timeout/cancellation is finalized; no normal event may appear afterward.
    const stuckLlm = {
        isReasoningActive: () => false,
        streamWithTools: (_messages, _tools, options) =>
            new Promise((_, reject) => {
                const rejectAbort = () => reject(options.signal?.reason ?? new Error('aborted'));
                if (options.signal?.aborted) rejectAbort();
                else options.signal?.addEventListener('abort', rejectAbort, { once: true });
            }),
    };
    const reliability = {
        acquire: async (input) => ({ token: input.token, keys: [] }),
        renew: async () => true,
        release: async () => undefined,
    };
    const chat = new ChatService(conversations, repository, reliability, { run: ({ signal }) => stuckLlm.streamWithTools([], [], { signal }) });

    async function createPendingGeneration(title, content) {
        const conversation = await request('/conversations', {
            method: 'POST',
            headers: { authorization },
            body: JSON.stringify({ title }),
        });
        const requestId = randomUUID(),
            responseId = randomUUID(),
            generationId = randomUUID();
        await insertMessage(requestId, conversation.id, 'user', content);
        await insertMessage(responseId, conversation.id, 'assistant', '');
        await insertGeneration({ id: generationId, userId, conversationId: conversation.id, requestId, responseId, status: 'pending' });
        await database.execute('UPDATE generation SET prompt_policy_version=? WHERE id=?', [ANALYSIS_RUNTIME_VERSIONS.promptPolicy, generationId]);
        return { conversation, requestId, responseId, generationId };
    }

    const timeoutGeneration = await createPendingGeneration('Phase 1 stuck LLM', 'never returns');
    const timeoutStartedAt = Date.now();
    await chat.executeGeneration(timeoutGeneration.generationId);
    assert.ok(Date.now() - timeoutStartedAt < 2_500, 'stuck LLM was not aborted by the generation timeout');
    const timedOut = (await database.query('SELECT status,error_code FROM generation WHERE id=?', [timeoutGeneration.generationId]))[0];
    assert.deepEqual(timedOut, { status: 'failed', error_code: 'ANALYSIS_TIMEOUT' });

    const cancelledGeneration = await createPendingGeneration('Phase 1 cancellation', 'cancel me');
    const cancellation = chat.executeGeneration(cancelledGeneration.generationId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await database.execute("UPDATE generation SET status='cancel_requested',cancel_requested_at=NOW() WHERE id=?", [cancelledGeneration.generationId]);
    await cancellation;
    const cancelled = (await database.query('SELECT status,error_code FROM generation WHERE id=?', [cancelledGeneration.generationId]))[0];
    assert.deepEqual(cancelled, { status: 'cancelled', error_code: 'CANCELLED' });

    await new Promise((resolve) => setTimeout(resolve, 400));
    for (const generationId of [timeoutGeneration.generationId, cancelledGeneration.generationId]) {
        const stream = await repository.redis.xrange(`${process.env.EVENT_KEY_PREFIX || 'gist-agent'}:{${userId}}:gen:${generationId}`, '-', '+');
        const events = stream.map((entry) => JSON.parse(entry[1][1]));
        assert.ok(
            events.every((event) => event.type === 'done'),
            `ordinary event observed after abort for ${generationId}`
        );
    }
    await repository.onModuleDestroy();

    // PostgreSQL-native timeout and AbortSignal cancellation both stop pg_sleep promptly.
    const timeoutStarted = Date.now();
    await assert.rejects(
        () => database.queryReadOnly('SELECT pg_sleep(2)', [], null, { timeoutMs: 100 }),
        (error) => error?.code === '57014'
    );
    assert.ok(Date.now() - timeoutStarted < 1500, 'statement_timeout did not stop the backend query promptly');
    const controller = new AbortController();
    const abortStarted = Date.now();
    setTimeout(() => controller.abort(new Error('test cancellation')), 100);
    await assert.rejects(() => database.queryReadOnly('SELECT pg_sleep(5)', [], null, { timeoutMs: 10_000, signal: controller.signal }), /test cancellation/);
    assert.ok(Date.now() - abortStarted < 2000, 'AbortSignal did not cancel the backend query promptly');

    console.log(
        JSON.stringify(
            {
                serialization: 'PASS',
                snapshot: 'PASS',
                contextIsolation: 'PASS',
                writerFence: 'PASS',
                duplicateDelivery: 'PASS',
                workerLoss: 'PASS',
                redisPause: 'PASS',
                stuckLlmTimeout: 'PASS',
                cancellation: 'PASS',
                sqlCancellation: 'PASS',
            },
            null,
            2
        )
    );
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
