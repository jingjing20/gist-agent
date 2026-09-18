import { ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import type { Request, Response } from 'express';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { DatabaseService, QueryRow } from '../database/database.service';
import { AGENT_RUNTIME_VERSIONS } from '@gist/contracts';

@Injectable()
export class GenerationService implements OnModuleDestroy {
    private readonly redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
    private readonly prefix = process.env.EVENT_KEY_PREFIX || 'gist-agent';

    constructor(private readonly db: DatabaseService) {}

    async createTurn(userId: number, conversationId: string, message: string, datasourceId: number | null, idempotencyKey: string, requestHash: string, reasoningEnabled: boolean) {
        const id = randomUUID();
        const requestMessageId = randomUUID();
        const responseMessageId = randomUUID();
        const limit = Number(process.env.USER_GENERATION_CONCURRENCY_LIMIT) || 5;
        return this.db.withTransaction(async (tx) => {
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [conversationId]);
            const [existing] = await tx.query<QueryRow[]>(
                'SELECT id,conversation_id,request_message_id,response_message_id,request_hash FROM generation WHERE user_id=? AND idempotency_key=?',
                [userId, idempotencyKey]
            );
            if (existing.length) {
                if (existing[0].request_hash !== requestHash) throw new ForbiddenException('Idempotency-Key 已被其他请求使用');
                return {
                    generationId: existing[0].id,
                    conversationId: existing[0].conversation_id,
                    userMessageId: existing[0].request_message_id,
                    responseMessageId: existing[0].response_message_id,
                };
            }
            const [conversation] = await tx.query<QueryRow[]>('SELECT datasource_id FROM conversation WHERE id = ? AND user_id = ? FOR UPDATE', [conversationId, userId]);
            if (!conversation.length) throw new NotFoundException('对话不存在');
            const [active] = await tx.query<QueryRow[]>(
                "SELECT id FROM generation WHERE conversation_id=? AND status IN ('pending','starting','running','cancel_requested') LIMIT 1",
                [conversationId]
            );
            if (active.length) throw new ConflictException({ code: 'CONVERSATION_GENERATION_ACTIVE', message: '当前对话已有生成任务在运行' });
            const [counts] = await tx.query<QueryRow[]>(
                "SELECT COUNT(*)::int AS count FROM generation WHERE user_id = ? AND status IN ('pending','starting','running','cancel_requested')",
                [userId]
            );
            if (Number(counts[0].count) >= limit) throw new HttpException(`同时最多运行 ${limit} 个生成任务`, HttpStatus.TOO_MANY_REQUESTS);
            const [snapshot] = await tx.query<QueryRow[]>('SELECT clock_timestamp() AS context_upper_bound');
            const [parent] = await tx.query<QueryRow[]>(
                `SELECT response_message_id
                   FROM generation
                  WHERE conversation_id=? AND status='completed'
                  ORDER BY completed_at DESC NULLS LAST, created_at DESC
                  LIMIT 1`,
                [conversationId]
            );
            const effectiveDatasourceId = datasourceId ?? conversation[0].datasource_id ?? null;
            await tx.execute("INSERT INTO message (id,conversation_id,role,content,blocks,llm_messages) VALUES (?,?,?,?,'[]'::jsonb,'[]'::jsonb)", [
                requestMessageId,
                conversationId,
                'user',
                message,
            ]);
            await tx.execute("INSERT INTO message (id,conversation_id,role,content,blocks,llm_messages) VALUES (?,?,?,'','[]'::jsonb,'[]'::jsonb)", [
                responseMessageId,
                conversationId,
                'assistant',
            ]);
            const modelName = reasoningEnabled
                ? process.env.OPENAI_REASONING_MODEL || process.env.OPENAI_MODEL || 'gpt-4o'
                : process.env.OPENAI_FAST_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';
            await tx.execute(
                `INSERT INTO generation (
                    id,user_id,conversation_id,request_message_id,response_message_id,status,
                    idempotency_key,request_hash,reasoning_enabled,model_provider,model_name,
                    prompt_policy_version,toolset_version,context_policy_version,memory_policy_version,schema_context_version,
                    datasource_id,context_upper_bound,parent_message_id
                ) VALUES (?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    id,
                    userId,
                    conversationId,
                    requestMessageId,
                    responseMessageId,
                    idempotencyKey,
                    requestHash,
                    reasoningEnabled,
                    process.env.LLM_PROVIDER || 'openai-compatible',
                    modelName,
                    AGENT_RUNTIME_VERSIONS.promptPolicy,
                    AGENT_RUNTIME_VERSIONS.toolset,
                    AGENT_RUNTIME_VERSIONS.contextPolicy,
                    AGENT_RUNTIME_VERSIONS.memoryPolicy,
                    AGENT_RUNTIME_VERSIONS.schemaContext,
                    effectiveDatasourceId,
                    snapshot[0].context_upper_bound,
                    parent[0]?.response_message_id ?? null,
                ]
            );
            await tx.execute(
                `INSERT INTO conversation_turn (
                    id,conversation_id,sequence,generation_id,user_message_id,assistant_message_id,status,created_at
                 ) VALUES (?, ?, (SELECT COALESCE(MAX(sequence),0)+1 FROM conversation_turn WHERE conversation_id=?), ?, ?, ?, 'pending', NOW())`,
                [randomUUID(), conversationId, conversationId, id, requestMessageId, responseMessageId]
            );
            await tx.execute("INSERT INTO outbox_event (aggregate_id,type,payload) VALUES (?,'generation.enqueue',?::jsonb)", [
                id,
                JSON.stringify({ version: 1, generationId: id }),
            ]);
            const title = message.slice(0, 30) + (message.length > 30 ? '...' : '');
            await tx.execute("UPDATE conversation SET title=CASE WHEN title='新对话' THEN ? ELSE title END,datasource_id=COALESCE(?,datasource_id),updated_at=NOW() WHERE id=?", [
                title,
                datasourceId,
                conversationId,
            ]);
            return { generationId: id, conversationId, userMessageId: requestMessageId, responseMessageId };
        });
    }

    private keys(userId: number, generationId?: string) {
        const namespace = `${this.prefix}:{${userId}}`;
        return { user: `${namespace}:user`, sequence: `${namespace}:gen:${generationId}:seq`, generation: `${namespace}:gen:${generationId}` };
    }

    async cancel(userId: number, id: string): Promise<void> {
        const result = await this.db.execute(
            "UPDATE generation SET status='cancel_requested',cancel_requested_at=NOW(),updated_at=NOW() WHERE id=? AND user_id=? AND status IN ('pending','starting','running') RETURNING id",
            [id, userId]
        );
        if (!result.rows.length) throw new NotFoundException('活动生成任务不存在');
    }

    async retry(userId: number, id: string) {
        const rows = await this.db.query<QueryRow[]>(
            `SELECT conversation_id,request_message_id,reasoning_enabled,datasource_id FROM generation WHERE id=? AND user_id=? AND status IN ('failed','cancelled')`,
            [id, userId]
        );
        if (!rows.length) throw new NotFoundException('生成任务不可重试');
        const request = await this.db.query<QueryRow[]>('SELECT content FROM message WHERE id=?', [rows[0].request_message_id]);
        return {
            conversationId: rows[0].conversation_id,
            message: request[0]?.content ?? '',
            datasourceId: rows[0].datasource_id ?? null,
            reasoningEnabled: rows[0].reasoning_enabled === true,
        };
    }

    async sync(userId: number, knownIds: string[] = []) {
        const active = await this.db.query<QueryRow[]>(
            `SELECT g.id AS generation_id,g.conversation_id,g.response_message_id AS message_id,g.status,g.last_sequence,m.content,m.blocks
             FROM generation g JOIN message m ON m.id=g.response_message_id WHERE g.user_id=? AND g.status IN ('pending','starting','running','cancel_requested') ORDER BY g.created_at`,
            [userId]
        );
        const reconciled = knownIds.length
            ? await this.db.query<QueryRow[]>(
                  `SELECT g.id AS generation_id,g.conversation_id,g.response_message_id AS message_id,g.status,g.last_sequence,m.content,m.blocks,g.error,g.error_code
             FROM generation g JOIN message m ON m.id=g.response_message_id WHERE g.user_id=? AND g.id IN (${knownIds.map(() => '?').join(',')})`,
                  [userId, ...knownIds]
              )
            : [];
        const cursor = (await this.redis.xrevrange(this.keys(userId).user, '+', '-', 'COUNT', 1))[0]?.[0] ?? '0-0';
        return { eventCursor: cursor, activeGenerations: active, reconciledGenerations: reconciled };
    }

    async history(userId: number, generationId: string, after: number) {
        const generation = await this.db.query<QueryRow[]>(
            `SELECT g.*,m.content,m.blocks FROM generation g JOIN message m ON m.id=g.response_message_id WHERE g.id=? AND g.user_id=?`,
            [generationId, userId]
        );
        if (!generation.length) throw new NotFoundException('生成任务不存在');
        const rows = await this.redis.xrange(this.keys(userId, generationId).generation, `(${after}-0`, '+');
        const events = rows.map(([streamId, fields]) => ({ ...JSON.parse(fields[1]), streamId }));
        const contiguous = events.every((event, index) => event.sequence === after + index + 1);
        const terminal = ['completed', 'failed', 'cancelled'].includes(generation[0].status);
        const hasTerminalEvent = events.some((event) => event.type === 'done');
        if (contiguous && (events.length || after === Number(generation[0].last_sequence)) && (!terminal || hasTerminalEvent)) {
            return { mode: 'events', events, lastSequence: events.at(-1)?.sequence ?? after };
        }
        return {
            mode: 'snapshot',
            snapshot: {
                content: generation[0].content,
                blocks: generation[0].blocks,
                sequence: Number(generation[0].last_sequence),
                status: generation[0].status,
                error: generation[0].error,
                errorCode: generation[0].error_code,
            },
        };
    }

    async stream(userId: number, after: string, request: Request, response: Response): Promise<void> {
        response
            .status(200)
            .set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
        const client = this.redis.duplicate();
        let cursor = /^\d+-\d+$/.test(after) ? after : '0-0';
        let closed = false;
        request.once('close', () => {
            closed = true;
            client.disconnect();
        });
        try {
            while (!closed) {
                const result = await client.xread('COUNT', 100, 'BLOCK', 15000, 'STREAMS', this.keys(userId).user, cursor);
                if (!result) {
                    response.write(': heartbeat\n\n');
                    continue;
                }
                for (const [, entries] of result)
                    for (const [streamId, fields] of entries) {
                        const event = { ...JSON.parse(fields[1]), streamId };
                        response.write(`id: ${streamId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                        cursor = streamId;
                    }
            }
        } finally {
            client.disconnect();
            if (!response.writableEnded) response.end();
        }
    }

    async onModuleDestroy() {
        if (this.redis.status === 'ready') await this.redis.quit();
        else this.redis.disconnect();
    }
}
