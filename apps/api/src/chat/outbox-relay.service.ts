import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DatabaseService, QueryRow } from '../database/database.service';
import { GENERATION_QUEUE_NAME, parseGenerationJob, parseGenerationTerminalOutboxPayload } from '@gist/contracts';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

const PUBLISH_TERMINAL_SCRIPT = `
local existing = redis.call('GET', KEYS[4])
if existing then return tonumber(existing) end
local sequence = redis.call('INCR', KEYS[1])
-- Keep empty arrays and objects distinct; do not round-trip the body through cjson.
local event = string.sub(ARGV[1], 1, -2) .. ',"sequence":' .. tostring(sequence) .. '}'
redis.call('XADD', KEYS[2], tostring(sequence) .. '-0', 'event', event)
redis.call('XADD', KEYS[3], '*', 'event', event)
redis.call('SET', KEYS[4], tostring(sequence), 'PX', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[3], ARGV[2])
return sequence
`;

const PUBLISH_EVENT_SCRIPT = `
local existing = redis.call('GET', KEYS[4])
if existing then return tonumber(existing) end
local sequence = tonumber(ARGV[3])
local last = tonumber(redis.call('GET', KEYS[1]) or '0')
if sequence <= last then return sequence end
redis.call('XADD', KEYS[2], tostring(sequence) .. '-0', 'event', ARGV[1])
redis.call('XADD', KEYS[3], '*', 'event', ARGV[1])
redis.call('SET', KEYS[1], tostring(sequence), 'PX', ARGV[2])
redis.call('SET', KEYS[4], tostring(sequence), 'PX', ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[3], ARGV[2])
return sequence
`;

