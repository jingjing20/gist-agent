import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { randomUUID } from 'crypto';
import { QueryRow } from '../database/database.service';

export interface Conversation {
    id: string;
    title: string;
    datasource_id: number | null;
    created_at: string;
    updated_at: string;
}

export interface Message {
    id: string;
    conversation_id: string;
    role: 'user' | 'assistant';
    content: string;
    blocks: unknown[];
    llm_messages: unknown[];
    created_at: string;
}

export interface QueryArtifactSummary {
    id: string;
    title: string;
    purpose: string;
    expectedGrain: string;
    expectedShape: string;
    columns: Array<{ name: string; type: string }>;
    returnedRowCount: number;
    totalRowCount?: number;
    isLimited: boolean;
}

export interface ConversationTurnContext {
    id: string;
    sequence: number;
    generationId: string;
    status: 'pending' | 'completed';
    finalAnswer: string | null;
    userMessage: Message;
    assistantMessage?: Message;
    artifacts: QueryArtifactSummary[];
}

@Injectable()
export class ConversationService {
    constructor(private readonly db: DatabaseService) {}

    async findAll(userId: number): Promise<Conversation[]> {
        const rows = await this.db.query<QueryRow[]>('SELECT * FROM conversation WHERE user_id = ? ORDER BY updated_at DESC', [userId]);
        return rows as unknown as Conversation[];
    }

    async findOne(id: string, userId: number): Promise<Conversation | null> {
        const rows = await this.db.query<QueryRow[]>('SELECT * FROM conversation WHERE id = ? AND user_id = ?', [id, userId]);
        return (rows[0] as unknown as Conversation) || null;
    }

    async create(userId: number, title = '新对话'): Promise<Conversation> {
        const id = randomUUID();
        await this.db.execute('INSERT INTO conversation (id, user_id, title) VALUES (?, ?, ?)', [id, userId, title]);
        return (await this.findOne(id, userId))!;
    }

    async updateTitle(id: string, title: string, datasourceId: number | null = null): Promise<void> {
        await this.db.execute('UPDATE conversation SET title = ?, datasource_id = ? WHERE id = ?', [title, datasourceId, id]);
    }

    async remove(id: string, userId: number): Promise<void> {
        const conv = await this.findOne(id, userId);
        if (!conv) throw new NotFoundException('对话不存在或无权删除');

        // message_block -> message -> conversation 均有 ON DELETE CASCADE，
        // 删除 conversation 会自动级联清理关联的 message 和 message_block
        await this.db.execute('DELETE FROM conversation WHERE id = ?', [id]);
    }

    async getMessages(conversationId: string, userId: number): Promise<Message[]> {
        const conv = await this.findOne(conversationId, userId);
        if (!conv) return [];

        const rows = await this.db.query<QueryRow[]>("SELECT * FROM message WHERE conversation_id = ? ORDER BY created_at ASC, CASE WHEN role='user' THEN 0 ELSE 1 END, id ASC", [
            conversationId,
        ]);

        if (rows.length === 0) return [];

        const messageIds = rows.map((r) => r.id);
        const placeholders = messageIds.map(() => '?').join(', ');
        const blockRows = await this.db.query<QueryRow[]>(`SELECT * FROM message_block WHERE message_id IN (${placeholders}) ORDER BY message_id, sort_order`, messageIds);

        const blocksByMessageId = new Map<string, any[]>();
        for (const row of blockRows) {
            if (!blocksByMessageId.has(row.message_id)) {
                blocksByMessageId.set(row.message_id, []);
            }
            const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {};
            blocksByMessageId.get(row.message_id)!.push({
                type: row.type,
                ...(row.content != null ? { content: row.content } : {}),
                ...metadata,
            });
        }

        return rows.map((row) => {
            const blocksFromTable = blocksByMessageId.get(row.id);
            const blocksFromJson = typeof row.blocks === 'string' ? JSON.parse(row.blocks) : row.blocks || [];
            const blocks = blocksFromTable && blocksFromTable.length > 0 ? blocksFromTable : blocksFromJson;

            return {
                ...row,
                blocks,
                llm_messages: typeof row.llm_messages === 'string' ? JSON.parse(row.llm_messages) : row.llm_messages || [],
            };
        }) as unknown as Message[];
    }

