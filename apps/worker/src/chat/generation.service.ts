import { promoteAnalysisDraft, enqueueGenerationEvent } from '@gist/database';
import { Injectable } from '@nestjs/common';
import type { GenerationErrorCode, GenerationStatus } from '@gist/contracts';
import { randomUUID } from 'crypto';
import type OpenAI from 'openai';
import { DatabaseService, type QueryRow } from '../database/database.service';
import type { SSEEvent, SSEEmitter } from './tools/base-tool';
import { GenerationExecutionError } from './generation-errors';
import { TextEventBuffer } from './text-event-buffer';

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
    schemaContextVersion: string;
    promptPolicyVersion?: string;
    writerToken: string;
}

export interface GenerationExecutionMetrics {
    llmCallCount: number;
    toolCallCount: number;
    sqlCallCount: number;
    inputTokensEstimated: number;
    outputTokensEstimated: number;
}

/** Worker 独占的 generation 写入仓库与 Redis 事件发布器。 */
@Injectable()
export class GenerationService {
    private readonly textBuffers = new Map<string, TextEventBuffer>();
    private readonly queues = new Map<string, Promise<void>>();

    constructor(private readonly db: DatabaseService) {}

    async candidate(id: string): Promise<(Omit<GenerationIdentity, 'writerToken'> & { status: GenerationStatus }) | null> {
        const rows = await this.db.query<QueryRow[]>(
            `SELECT id,user_id,status,conversation_id,request_message_id,response_message_id,reasoning_enabled,
                    datasource_id,context_upper_bound,parent_message_id,schema_context_version,prompt_policy_version
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
            schemaContextVersion: rows[0].schema_context_version,
            promptPolicyVersion: rows[0].prompt_policy_version,
        };
    }

    async claim(id: string, writerToken: string): Promise<GenerationIdentity | null> {
        const rows = await this.db.query<QueryRow[]>(
            `UPDATE generation g
      SET status='starting',writer_token=?,writer_heartbeat_at=NOW(),started_at=COALESCE(started_at,NOW()),updated_at=NOW()
      WHERE g.id=? AND g.status='pending' AND g.writer_token IS NULL
      RETURNING g.id,g.user_id,g.conversation_id,g.request_message_id,g.response_message_id,g.reasoning_enabled,
                g.datasource_id,g.context_upper_bound,g.parent_message_id,g.schema_context_version,g.prompt_policy_version`,
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
            schemaContextVersion: rows[0].schema_context_version,
            promptPolicyVersion: rows[0].prompt_policy_version,
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

    async recordExecutionMetrics(identity: GenerationIdentity, metrics: GenerationExecutionMetrics): Promise<void> {
        await this.db.execute(
            `INSERT INTO generation_metric (
                generation_id,llm_call_count,tool_call_count,sql_call_count,input_tokens_estimated,output_tokens_estimated
             ) VALUES (?,?,?,?,?,?)
             ON CONFLICT(generation_id) DO UPDATE SET
                llm_call_count=EXCLUDED.llm_call_count,
                tool_call_count=EXCLUDED.tool_call_count,
                sql_call_count=EXCLUDED.sql_call_count,
                input_tokens_estimated=EXCLUDED.input_tokens_estimated,
                output_tokens_estimated=EXCLUDED.output_tokens_estimated,
                updated_at=NOW()`,
            [identity.id, metrics.llmCallCount, metrics.toolCallCount, metrics.sqlCallCount, metrics.inputTokensEstimated, metrics.outputTokensEstimated]
        );
    }

    async recordSpan(identity: GenerationIdentity, name: string, startedAt: number, status: 'ok' | 'error', metadata: Record<string, unknown> = {}): Promise<void> {
        await this.db.execute(
            `INSERT INTO generation_trace_span(generation_id,name,status,duration_ms,metadata)
             VALUES (?,?,?,?,?::jsonb)`,
            [identity.id, name, status, Math.max(0, Date.now() - startedAt), JSON.stringify(metadata)]
        );
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
        let buffer = this.textBuffers.get(identity.id);
        if (!buffer) {
            buffer = new TextEventBuffer((event) => {
                const prior = this.queues.get(identity.id) ?? Promise.resolve();
                const next = prior.then(() => this.publish(identity, event));
                // drain remains the error boundary, including while tokens arrive.
                void next.catch(() => undefined);
                this.queues.set(identity.id, next);
            });
            this.textBuffers.set(identity.id, buffer);
        }
        return { send: (event) => buffer.send(event) };
    }

    async drain(identity: GenerationIdentity): Promise<void> {
        this.textBuffers.get(identity.id)?.flush();
        this.textBuffers.delete(identity.id);
        try {
            await (this.queues.get(identity.id) ?? Promise.resolve());
        } finally {
            this.queues.delete(identity.id);
        }
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
                    (?<>'' AND writer_token=? AND status IN ('starting','running','cancel_requested') AND (?<>'completed' OR status<>'cancel_requested'))
                    OR (?='' AND writer_token IS NULL AND status='cancel_requested')
                  )`,
                [status, error ?? null, errorCode ?? null, identity.id, identity.writerToken, identity.writerToken, status, identity.writerToken]
            );
            if (updated.rowCount !== 1) return false;
            if (status === 'completed') await promoteAnalysisDraft(transaction, identity.id);
            const finalAnswer = status === 'completed' && messageState ? extractFinalAnswer(messageState.blocks) : null;
            if (messageState) {
                await transaction.execute('UPDATE message SET content=?,blocks=?::jsonb,llm_messages=?::jsonb WHERE id=?', [
                    finalAnswer ?? '',
                    JSON.stringify(messageState.blocks),
                    JSON.stringify(messageState.llmMessages),
                    identity.messageId,
                ]);
            }
            await transaction.execute(
                `UPDATE conversation_turn
                    SET status=?,final_answer=?,completed_at=NOW()
                  WHERE generation_id=? AND status='pending'`,
                [status, finalAnswer, identity.id]
            );
            await transaction.execute('UPDATE generation_attempt SET status=?,error=?,completed_at=NOW() WHERE generation_id=? AND completed_at IS NULL', [
                status,
                error ?? null,
                identity.id,
            ]);
            await enqueueGenerationEvent(transaction, identity, terminal);
            return true;
        });
    }

    async failQueued(id: string, error: string): Promise<void> {
        await this.db.withTransaction(async (tx) => {
            const [updated] = await tx.execute(
                `UPDATE generation SET status='failed',error=?,error_code='GENERATION_CAPACITY_UNAVAILABLE',completed_at=NOW(),updated_at=NOW()
                WHERE id=? AND status='pending' AND writer_token IS NULL RETURNING id,user_id,conversation_id,response_message_id`,
                [error, id]
            );
            for (const row of updated.rows) {
                await tx.execute("UPDATE conversation_turn SET status='failed',completed_at=NOW() WHERE generation_id=? AND status='pending'", [row.id]);
                await enqueueGenerationEvent(
                    tx,
                    { id: row.id, userId: row.user_id, conversationId: row.conversation_id, messageId: row.response_message_id },
                    { type: 'done', status: 'failed', error, errorCode: 'GENERATION_CAPACITY_UNAVAILABLE' }
                );
            }
        });
    }

    async failStale(timeoutMs: number): Promise<number> {
        const pendingTimeoutMs = Math.max(timeoutMs, Number(process.env.GENERATION_PENDING_TIMEOUT_MS) || 600_000);
        return this.db.withTransaction(async (tx) => {
            const [updated] = await tx.execute(
                `UPDATE generation SET
                status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE 'failed' END,
                error=CASE WHEN status='cancel_requested' THEN '已取消' ELSE '生成进程意外中断或排队超时，已保留收到的部分内容' END,
                error_code=CASE WHEN status='cancel_requested' THEN 'CANCELLED' ELSE 'WORKER_LOST' END,
                completed_at=NOW(),updated_at=NOW(),writer_token=NULL
                WHERE (status IN ('starting','running','cancel_requested') AND writer_token IS NOT NULL AND writer_heartbeat_at < NOW() - (? * INTERVAL '1 millisecond'))
                   OR (status='cancel_requested' AND writer_token IS NULL AND cancel_requested_at < NOW() - (? * INTERVAL '1 millisecond'))
                   OR (status='pending' AND writer_token IS NULL AND created_at < NOW() - (? * INTERVAL '1 millisecond'))
                RETURNING id,user_id,conversation_id,response_message_id,status,error,error_code`,
                [timeoutMs, timeoutMs, pendingTimeoutMs]
            );
            for (const row of updated.rows) {
                await tx.execute('UPDATE generation_attempt SET status=?,error=?,completed_at=NOW() WHERE generation_id=? AND completed_at IS NULL', [
                    row.status,
                    row.error_code,
                    row.id,
                ]);
                await tx.execute("UPDATE conversation_turn SET status=?,completed_at=NOW() WHERE generation_id=? AND status='pending'", [row.status, row.id]);
                await enqueueGenerationEvent(
                    tx,
                    { id: row.id, userId: row.user_id, conversationId: row.conversation_id, messageId: row.response_message_id },
                    { type: 'done', status: row.status, error: row.error, errorCode: row.error_code }
                );
            }
            return updated.rows.length;
        });
    }

    private async publish(identity: GenerationIdentity, event: SSEEvent): Promise<void> {
        await this.db.withTransaction(async (tx) => {
            const [owned] = await tx.query("SELECT 1 FROM generation WHERE id=? AND writer_token=? AND status IN ('starting','running') FOR UPDATE", [
                identity.id,
                identity.writerToken,
            ]);
            if (!owned.length) throw new GenerationExecutionError('WRITER_OWNERSHIP_LOST', '生成任务写入权已丢失');
            await enqueueGenerationEvent(tx, identity, event);
        });
    }
}

function extractFinalAnswer(blocks: SSEEvent[]): string | null {
    const content = blocks
        .filter((block) => block.type === 'text')
        .map((block) => String(block.content ?? ''))
        .join('')
        .trim();
    return content || null;
}