@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(OutboxRelayService.name);
    private readonly queue = new Queue(GENERATION_QUEUE_NAME, { connection: { url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' } });
    private readonly redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
    private readonly prefix = process.env.EVENT_KEY_PREFIX || 'gist-agent';
    private readonly retentionMs = 24 * 60 * 60 * 1000;
    private timer?: NodeJS.Timeout;
    private running = false;
    private stopping = false;
    constructor(private readonly db: DatabaseService) {}

    onApplicationBootstrap() {
        if (process.env.PROCESS_ROLE === 'worker') return;
        this.timer = setInterval(() => void this.dispatch(), 250);
        this.timer.unref();
        void this.dispatch();
    }
    async dispatch() {
        if (this.running || this.stopping) return;
        this.running = true;
        let delivered = 0;
        try {
            const lockToken = randomUUID();
            const rows = await this.db.query<QueryRow[]>(
                `WITH candidates AS (
                SELECT candidate.id FROM outbox_event candidate
                WHERE published_at IS NULL AND dead_lettered_at IS NULL AND next_attempt_at<=NOW()
                  AND (candidate.type <> 'generation.event' OR NOT EXISTS (
                    SELECT 1 FROM outbox_event prior WHERE prior.aggregate_id=candidate.aggregate_id AND prior.type='generation.event'
                      AND prior.published_at IS NULL AND prior.dead_lettered_at IS NULL
                      AND (prior.payload->>'sequence')::bigint < (candidate.payload->>'sequence')::bigint
                  ))
                  AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '30 seconds')
                ORDER BY candidate.created_at FOR UPDATE OF candidate SKIP LOCKED LIMIT 20
            ) UPDATE outbox_event event SET locked_at=NOW(),lock_token=?
              FROM candidates WHERE event.id=candidates.id
              RETURNING event.id,event.aggregate_id,event.type,event.payload,event.attempts`,
                [lockToken]
            );
            for (const row of rows) {
                try {
                    let sequence: number | null = null;
                    if (row.type === 'generation.enqueue') {
                        const payload = parseGenerationJob(row.payload);
                        if (payload.generationId !== row.aggregate_id) throw new Error('INVALID_PAYLOAD');
                        await this.queue.add('generate', payload, {
                            jobId: row.aggregate_id,
                            attempts: 5,
                            backoff: { type: 'exponential', delay: 500 },
                            removeOnComplete: 1000,
                            removeOnFail: 1000,
                        });
                    } else if (row.type === 'generation.event') {
                        await this.publishEvent(row.id, row.aggregate_id, row.payload);
                    } else if (row.type === 'generation.terminal') {
                        const payload = parseGenerationTerminalOutboxPayload(row.payload);
                        if (payload.generationId !== row.aggregate_id) throw new Error('INVALID_PAYLOAD');
                        sequence = await this.publishTerminal(row.id, payload);
                    } else {
                        throw new Error('INVALID_EVENT_TYPE');
                    }
                    await this.db.withTransaction(async (transaction) => {
                        if (sequence !== null)
                            await transaction.execute('UPDATE generation SET last_sequence=?,updated_at=NOW() WHERE id=? AND last_sequence < ?', [
                                sequence,
                                row.aggregate_id,
                                sequence,
                            ]);
                        await transaction.execute(
                            'UPDATE outbox_event SET published_at=NOW(),attempts=attempts+1,last_error=NULL,locked_at=NULL,lock_token=NULL WHERE id=? AND lock_token=? AND published_at IS NULL',
                            [row.id, lockToken]
                        );
                    });
                    delivered++;
                } catch (error) {
                    const attempts = Number(row.attempts) + 1;
                    const deadLetter = error instanceof Error && error.message.startsWith('INVALID_');
                    await this.db.execute(
                        "UPDATE outbox_event SET attempts=?,last_error=?,next_attempt_at=NOW()+(? * INTERVAL '1 millisecond'),locked_at=NULL,lock_token=NULL,dead_lettered_at=CASE WHEN ? THEN NOW() ELSE dead_lettered_at END WHERE id=? AND lock_token=?",
                        [attempts, error instanceof Error ? error.message.slice(0, 500) : 'UNKNOWN', Math.min(60000, 500 * 2 ** attempts), deadLetter, row.id, lockToken]
                    );
                }
            }
        } catch (error) {
            this.logger.warn(`Outbox relay unavailable: ${error instanceof Error ? error.message : error}`);
        } finally {
            this.running = false;
            if (delivered && !this.stopping) setImmediate(() => void this.dispatch());
        }
    }

    private async publishEvent(eventId: string, generationId: string, payload: any): Promise<void> {
        if (
            payload?.version !== 1 ||
            payload.kind !== 'generation.event' ||
            payload.generationId !== generationId ||
            !Number.isSafeInteger(payload.userId) ||
            !Number.isSafeInteger(payload.sequence) ||
            payload.sequence < 1 ||
            payload.event?.eventId !== eventId ||
            payload.event?.sequence !== payload.sequence ||
            typeof payload.event?.type !== 'string'
        ) {
            throw new Error('INVALID_EVENT_PAYLOAD');
        }
        const rows = await this.db.query('SELECT 1 FROM generation WHERE id=? AND user_id=?', [generationId, payload.userId]);
        if (!rows.length) return;
        const ns = `${this.prefix}:{${payload.userId}}`;
        await this.redis.eval(
            PUBLISH_EVENT_SCRIPT,
            4,
            `${ns}:gen:${generationId}:seq`,
            `${ns}:gen:${generationId}`,
            `${ns}:user`,
            `${ns}:event-dedupe:${eventId}`,
            JSON.stringify(payload.event),
            String(this.retentionMs),
            String(payload.sequence)
        );
    }

    private async publishTerminal(eventId: string, payload: ReturnType<typeof parseGenerationTerminalOutboxPayload>): Promise<number> {
        const namespace = `${this.prefix}:{${payload.userId}}`;
        const event = {
            ...payload.event,
            eventId,
            streamId: '0-0',
            generationId: payload.generationId,
            conversationId: payload.conversationId,
            messageId: payload.messageId,
            sequence: undefined, // Assigned atomically by Lua without re-encoding the body.
            occurredAt: new Date().toISOString(),
        };
        return Number(
            await this.redis.eval(
                PUBLISH_TERMINAL_SCRIPT,
                4,
                `${namespace}:gen:${payload.generationId}:seq`,
                `${namespace}:gen:${payload.generationId}`,
                `${namespace}:user`,
                `${namespace}:event-dedupe:${eventId}`,
                JSON.stringify(event),
                String(this.retentionMs)
            )
        );
    }

    async onApplicationShutdown() {
        this.stopping = true;
        if (this.timer) clearInterval(this.timer);
        await this.queue.close();
        if (this.redis.status === 'ready') await this.redis.quit();
        else this.redis.disconnect();
    }
}