    async getGenerationContextMessages(conversationId: string, userId: number, contextUpperBound: string, requestMessageId: string): Promise<Message[]> {
        const conv = await this.findOne(conversationId, userId);
        if (!conv) return [];
        const rows = await this.db.query<QueryRow[]>(
            `SELECT m.*
               FROM message m
              WHERE m.conversation_id=?
                AND (
                  m.id=?
                  OR (
                    m.created_at < ?
                    AND EXISTS (
                      SELECT 1 FROM generation g
                       WHERE g.conversation_id=m.conversation_id
                         AND g.status='completed'
                         AND (g.request_message_id=m.id OR g.response_message_id=m.id)
                    )
                  )
                )
              ORDER BY m.created_at ASC, CASE WHEN m.role='user' THEN 0 ELSE 1 END, m.id ASC`,
            [conversationId, requestMessageId, contextUpperBound]
        );
        return this.hydrateMessages(rows);
    }

    async getGenerationContextTurns(conversationId: string, userId: number, contextUpperBound: string, requestMessageId: string): Promise<ConversationTurnContext[]> {
        const rows = await this.db.query<QueryRow[]>(
            `SELECT ct.id,ct.sequence,ct.generation_id,ct.status,ct.final_answer,ct.user_message_id,ct.assistant_message_id
               FROM conversation_turn ct
               JOIN conversation c ON c.id=ct.conversation_id AND c.user_id=?
              WHERE ct.conversation_id=?
                AND (
                  ct.user_message_id=?
                  OR (ct.status='completed' AND ct.created_at < ?)
                )
              ORDER BY ct.sequence`,
            [userId, conversationId, requestMessageId, contextUpperBound]
        );
        if (!rows.length) return [];
        const messageIds = rows.flatMap((row) => [row.user_message_id, row.assistant_message_id]);
        const placeholders = messageIds.map(() => '?').join(',');
        const messages = await this.hydrateMessages(await this.db.query<QueryRow[]>(`SELECT * FROM message WHERE id IN (${placeholders})`, messageIds));
        const messageById = new Map(messages.map((message) => [message.id, message]));
        const generationIds = rows.map((row) => row.generation_id);
        const artifactPlaceholders = generationIds.map(() => '?').join(',');
        const artifactRows = await this.db.query<QueryRow[]>(
            `SELECT id,generation_id,title,purpose,expected_grain,expected_shape,columns_json,
                    returned_row_count,total_row_count,is_limited
               FROM query_artifact
              WHERE generation_id IN (${artifactPlaceholders})
              ORDER BY created_at,id`,
            generationIds
        );
        const artifactsByGeneration = new Map<string, QueryArtifactSummary[]>();
        for (const artifact of artifactRows) {
            const list = artifactsByGeneration.get(artifact.generation_id) ?? [];
            list.push({
                id: artifact.id,
                title: artifact.title,
                purpose: artifact.purpose,
                expectedGrain: artifact.expected_grain,
                expectedShape: artifact.expected_shape,
                columns: typeof artifact.columns_json === 'string' ? JSON.parse(artifact.columns_json) : artifact.columns_json,
                returnedRowCount: Number(artifact.returned_row_count),
                ...(artifact.total_row_count == null ? {} : { totalRowCount: Number(artifact.total_row_count) }),
                isLimited: artifact.is_limited === true,
            });
            artifactsByGeneration.set(artifact.generation_id, list);
        }
        return rows.flatMap((row) => {
            const userMessage = messageById.get(row.user_message_id);
            if (!userMessage) return [];
            const assistantMessage = messageById.get(row.assistant_message_id);
            return [
                {
                    id: row.id,
                    sequence: Number(row.sequence),
                    generationId: row.generation_id,
                    status: row.status,
                    finalAnswer: row.final_answer,
                    userMessage,
                    ...(row.status === 'completed' && assistantMessage ? { assistantMessage } : {}),
                    artifacts: artifactsByGeneration.get(row.generation_id) ?? [],
                } as ConversationTurnContext,
            ];
        });
    }

