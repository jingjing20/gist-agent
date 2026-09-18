import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { applyPhase4Schema, DatabaseClient } from '@gist/database';
import { loadWorkspaceEnv } from '@gist/config';

loadWorkspaceEnv();
const require = createRequire(import.meta.url);
const { ArtifactRepository, stableStringify } = require('../apps/worker/dist/chat/artifact.repository.js');
const { GenerateChartTool } = require('../apps/worker/dist/chat/tools/generate-chart.tool.js');
const { ReadQueryArtifactTool } = require('../apps/worker/dist/chat/tools/read-query-artifact.tool.js');
const { SqlQueryTool } = require('../apps/worker/dist/chat/tools/sql-query.tool.js');
const { SqlExecutorAgent } = require('../apps/worker/dist/chat/agents/sql-executor.js');

const database = new DatabaseClient();
await applyPhase4Schema(database);
const email = `phase3-artifacts-${randomUUID()}@example.test`;
const ownerEmail = `phase3-owner-${randomUUID()}@example.test`;
let privateDatasourceId;

async function createUser(userEmail, name) {
    return (await database.query('INSERT INTO app_user (email,password_hash,name) VALUES (?,?,?) RETURNING id', [userEmail, 'phase3-test', name]))[0];
}

async function createGeneration(userId, conversationId, datasourceId, status = 'completed') {
    const requestId = randomUUID();
    const responseId = randomUUID();
    const generationId = randomUUID();
    await database.execute("INSERT INTO message (id,conversation_id,role,content,blocks,llm_messages) VALUES (?,?, 'user','request','[]'::jsonb,'[]'::jsonb)", [
        requestId,
        conversationId,
    ]);
    await database.execute("INSERT INTO message (id,conversation_id,role,content,blocks,llm_messages) VALUES (?,?, 'assistant','answer','[]'::jsonb,'[]'::jsonb)", [
        responseId,
        conversationId,
    ]);
    await database.execute(
        `INSERT INTO generation (
            id,user_id,conversation_id,request_message_id,response_message_id,status,datasource_id,context_upper_bound,completed_at
         ) VALUES (?,?,?,?,?,?,?,?,CASE WHEN ?='completed' THEN NOW() ELSE NULL END)`,
        [generationId, userId, conversationId, requestId, responseId, status, datasourceId, new Date().toISOString(), status]
    );
    await database.execute(
        `INSERT INTO conversation_turn (
            id,conversation_id,sequence,generation_id,user_message_id,assistant_message_id,status,final_answer,completed_at
         ) VALUES (?, ?, (SELECT COALESCE(MAX(sequence),0)+1 FROM conversation_turn WHERE conversation_id=?), ?, ?, ?, ?, ?,
                   CASE WHEN ?='pending' THEN NULL ELSE NOW() END)`,
        [randomUUID(), conversationId, conversationId, generationId, requestId, responseId, status, status === 'completed' ? 'answer' : null, status]
    );
    return generationId;
}

function toolContext({ userId, conversationId, generationId, datasourceId, events = [], assertWritable = async () => undefined }) {
    return {
        userId,
        conversationId,
        generationId,
        datasourceId,
        schemaContextVersion: 'schema-context-v2',
        emitter: { send: (event) => events.push(event) },
        signal: new AbortController().signal,
        assertWritable,
    };
}

function expectCode(code) {
    return (error) => error?.code === code;
}

