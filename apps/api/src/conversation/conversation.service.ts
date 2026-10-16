import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { v4 as uuidv4 } from 'uuid';
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
    generation_id?: string;
    generation_status?: string;
    generation_sequence?: number;
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
        const id = uuidv4();
        await this.db.execute('INSERT INTO conversation (id, user_id, title) VALUES (?, ?, ?)', [id, userId, title]);
        return (await this.findOne(id, userId))!;
    }

    async updateTitle(id: string, title: string, datasourceId: number | null = null): Promise<void> {
        await this.db.execute('UPDATE conversation SET title = ?, datasource_id = ? WHERE id = ?', [title, datasourceId, id]);
    }

    async remove(id: string, userId: number): Promise<void> {
        const conv = await this.findOne(id, userId);
        if (!conv) throw new NotFoundException('对话不存在或无权删除');

        await this.db.withTransaction(async (tx) => {
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [id]);
            await tx.query('SELECT id FROM generation WHERE conversation_id=? AND user_id=? FOR UPDATE', [id, userId]);
            await tx.execute('DELETE FROM outbox_event WHERE aggregate_id IN (SELECT id FROM generation WHERE conversation_id=? AND user_id=?)', [id, userId]);
            await tx.execute('DELETE FROM conversation WHERE id=? AND user_id=?', [id, userId]);
        });
    }

    async getMessages(conversationId: string, userId: number): Promise<Message[]> {
        const conv = await this.findOne(conversationId, userId);
        if (!conv) return [];

        const rows = await this.db.query<QueryRow[]>(
            `SELECT m.*,g.id AS generation_id,g.status AS generation_status,g.last_sequence AS generation_sequence
               FROM message m
               LEFT JOIN generation g ON g.response_message_id=m.id
              WHERE m.conversation_id=?
              ORDER BY m.created_at ASC,CASE WHEN m.role='user' THEN 0 ELSE 1 END,m.id ASC`,
            [conversationId]
        );

        return rows as unknown as Message[];
    }
}
