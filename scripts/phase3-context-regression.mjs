import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseClient } from '@gist/database';
import { loadWorkspaceEnv } from '@gist/config';

loadWorkspaceEnv();
const require = createRequire(import.meta.url);
const { ConversationService } = require('../apps/worker/dist/conversation/conversation.service.js');
const { PromptBuilder } = require('../apps/worker/dist/chat/prompt-builder.js');
const { ArtifactRepository } = require('../apps/worker/dist/chat/artifact.repository.js');
const { SchemaService } = require('../apps/worker/dist/database/schema.service.js');
const { estimateMessagesTokens, estimateTokens } = require('../apps/worker/dist/chat/token-estimator.js');
const { resolveModelCapability } = require('../apps/worker/dist/chat/model-capabilities.js');

const database = new DatabaseClient();
const email = `phase3-context-${randomUUID()}@example.test`;

async function createTurn({ userId, conversationId, datasourceId, sequence, status, userContent, assistantContent, finalAnswer, llmMessages = [] }) {
    const requestId = randomUUID();
    const responseId = randomUUID();
    const generationId = randomUUID();
    await database.execute("INSERT INTO message (id,conversation_id,role,content,blocks,llm_messages) VALUES (?,?, 'user',?, '[]'::jsonb,'[]'::jsonb)", [
        requestId,
        conversationId,
        userContent,
    ]);
    await database.execute("INSERT INTO message (id,conversation_id,role,content,blocks,llm_messages) VALUES (?,?, 'assistant',?, '[]'::jsonb,?::jsonb)", [
        responseId,
        conversationId,
        assistantContent,
        JSON.stringify(llmMessages),
    ]);
    await database.execute(
        `INSERT INTO generation (
            id,user_id,conversation_id,request_message_id,response_message_id,status,datasource_id,context_upper_bound,completed_at
         ) VALUES (?,?,?,?,?,?,?,?,CASE WHEN ? IN ('completed','failed','cancelled') THEN NOW() ELSE NULL END)`,
        [generationId, userId, conversationId, requestId, responseId, status, datasourceId, new Date().toISOString(), status]
    );
    await database.execute(
        `INSERT INTO conversation_turn (
            id,conversation_id,sequence,generation_id,user_message_id,assistant_message_id,status,final_answer,completed_at
         ) VALUES (?,?,?,?,?,?,?,?,CASE WHEN ?='pending' THEN NULL ELSE NOW() END)`,
        [randomUUID(), conversationId, sequence, generationId, requestId, responseId, status, finalAnswer ?? null, status]
    );
    return { generationId, requestId, responseId };
}

function assertWholeTurns(messages, currentRequest) {
    const history = messages.slice(1);
    for (let index = 0; index < history.length; index += 2) {
        assert.equal(history[index].role, 'user', `history entry ${index} must start with user`);
        if (history[index].content === currentRequest) {
            assert.equal(index, history.length - 1, 'the pending current request must be the final history message');
        } else {
            assert.equal(history[index + 1]?.role, 'assistant', `completed turn at ${index} must include its assistant pair`);
        }
    }
}