try {
    const user = await createUser(email, 'Phase 3 Artifacts');
    const other = await createUser(ownerEmail, 'Phase 3 Owner');
    const localDatasource = (await database.query('SELECT id FROM data_source WHERE is_local=1 LIMIT 1'))[0];
    assert.ok(localDatasource?.id, 'local datasource is required');

    const conversationId = randomUUID();
    const otherConversationId = randomUUID();
    await database.execute('INSERT INTO conversation (id,user_id,title,datasource_id) VALUES (?,?,?,?)', [conversationId, user.id, 'Artifacts', localDatasource.id]);
    await database.execute('INSERT INTO conversation (id,user_id,title,datasource_id) VALUES (?,?,?,?)', [otherConversationId, user.id, 'Other conversation', localDatasource.id]);
    const generationId = await createGeneration(user.id, conversationId, localDatasource.id);
    const repository = new ArtifactRepository(database);
    const plan = { purpose: '对比每日指标', expectedGrain: '每天', expectedShape: 'timeseries' };
    const rows = Array.from({ length: 120 }, (_, index) => ({ day: `2026-09-${String((index % 30) + 1).padStart(2, '0')}`, value: index + 1 }));
    const columns = [
        { name: 'day', type: 'date' },
        { name: 'value', type: 'number' },
    ];
    const artifact = await repository.createQueryArtifact({
        generationId,
        userId: Number(user.id),
        conversationId,
        datasourceId: Number(localDatasource.id),
        title: '每日指标',
        plan,
        originalSql: 'SELECT day,value FROM metric',
        executedSql: 'SELECT day,value FROM metric LIMIT 1000',
        schemaContextVersion: 'schema-context-v2',
        columns,
        rows,
        returnedRowCount: rows.length,
        isLimited: false,
    });
    assert.equal(artifact.datasourceId, Number(localDatasource.id));
    assert.equal(artifact.totalRowCount, undefined, 'ordinary results must not infer totalRowCount');
    assert.equal(artifact.resultContentHash, createHash('sha256').update(stableStringify(rows)).digest('hex'));
    const stored = (await database.query('SELECT original_sql,executed_sql,result_content_hash,result_rows FROM query_artifact WHERE id=?', [artifact.id]))[0];
    assert.equal(stored.original_sql, 'SELECT day,value FROM metric');
    assert.equal(stored.executed_sql, 'SELECT day,value FROM metric LIMIT 1000');
    assert.equal(stored.result_content_hash, artifact.resultContentHash);
    assert.deepEqual(stored.result_rows, rows);

    // Artifact read exposes at most the requested sample and never widens conversation/user access.
    assert.equal((await repository.readQueryArtifact(artifact.id, Number(user.id), conversationId, 100)).rows.length, 100);
    await assert.rejects(() => repository.readQueryArtifact(artifact.id, Number(user.id), otherConversationId), expectCode('ARTIFACT_ACCESS_DENIED'));
    await assert.rejects(() => repository.readQueryArtifact(artifact.id, Number(other.id), conversationId), expectCode('ARTIFACT_ACCESS_DENIED'));
    await assert.rejects(() => repository.readQueryArtifact(randomUUID(), Number(user.id), conversationId), expectCode('ARTIFACT_NOT_FOUND'));

    const readTool = new ReadQueryArtifactTool(repository);
    const readResult = await readTool.execute(
        { queryArtifactId: artifact.id },
        toolContext({ userId: Number(user.id), conversationId, generationId, datasourceId: Number(localDatasource.id) })
    );
    assert.equal(JSON.parse(readResult.toolResult).rows.length, 100);
    assert.deepEqual(readResult.blocks, []);

    const laterGenerationId = await createGeneration(user.id, conversationId, localDatasource.id, 'completed');
    const historicalRead = await readTool.execute(
        { queryArtifactId: artifact.id },
        toolContext({ userId: Number(user.id), conversationId, generationId: laterGenerationId, datasourceId: Number(localDatasource.id) })
    );
    assert.equal(JSON.parse(historicalRead.toolResult).queryArtifactId, artifact.id, 'completed historical Turn evidence should remain reusable');

    const failedGenerationId = await createGeneration(user.id, conversationId, localDatasource.id, 'failed');
    const failedArtifact = await repository.createQueryArtifact({
        generationId: failedGenerationId,
        userId: Number(user.id),
        conversationId,
        datasourceId: Number(localDatasource.id),
        title: '失败轮次证据',
        plan,
        originalSql: 'SELECT 1',
        executedSql: 'SELECT 1',
        schemaContextVersion: 'schema-context-v2',
        columns: [{ name: 'value', type: 'number' }],
        rows: [{ value: 1 }],
        returnedRowCount: 1,
        isLimited: false,
    });
    await assert.rejects(
        () =>
            readTool.execute(
                { queryArtifactId: failedArtifact.id },
                toolContext({ userId: Number(user.id), conversationId, generationId: laterGenerationId, datasourceId: Number(localDatasource.id) })
            ),
        expectCode('ARTIFACT_ACCESS_DENIED')
    );

    // Chart data is derived server-side from Artifact rows and persisted as a reference.
    const chartEvents = [];
    const chartTool = new GenerateChartTool(repository);
    const chartArgs = chartTool.parseArguments({
        queryArtifactId: artifact.id,
        chartType: 'line',
        title: '每日趋势',
        xField: 'day',
        yFields: [{ field: 'value', label: '指标' }],
        filters: [{ field: 'value', operator: 'gte', value: 118 }],
        sort: [{ field: 'value', direction: 'desc' }],
    });
    const chartResult = await chartTool.execute(
        chartArgs,
        toolContext({ userId: Number(user.id), conversationId, generationId, datasourceId: Number(localDatasource.id), events: chartEvents })
    );
    const chartPayload = JSON.parse(chartResult.toolResult);
    assert.equal(chartEvents.at(-1).queryArtifactId, artifact.id);
    assert.deepEqual(chartEvents.at(-1).chartData.series[0].data, [120, 119, 118]);
    assert.equal(
        Number(
            (await database.query('SELECT COUNT(*)::int AS count FROM chart_artifact WHERE id=? AND query_artifact_id=?', [chartPayload.chartArtifactId, artifact.id]))[0].count
        ),
        1
    );
    await assert.rejects(
        () => chartTool.execute({ ...chartArgs, yFields: [{ field: 'missing', label: '无' }] }, toolContext({ userId: Number(user.id), conversationId, generationId })),
        expectCode('ARTIFACT_FIELD_INVALID')
    );
    await assert.rejects(
        () => chartTool.execute({ ...chartArgs, chartType: 'scatter', xField: 'day' }, toolContext({ userId: Number(user.id), conversationId, generationId })),
        expectCode('ARTIFACT_FIELD_INVALID')
    );

    // Expiry is fail-closed.
    const expiring = await repository.createQueryArtifact({
        generationId,
        userId: Number(user.id),
        conversationId,
        datasourceId: Number(localDatasource.id),
        title: '过期证据',
        plan,
        originalSql: 'SELECT 1',
        executedSql: 'SELECT 1',
        schemaContextVersion: 'schema-context-v2',
        columns: [{ name: 'value', type: 'number' }],
        rows: [{ value: 1 }],
        returnedRowCount: 1,
        isLimited: false,
    });
    await database.execute("UPDATE query_artifact SET expires_at=NOW()-INTERVAL '1 second' WHERE id=?", [expiring.id]);
    await assert.rejects(() => repository.readQueryArtifact(expiring.id, Number(user.id), conversationId), expectCode('ARTIFACT_NOT_FOUND'));

    // Current datasource authorization is re-checked, so revocation invalidates old evidence.
    privateDatasourceId = Number(
        (
            await database.query('INSERT INTO data_source (name,is_local,created_by,description) VALUES (?,0,?,?) RETURNING id', [
                `Phase3 private ${randomUUID()}`,
                other.id,
                'revocation test',
            ])
        )[0].id
    );
    await database.execute('INSERT INTO datasource_permission (datasource_id,user_id,granted_by) VALUES (?,?,?)', [privateDatasourceId, user.id, other.id]);
    const privateArtifact = await repository.createQueryArtifact({
        generationId,
        userId: Number(user.id),
        conversationId,
        datasourceId: privateDatasourceId,
        title: '撤权证据',
        plan,
        originalSql: 'SELECT 1',
        executedSql: 'SELECT 1',
        schemaContextVersion: 'schema-context-v2',
        columns: [{ name: 'value', type: 'number' }],
        rows: [{ value: 1 }],
        returnedRowCount: 1,
        isLimited: false,
    });
    assert.equal((await repository.readQueryArtifact(privateArtifact.id, Number(user.id), conversationId)).rows.length, 1);
    await database.execute('DELETE FROM datasource_permission WHERE datasource_id=? AND user_id=?', [privateDatasourceId, user.id]);
    await assert.rejects(() => repository.readQueryArtifact(privateArtifact.id, Number(user.id), conversationId), expectCode('ARTIFACT_ACCESS_DENIED'));

    // Result size is bounded before persistence.
    await assert.rejects(
        () =>
            repository.createQueryArtifact({
                generationId,
                userId: Number(user.id),
                conversationId,
                datasourceId: Number(localDatasource.id),
                title: '超大证据',
                plan,
                originalSql: 'SELECT payload',
                executedSql: 'SELECT payload',
                schemaContextVersion: 'schema-context-v2',
                columns: [{ name: 'payload', type: 'string' }],
                rows: [{ payload: 'x'.repeat(5 * 1024 * 1024) }],
                returnedRowCount: 1,
                isLimited: false,
            }),
        expectCode('ARTIFACT_RESULT_TOO_LARGE')
    );

    // SQL field metadata normalization is conservative for bigint/numeric strings.
    const executor = new SqlExecutorAgent(
        {
            queryReadOnlyWithFields: async () => ({
                rows: [{ safe: '42', unsafe: '9007199254740993', occurred_at: new Date('2026-09-17T00:00:00Z'), enabled: true }],
                fields: [
                    { name: 'safe', dataTypeID: 20 },
                    { name: 'unsafe', dataTypeID: 20 },
                    { name: 'occurred_at', dataTypeID: 1184 },
                    { name: 'enabled', dataTypeID: 16 },
                ],
            }),
        },
        { chat: async () => '' },
        { getAllowedTableNames: async () => [], getColumnPolicies: async () => [] }
    );
    const normalized = await executor.execute('SELECT 1', null, 1);
    assert.deepEqual(normalized.columns, [
        { name: 'safe', type: 'number' },
        { name: 'unsafe', type: 'unknown' },
        { name: 'occurred_at', type: 'date' },
        { name: 'enabled', type: 'boolean' },
    ]);
    assert.equal(normalized.rows[0].safe, 42);
    assert.equal(normalized.rows[0].unsafe, '9007199254740993');
    assert.equal(normalized.rows[0].occurred_at, '2026-09-17T00:00:00.000Z');
    assert.equal(normalized.isLimited, false);

    // Query Artifact is persisted before the table event; a write failure cannot emit an untraceable table.
    const toolEvents = [];
    const sqlTool = new SqlQueryTool(
        {
            execute: async () => ({
                finalSql: 'SELECT day,value FROM metric LIMIT 1000',
                wasFixed: true,
                columns,
                rows: rows.slice(0, 2),
                rowCount: 2,
                isLimited: false,
            }),
        },
        repository
    );
    const sqlResult = await sqlTool.execute(
        { title: '查询指标', sql: 'SELECT day,value FROM metric', plan },
        toolContext({ userId: Number(user.id), conversationId, generationId, datasourceId: Number(localDatasource.id), events: toolEvents })
    );
    const table = toolEvents.find((event) => event.type === 'table');
    assert.ok(table?.queryArtifactId);
    assert.equal(table.resultContentHash, (await database.query('SELECT result_content_hash FROM query_artifact WHERE id=?', [table.queryArtifactId]))[0].result_content_hash);
    assert.equal(JSON.parse(sqlResult.toolResult).queryArtifactId, table.queryArtifactId);

    const failureEvents = [];
    const failingSqlTool = new SqlQueryTool(
        { execute: async () => ({ finalSql: 'SELECT 1', wasFixed: false, columns: [], rows: [], rowCount: 0, isLimited: false }) },
        {
            createQueryArtifact: async () => {
                throw new Error('artifact unavailable');
            },
        }
    );
    const failedWrite = await failingSqlTool.execute(
        { title: '失败查询', sql: 'SELECT 1', plan },
        toolContext({ userId: Number(user.id), conversationId, generationId, datasourceId: Number(localDatasource.id), events: failureEvents })
    );
    assert.equal(failedWrite.succeeded, false);
    assert.equal(
        failureEvents.some((event) => event.type === 'table'),
        false
    );

    let fenceChecks = 0;
    const cancelledEvents = [];
    const cancellationRace = new SqlQueryTool(
        { execute: async () => ({ finalSql: 'SELECT 1', wasFixed: false, columns: [], rows: [], rowCount: 0, isLimited: false }) },
        { createQueryArtifact: async () => ({ id: randomUUID(), resultContentHash: 'hash' }) }
    );
    const cancelledWrite = await cancellationRace.execute(
        { title: '取消竞争', sql: 'SELECT 1', plan },
        toolContext({
            userId: Number(user.id),
            conversationId,
            generationId,
            datasourceId: Number(localDatasource.id),
            events: cancelledEvents,
            assertWritable: async () => {
                fenceChecks += 1;
                if (fenceChecks >= 3) throw new Error('writer cancelled during artifact write');
            },
        })
    );
    assert.equal(cancelledWrite.succeeded, false);
    assert.equal(
        cancelledEvents.some((event) => event.type === 'table'),
        false
    );

    // Rollback switches are independent and preserve the legacy table block path.
    process.env.ARTIFACT_DUAL_WRITE_ENABLED = '0';
    const rollbackEvents = [];
    const rollback = await sqlTool.execute(
        { title: '回滚查询', sql: 'SELECT day,value FROM metric', plan },
        toolContext({ userId: Number(user.id), conversationId, generationId, datasourceId: Number(localDatasource.id), events: rollbackEvents })
    );
    assert.equal(rollback.succeeded, true);
    assert.equal(rollbackEvents.find((event) => event.type === 'table').queryArtifactId, undefined);
    process.env.ARTIFACT_DUAL_WRITE_ENABLED = '1';

    process.env.ARTIFACT_CHART_READ_ENABLED = '0';
    await assert.rejects(
        () => readTool.execute({ queryArtifactId: artifact.id }, toolContext({ userId: Number(user.id), conversationId, generationId })),
        expectCode('TOOL_EXECUTION_FAILED')
    );
    await assert.rejects(() => chartTool.execute(chartArgs, toolContext({ userId: Number(user.id), conversationId, generationId })), expectCode('TOOL_EXECUTION_FAILED'));
    process.env.ARTIFACT_CHART_READ_ENABLED = '1';

    console.log(
        JSON.stringify(
            {
                queryArtifact: 'PASS',
                hashAndDualWrite: 'PASS',
                chartArtifact: 'PASS',
                readLimit: 'PASS',
                authorizationAndExpiry: 'PASS',
                completedTurnReuseFence: 'PASS',
                datasourceRevocation: 'PASS',
                fieldNormalization: 'PASS',
                sizeLimit: 'PASS',
                rollbackSwitches: 'PASS',
                cancellationWriterFence: 'PASS',
            },
            null,
            2
        )
    );
} finally {
    delete process.env.ARTIFACT_DUAL_WRITE_ENABLED;
    delete process.env.ARTIFACT_CHART_READ_ENABLED;
    await database.execute('DELETE FROM app_user WHERE email=?', [email]).catch(() => undefined);
    if (privateDatasourceId) await database.execute('DELETE FROM data_source WHERE id=?', [privateDatasourceId]).catch(() => undefined);
    await database.execute('DELETE FROM app_user WHERE email=?', [ownerEmail]).catch(() => undefined);
    await database.close();
}
