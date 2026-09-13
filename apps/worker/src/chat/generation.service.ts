import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { GenerationStatus } from '@gist/contracts';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { DatabaseService, type QueryRow } from '../database/database.service';
import type { SSEEvent, SSEEmitter } from './tools/base-tool';

export interface GenerationIdentity {
    id: string;
    conversationId: string;
    messageId: string;
    userId: number;
    datasourceId: number | null;
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
    private readonly redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
    private readonly prefix = process.env.EVENT_KEY_PREFIX || 'gist-agent';
    private readonly retentionMs = 24 * 60 * 60 * 1000;
    private readonly queues = new Map<string, Promise<void>>();

    constructor(private readonly db: DatabaseService) {}

    async candidate(id: string): Promise<(Omit<GenerationIdentity, 'writerToken'> & { status: GenerationStatus }) | null> {
        const rows = await this.db.query<QueryRow[]>(
            `SELECT g.id,g.user_id,g.status,g.conversation_id,g.response_message_id,g.reasoning_enabled,c.datasource_id
      FROM generation g JOIN conversation c ON c.id=g.conversation_id WHERE g.id=?`,
            [id]
        );
        if (!rows.length) return null;
        return {
            id: rows[0].id,
            userId: rows[0].user_id,
            status: rows[0].status,
            conversationId: rows[0].conversation_id,
            messageId: rows[0].response_message_id,
            datasourceId: rows[0].datasource_id ?? null,
            reasoningEnabled: rows[0].reasoning_enabled === true,
        };
    }

    async claim(id: string, writerToken: string): Promise<GenerationIdentity | null> {
        const rows = await this.db.query<QueryRow[]>(
            `UPDATE generation g
      SET status='starting',writer_token=?,writer_heartbeat_at=NOW(),started_at=COALESCE(started_at,NOW()),updated_at=NOW()
      FROM conversation c
      WHERE g.id=? AND g.status='pending' AND g.writer_token IS NULL AND c.id=g.conversation_id
      RETURNING g.id,g.user_id,g.conversation_id,g.response_message_id,g.reasoning_enabled,c.datasource_id`,
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
            messageId: rows[0].response_message_id,
            datasourceId: rows[0].datasource_id ?? null,
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

    async isCancelRequested(id: string): Promise<boolean> {
        const rows = await this.db.query<QueryRow[]>('SELECT status FROM generation WHERE id=?', [id]);
        return !rows.length || ['cancel_requested', 'cancelled'].includes(rows[0].status);
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
        terminal: SSEEvent
    ): Promise<void> {
        await this.db.withTransaction(async (transaction) => {
            const [updated] = await transaction.execute(
                `UPDATE generation SET status=?,error=?,updated_at=NOW(),completed_at=NOW(),writer_token=NULL
        WHERE id=? AND (?='' OR writer_token=?)`,
                [status, error ?? null, identity.id, identity.writerToken, identity.writerToken]
            );
            if (updated.rowCount !== 1) return;
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
        });
    }

    async failStale(timeoutMs: number): Promise<number> {
        const rows = await this.db.query<QueryRow[]>(
            `UPDATE generation
      SET status='failed',error='生成进程意外中断，已保留收到的部分内容',completed_at=NOW(),updated_at=NOW(),writer_token=NULL
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
                    event: { type: 'done', status: 'failed', error: '生成进程意外中断，已保留收到的部分内容' },
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
        const result = (await this.redis.eval(PUBLISH_SCRIPT, 3, keys.sequence, keys.generation, keys.user, JSON.stringify(payload), String(this.retentionMs))) as [string, string];
        const sequence = Number(result[0]);
        await this.db.execute('UPDATE generation SET last_sequence=?,updated_at=NOW() WHERE id=? AND last_sequence < ?', [sequence, identity.id, sequence]);
    }

    async onModuleDestroy(): Promise<void> {
        if (this.redis.status === 'ready') await this.redis.quit();
        else this.redis.disconnect();
    }
}
