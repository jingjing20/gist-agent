import { ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import type { Request, Response } from 'express';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { DatabaseService, QueryRow } from '../database/database.service';

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
        const conversation = await this.db.query<QueryRow[]>('SELECT datasource_id FROM conversation WHERE id = ? AND user_id = ?', [conversationId, userId]);
        if (!conversation.length) throw new NotFoundException('对话不存在');
        return this.db.withTransaction(async (tx) => {
            await tx.query('SELECT pg_advisory_xact_lock(?)', [userId]);
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
            const [counts] = await tx.query<QueryRow[]>(
                "SELECT COUNT(*)::int AS count FROM generation WHERE user_id = ? AND status IN ('pending','starting','running','cancel_requested')",
                [userId]
            );
            if (Number(counts[0].count) >= limit) throw new HttpException(`同时最多运行 ${limit} 个生成任务`, HttpStatus.TOO_MANY_REQUESTS);
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
            await tx.execute(
                "INSERT INTO generation (id,user_id,conversation_id,request_message_id,response_message_id,status,idempotency_key,request_hash,reasoning_enabled) VALUES (?,?,?,?,?,'pending',?,?,?)",
                [id, userId, conversationId, requestMessageId, responseMessageId, idempotencyKey, requestHash, reasoningEnabled]
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
            `SELECT conversation_id,request_message_id,reasoning_enabled FROM generation WHERE id=? AND user_id=? AND status IN ('failed','cancelled')`,
            [id, userId]
        );
        if (!rows.length) throw new NotFoundException('生成任务不可重试');
        const request = await this.db.query<QueryRow[]>('SELECT content FROM message WHERE id=?', [rows[0].request_message_id]);
        return { conversationId: rows[0].conversation_id, message: request[0]?.content ?? '', reasoningEnabled: rows[0].reasoning_enabled === true };
    }

    async sync(userId: number, knownIds: string[] = []) {
        const active = await this.db.query<QueryRow[]>(
            `SELECT g.id AS generation_id,g.conversation_id,g.response_message_id AS message_id,g.status,g.last_sequence,m.content,m.blocks
             FROM generation g JOIN message m ON m.id=g.response_message_id WHERE g.user_id=? AND g.status IN ('pending','starting','running','cancel_requested') ORDER BY g.created_at`,
            [userId]
        );
        const reconciled = knownIds.length
            ? await this.db.query<QueryRow[]>(
                  `SELECT g.id AS generation_id,g.conversation_id,g.response_message_id AS message_id,g.status,g.last_sequence,m.content,m.blocks,g.error
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
        if (contiguous && (events.length || after === Number(generation[0].last_sequence))) return { mode: 'events', events, lastSequence: events.at(-1)?.sequence ?? after };
        return {
            mode: 'snapshot',
            snapshot: {
                content: generation[0].content,
                blocks: generation[0].blocks,
                sequence: Number(generation[0].last_sequence),
                status: generation[0].status,
                error: generation[0].error,
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
