import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { GenerationErrorCode, GenerationStatus } from '@gist/contracts';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import type OpenAI from 'openai';
import { DatabaseService, type QueryRow } from '../database/database.service';
import type { SSEEvent, SSEEmitter } from './tools/base-tool';
import { GenerationExecutionError } from './generation-errors';

export interface GenerationIdentity {
    id: string;
    conversationId: string;
    requestMessageId: string;
    messageId: string;
    userId: number;
    datasourceId: number | null;
    contextUpperBound: string;
    parentMessageId: string | null;
    reasoningEnabled: boolean;
    writerToken: string;
}

const PUBLISH_SCRIPT = `
local sequence = redis.call('INCR', KEYS[1])
local event = cjson.decode(ARGV[1])
event.sequence = sequence
local generation_id = tostring(sequence) .. '-0'
redis.call('XADD', KEYS[2], generation_id, 'event', cjson.encode(event))
local user_id = redis.call('XADD', KEYS[3], '*', 'event', cjson.encode(event))
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[3], ARGV[2])
return { tostring(sequence), user_id }
`;

/** Worker 独占的 generation 写入仓库与 Redis 事件发布器。 */
@Injectable()
export class GenerationService implements OnModuleDestroy {
    private readonly redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null, commandTimeout: 5_000 });
    private readonly prefix = process.env.EVENT_KEY_PREFIX || 'gist-agent';
    private readonly retentionMs = 24 * 60 * 60 * 1000;
    private readonly queues = new Map<string, Promise<void>>();

    constructor(private readonly db: DatabaseService) {}

    async candidate(id: string): Promise<(Omit<GenerationIdentity, 'writerToken'> & { status: GenerationStatus }) | null> {
        const rows = await this.db.query<QueryRow[]>(
            `SELECT id,user_id,status,conversation_id,request_message_id,response_message_id,reasoning_enabled,
                    datasource_id,context_upper_bound,parent_message_id
               FROM generation WHERE id=?`,
            [id]
        );
        if (!rows.length) return null;
        return {
            id: rows[0].id,
            userId: rows[0].user_id,
            status: rows[0].status,
            conversationId: rows[0].conversation_id,
            requestMessageId: rows[0].request_message_id,
            messageId: rows[0].response_message_id,
            datasourceId: rows[0].datasource_id ?? null,
            contextUpperBound: rows[0].context_upper_bound,
            parentMessageId: rows[0].parent_message_id ?? null,
            reasoningEnabled: rows[0].reasoning_enabled === true,
        };
    }

    async claim(id: string, writerToken: string): Promise<GenerationIdentity | null> {
        const rows = await this.db.query<QueryRow[]>(
            `UPDATE generation g
      SET status='starting',writer_token=?,writer_heartbeat_at=NOW(),started_at=COALESCE(started_at,NOW()),updated_at=NOW()
      WHERE g.id=? AND g.status='pending' AND g.writer_token IS NULL
      RETURNING g.id,g.user_id,g.conversation_id,g.request_message_id,g.response_message_id,g.reasoning_enabled,
                g.datasource_id,g.context_upper_bound,g.parent_message_id`,
            [writerToken, id]
        );
        if (!rows.length) return null;
        await this.db.execute(
            `INSERT INTO generation_attempt (generation_id,attempt,status,writer_token)
      VALUES (?,(SELECT COALESCE(MAX(attempt),0)+1 FROM generation_attempt WHERE generation_id=?),'running',?)`,
            [id, id, writerToken]
        );
        await this.db.execute("UPDATE generation SET status='running',updated_at=NOW() WHERE id=? AND writer_token=? AND status='starting'", [id, writerToken]);
        return {
            id: rows[0].id,
            userId: rows[0].user_id,
            conversationId: rows[0].conversation_id,
            requestMessageId: rows[0].request_message_id,
            messageId: rows[0].response_message_id,
            datasourceId: rows[0].datasource_id ?? null,
            contextUpperBound: rows[0].context_upper_bound,
            parentMessageId: rows[0].parent_message_id ?? null,
            reasoningEnabled: rows[0].reasoning_enabled === true,
            writerToken,
        };
    }

    async heartbeat(id: string, writerToken: string): Promise<boolean> {
        const result = await this.db.execute(
            "UPDATE generation SET writer_heartbeat_at=NOW(),updated_at=NOW() WHERE id=? AND writer_token=? AND status IN ('starting','running','cancel_requested')",
            [id, writerToken]
        );
        return result.rowCount === 1;
    }

    async markFirstDelta(identity: GenerationIdentity): Promise<void> {
        await this.db.withTransaction(async (transaction) => {
            const [updated] = await transaction.execute(
                `UPDATE generation
                 SET first_token_at=COALESCE(first_token_at,NOW()),updated_at=NOW()
                 WHERE id=? AND writer_token=? AND status IN ('starting','running')`,
                [identity.id, identity.writerToken]
            );
            if (updated.rowCount !== 1) return;
            await transaction.execute(
                `UPDATE generation_attempt
                 SET received_first_delta=TRUE
                 WHERE generation_id=? AND writer_token=? AND completed_at IS NULL`,
                [identity.id, identity.writerToken]
            );
        });
    }

    async isCancelRequested(id: string): Promise<boolean> {
        const rows = await this.db.query<QueryRow[]>('SELECT status FROM generation WHERE id=?', [id]);
        return !rows.length || ['cancel_requested', 'cancelled'].includes(rows[0].status);
    }

    async assertWritable(identity: GenerationIdentity): Promise<void> {
        const rows = await this.db.query<QueryRow[]>("SELECT 1 FROM generation WHERE id=? AND writer_token=? AND status IN ('starting','running')", [
            identity.id,
            identity.writerToken,
        ]);
        if (!rows.length) throw new GenerationExecutionError('WRITER_OWNERSHIP_LOST', '生成任务写入权已丢失');
    }

    async checkpointMessage(identity: GenerationIdentity, blocks: SSEEvent[], llmMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): Promise<void> {
        const result = await this.db.execute(
            `UPDATE message
                SET blocks=?::jsonb,llm_messages=?::jsonb
              WHERE id=? AND EXISTS (
                    SELECT 1 FROM generation
                     WHERE id=? AND response_message_id=? AND writer_token=? AND status IN ('starting','running')
              )`,
            [JSON.stringify(blocks), JSON.stringify(llmMessages), identity.messageId, identity.id, identity.messageId, identity.writerToken]
        );
        if (result.rowCount !== 1) throw new GenerationExecutionError('WRITER_OWNERSHIP_LOST', '生成任务写入权已丢失');
    }

    emitter(identity: GenerationIdentity): SSEEmitter {
        return {
            send: (event) => {
                const prior = this.queues.get(identity.id) ?? Promise.resolve();
                this.queues.set(
                    identity.id,
                    prior.then(() => this.publish(identity, event))
                );
            },
        };
    }

    async drain(identity: GenerationIdentity): Promise<void> {
        await (this.queues.get(identity.id) ?? Promise.resolve());
        this.queues.delete(identity.id);
    }

    async finalize(
        identity: GenerationIdentity,
        status: Extract<GenerationStatus, 'completed' | 'failed' | 'cancelled'>,
        error: string | undefined,
        errorCode: GenerationErrorCode | undefined,
        terminal: SSEEvent,
        messageState?: { blocks: SSEEvent[]; llmMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] }
    ): Promise<boolean> {
        return this.db.withTransaction(async (transaction) => {
            const [updated] = await transaction.execute(
                `UPDATE generation SET status=?,error=?,error_code=?,updated_at=NOW(),completed_at=NOW(),writer_token=NULL
                  WHERE id=? AND (
                    (?<>'' AND writer_token=? AND status IN ('starting','running','cancel_requested'))
                    OR (?='' AND writer_token IS NULL AND status='cancel_requested')
                  )`,
                [status, error ?? null, errorCode ?? null, identity.id, identity.writerToken, identity.writerToken, identity.writerToken]
            );
            if (updated.rowCount !== 1) return false;
            if (messageState) {
                await transaction.execute('UPDATE message SET blocks=?::jsonb,llm_messages=?::jsonb WHERE id=?', [
                    JSON.stringify(messageState.blocks),
                    JSON.stringify(messageState.llmMessages),
                    identity.messageId,
                ]);
            }
            await transaction.execute('UPDATE generation_attempt SET status=?,error=?,completed_at=NOW() WHERE generation_id=? AND completed_at IS NULL', [
                status,
                error ?? null,
                identity.id,
            ]);
            await transaction.execute("INSERT INTO outbox_event (aggregate_id,type,payload) VALUES (?,'generation.terminal',?::jsonb)", [
                identity.id,
                JSON.stringify({
                    version: 1,
                    kind: 'generation.terminal',
                    generationId: identity.id,
                    userId: identity.userId,
                    conversationId: identity.conversationId,
                    messageId: identity.messageId,
                    event: terminal,
                }),
            ]);
            return true;
        });
    }

    async failStale(timeoutMs: number): Promise<number> {
        const rows = await this.db.query<QueryRow[]>(
            `UPDATE generation
      SET status='failed',error='生成进程意外中断，已保留收到的部分内容',error_code='WORKER_LOST',completed_at=NOW(),updated_at=NOW(),writer_token=NULL
      WHERE status IN ('starting','running') AND writer_token IS NOT NULL
        AND writer_heartbeat_at < NOW() - (? * INTERVAL '1 millisecond')
      RETURNING id,user_id,conversation_id,response_message_id`,
            [timeoutMs]
        );
        for (const row of rows) {
            await this.db.execute("UPDATE generation_attempt SET status='failed',error='WORKER_LOST',completed_at=NOW() WHERE generation_id=? AND completed_at IS NULL", [row.id]);
            await this.db.execute("INSERT INTO outbox_event (aggregate_id,type,payload) VALUES (?,'generation.terminal',?::jsonb)", [
                row.id,
                JSON.stringify({
                    version: 1,
                    kind: 'generation.terminal',
                    generationId: row.id,
                    userId: row.user_id,
                    conversationId: row.conversation_id,
                    messageId: row.response_message_id,
                    event: { type: 'done', status: 'failed', error: '生成进程意外中断，已保留收到的部分内容', errorCode: 'WORKER_LOST' },
                }),
            ]);
        }
        return rows.length;
    }

    private keys(userId: number, generationId: string) {
        const namespace = `${this.prefix}:{${userId}}`;
        return {
            user: `${namespace}:user`,
            sequence: `${namespace}:gen:${generationId}:seq`,
            generation: `${namespace}:gen:${generationId}`,
        };
    }

    private async publish(identity: GenerationIdentity, event: SSEEvent): Promise<void> {
        await this.db.withTransaction(async (transaction) => {
            const [owned] = await transaction.query<QueryRow[]>("SELECT 1 FROM generation WHERE id=? AND writer_token=? AND status IN ('starting','running') FOR UPDATE", [
                identity.id,
                identity.writerToken,
            ]);
            if (!owned.length) throw new GenerationExecutionError('WRITER_OWNERSHIP_LOST', '生成任务写入权已丢失');
            const keys = this.keys(identity.userId, identity.id);
            const payload = {
                ...event,
                eventId: randomUUID(),
                streamId: '0-0',
                generationId: identity.id,
                conversationId: identity.conversationId,
                messageId: identity.messageId,
                sequence: 0,
                occurredAt: new Date().toISOString(),
            };
            const result = (await this.redis.eval(PUBLISH_SCRIPT, 3, keys.sequence, keys.generation, keys.user, JSON.stringify(payload), String(this.retentionMs))) as [
                string,
                string,
            ];
            const sequence = Number(result[0]);
            await transaction.execute('UPDATE generation SET last_sequence=?,updated_at=NOW() WHERE id=? AND writer_token=? AND last_sequence < ?', [
                sequence,
                identity.id,
                identity.writerToken,
                sequence,
            ]);
        });
    }

    async onModuleDestroy(): Promise<void> {
        if (this.redis.status === 'ready') await this.redis.quit();
        else this.redis.disconnect();
    }
}