    async getMessage(id: string, conversationId: string, userId: number): Promise<Message | null> {
        const conv = await this.findOne(conversationId, userId);
        if (!conv) return null;
        const rows = await this.db.query<QueryRow[]>('SELECT * FROM message WHERE id=? AND conversation_id=?', [id, conversationId]);
        return (await this.hydrateMessages(rows))[0] ?? null;
    }

    private async hydrateMessages(rows: QueryRow[]): Promise<Message[]> {
        if (rows.length === 0) return [];
        const messageIds = rows.map((row) => row.id);
        const placeholders = messageIds.map(() => '?').join(', ');
        const blockRows = await this.db.query<QueryRow[]>(`SELECT * FROM message_block WHERE message_id IN (${placeholders}) ORDER BY message_id, sort_order`, messageIds);
        const blocksByMessageId = new Map<string, any[]>();
        for (const row of blockRows) {
            const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {};
            const blocks = blocksByMessageId.get(row.message_id) ?? [];
            blocks.push({ type: row.type, ...(row.content != null ? { content: row.content } : {}), ...metadata });
            blocksByMessageId.set(row.message_id, blocks);
        }
        return rows.map((row) => ({
            ...row,
            blocks: blocksByMessageId.get(row.id) ?? (typeof row.blocks === 'string' ? JSON.parse(row.blocks) : row.blocks || []),
            llm_messages: typeof row.llm_messages === 'string' ? JSON.parse(row.llm_messages) : row.llm_messages || [],
        })) as unknown as Message[];
    }

    async addMessage(conversationId: string, role: 'user' | 'assistant', content: string, blocks: unknown[], llmMessages: unknown[] = [], messageId?: string): Promise<Message> {
        const id = messageId ?? randomUUID();

        await this.db.withTransaction(async (conn) => {
            await conn.execute('INSERT INTO message (id, conversation_id, role, content, blocks, llm_messages) VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb)', [
                id,
                conversationId,
                role,
                content,
                JSON.stringify(blocks),
                JSON.stringify(llmMessages),
            ]);

            const blockValues: unknown[] = [];
            const blockPlaceholders: string[] = [];

            for (let i = 0; i < blocks.length; i++) {
                const block = blocks[i] as any;
                const blockId = randomUUID();
                const { type, content: blockContent, ...rest } = block;
                const hasMetadata = Object.keys(rest).length > 0;

                const metadataStr = hasMetadata ? JSON.stringify(rest) : null;
                blockValues.push(blockId, id, i, type, blockContent ?? null, metadataStr);
                blockPlaceholders.push('(?, ?, ?, ?, ?, ?)');
            }

            if (blockPlaceholders.length > 0) {
                const sql = `INSERT INTO message_block (id, message_id, sort_order, type, content, metadata) VALUES ${blockPlaceholders.join(', ')}`;
                await conn.execute(sql, blockValues as any);
            }

            await conn.execute('UPDATE conversation SET updated_at = NOW() WHERE id = ?', [conversationId]);
        });

        return {
            id,
            conversation_id: conversationId,
            role,
            content,
            blocks,
            llm_messages: llmMessages,
            created_at: new Date().toISOString(),
        };
    }

    async updateMessage(id: string, content: string, blocks: unknown[], llmMessages: unknown[] = []): Promise<void> {
        await this.db.execute('UPDATE message SET content = ?, blocks = ?::jsonb, llm_messages = ?::jsonb WHERE id = ?', [
            content,
            JSON.stringify(blocks),
            JSON.stringify(llmMessages),
            id,
        ]);
    }
}