try {
    const user = (await database.query('INSERT INTO app_user (email,password_hash,name) VALUES (?,?,?) RETURNING id', [email, 'phase3-test', 'Phase 3 Context']))[0];
    const datasource = (await database.query('SELECT id FROM data_source WHERE is_local=1 LIMIT 1'))[0];
    assert.ok(datasource?.id, 'local datasource is required');
    const conversationId = randomUUID();
    await database.execute('INSERT INTO conversation (id,user_id,title,datasource_id) VALUES (?,?,?,?)', [conversationId, user.id, 'Phase 3 Context', datasource.id]);

    const fullOnly = `FULL-ONLY-${'x'.repeat(12_000)}`;
    const completed = await createTurn({
        userId: user.id,
        conversationId,
        datasourceId: datasource.id,
        sequence: 1,
        status: 'completed',
        userContent: 'completed-user',
        assistantContent: 'summary-answer',
        finalAnswer: 'summary-answer',
        llmMessages: [{ role: 'assistant', content: fullOnly }],
    });
    await createTurn({
        userId: user.id,
        conversationId,
        datasourceId: datasource.id,
        sequence: 2,
        status: 'failed',
        userContent: 'failed-user-must-not-appear',
        assistantContent: 'failed-assistant-must-not-appear',
    });
    await createTurn({
        userId: user.id,
        conversationId,
        datasourceId: datasource.id,
        sequence: 3,
        status: 'cancelled',
        userContent: 'cancelled-user-must-not-appear',
        assistantContent: 'cancelled-assistant-must-not-appear',
    });
    const currentRequest = 'current-user-request';
    const current = await createTurn({
        userId: user.id,
        conversationId,
        datasourceId: datasource.id,
        sequence: 4,
        status: 'pending',
        userContent: currentRequest,
        assistantContent: '',
    });

    const repository = new ArtifactRepository(database);
    const evidence = await repository.createQueryArtifact({
        generationId: completed.generationId,
        userId: Number(user.id),
        conversationId,
        datasourceId: Number(datasource.id),
        title: '历史日活',
        plan: { purpose: '分析日活', expectedGrain: '每天', expectedShape: 'timeseries' },
        originalSql: 'SELECT day,dau FROM metrics',
        executedSql: 'SELECT day,dau FROM metrics LIMIT 1000',
        schemaContextVersion: 'schema-context-v2',
        columns: [
            { name: 'day', type: 'date' },
            { name: 'dau', type: 'number' },
        ],
        rows: [{ day: '2026-09-17', dau: 42, secretRowPayload: 'must-not-enter-prompt' }],
        returnedRowCount: 1,
        isLimited: false,
    });

    const conversations = new ConversationService(database);
    const upperBound = new Date(Date.now() + 2_000).toISOString();
    const turns = await conversations.getGenerationContextTurns(conversationId, Number(user.id), upperBound, current.requestId);
    assert.deepEqual(
        turns.map((turn) => ({ sequence: turn.sequence, status: turn.status, user: turn.userMessage.content })),
        [
            { sequence: 1, status: 'completed', user: 'completed-user' },
            { sequence: 4, status: 'pending', user: currentRequest },
        ]
    );
    assert.equal(turns[0].artifacts[0].id, evidence.id);

    const promptBuilder = new PromptBuilder(new SchemaService(database), conversations);
    const toolDefinitions = [
        {
            type: 'function',
            function: {
                name: 'read_query_artifact',
                description: '读取历史证据',
                parameters: { type: 'object', properties: { queryArtifactId: { type: 'string' } }, required: ['queryArtifactId'] },
            },
        },
    ];

    process.env.TURN_CONTEXT_READ_ENABLED = '1';
    process.env.MAX_CONTEXT_TOKENS = '5000';
    process.env.RESPONSE_RESERVE_TOKENS = '200';
    let messages = await promptBuilder.buildMessages(conversationId, Number(user.id), 'system', {
        generationSnapshot: { contextUpperBound: upperBound, requestMessageId: current.requestId },
        toolDefinitions,
    });
    assertWholeTurns(messages, currentRequest);
    assert.ok(JSON.stringify(messages).includes('FULL-ONLY-'), 'large window should retain the full completed turn');
    assert.ok(JSON.stringify(messages).includes(evidence.id), 'prompt must expose the Artifact reference');
    assert.equal(JSON.stringify(messages).includes('secretRowPayload'), false, 'prompt must not inject persisted result rows');

    process.env.MAX_CONTEXT_TOKENS = '900';
    messages = await promptBuilder.buildMessages(conversationId, Number(user.id), 'system', {
        generationSnapshot: { contextUpperBound: upperBound, requestMessageId: current.requestId },
        toolDefinitions,
    });
    assertWholeTurns(messages, currentRequest);
    assert.equal(JSON.stringify(messages).includes('FULL-ONLY-'), false, 'small window must downgrade the whole turn');
    assert.ok(JSON.stringify(messages).includes('summary-answer'));
    assert.ok(JSON.stringify(messages).includes(currentRequest));
    const budgetUsed = estimateMessagesTokens(messages) + estimateTokens(JSON.stringify(toolDefinitions)) + 200;
    assert.ok(budgetUsed <= 900, `estimated request budget exceeded: ${budgetUsed}`);

    // Tool schemas consume the same budget and therefore can force whole-turn omission/downgrade.
    process.env.MAX_CONTEXT_TOKENS = '3500';
    const withoutTools = await promptBuilder.buildMessages(conversationId, Number(user.id), 'system', {
        generationSnapshot: { contextUpperBound: upperBound, requestMessageId: current.requestId },
        toolDefinitions: [],
    });
    const oversizedTools = [{ ...toolDefinitions[0], function: { ...toolDefinitions[0].function, description: 'z'.repeat(4_000) } }];
    const withOversizedTools = await promptBuilder.buildMessages(conversationId, Number(user.id), 'system', {
        generationSnapshot: { contextUpperBound: upperBound, requestMessageId: current.requestId },
        toolDefinitions: oversizedTools,
    });
    assert.ok(estimateMessagesTokens(withOversizedTools) < estimateMessagesTokens(withoutTools), 'tool schema cost must reduce available history budget');
    assertWholeTurns(withOversizedTools, currentRequest);

    assert.deepEqual(resolveModelCapability('small-model', { contextWindow: 8_000, responseReserve: 1_000 }), {
        contextWindow: 8_000,
        responseReserve: 1_000,
    });
    assert.deepEqual(resolveModelCapability('large-model', { contextWindow: 128_000, responseReserve: 8_000 }), {
        contextWindow: 128_000,
        responseReserve: 8_000,
    });

    // Turning the new reader off returns to the previous message-based context path.
    let legacyReads = 0;
    const legacyBuilder = new PromptBuilder(
        {},
        {
            getGenerationContextTurns: async () => assert.fail('turn reader must be disabled'),
            getGenerationContextMessages: async () => {
                legacyReads += 1;
                return [{ id: randomUUID(), role: 'user', content: 'legacy-user', blocks: [], llm_messages: [], created_at: new Date().toISOString() }];
            },
        }
    );
    process.env.TURN_CONTEXT_READ_ENABLED = '0';
    const legacyMessages = await legacyBuilder.buildMessages('conversation', 1, 'system', {
        generationSnapshot: { contextUpperBound: upperBound, requestMessageId: randomUUID() },
    });
    assert.equal(legacyReads, 1);
    assert.ok(JSON.stringify(legacyMessages).includes('legacy-user'));

    const schemaService = new SchemaService(database);
    const catalog = await schemaService.getSchemaCatalogSummary(Number(datasource.id), Number(user.id));
    assert.equal(catalog.datasourceId, Number(datasource.id));
    assert.ok(Array.isArray(catalog.tables));
    if (catalog.tables.length) {
        const detail = await schemaService.getSchemaDetail(Number(datasource.id), Number(user.id), catalog.tables[0].name);
        assert.equal(detail?.table, catalog.tables[0].name);
        assert.ok(Array.isArray(detail?.columns));
    }

    console.log(
        JSON.stringify(
            {
                completedOnlyTurns: 'PASS',
                currentRequestIsolation: 'PASS',
                wholeTurnBudgeting: 'PASS',
                artifactSummaryOnly: 'PASS',
                toolSchemaAccounting: 'PASS',
                modelCapabilityWindows: 'PASS',
                turnContextRollback: 'PASS',
                schemaCatalogAndDetail: 'PASS',
            },
            null,
            2
        )
    );
} finally {
    delete process.env.TURN_CONTEXT_READ_ENABLED;
    delete process.env.MAX_CONTEXT_TOKENS;
    delete process.env.RESPONSE_RESERVE_TOKENS;
    await database.execute('DELETE FROM app_user WHERE email=?', [email]).catch(() => undefined);
    await database.close();
}
