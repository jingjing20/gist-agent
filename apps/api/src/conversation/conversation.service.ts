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

        await this.db.execute('DELETE FROM conversation WHERE id = ?', [id]);
    }

    async getMessages(conversationId: string, userId: number): Promise<Message[]> {
        const conv = await this.findOne(conversationId, userId);
        if (!conv) return [];

        const rows = await this.db.query<QueryRow[]>("SELECT * FROM message WHERE conversation_id = ? ORDER BY created_at ASC, CASE WHEN role='user' THEN 0 ELSE 1 END, id ASC", [
            conversationId,
        ]);

        return rows as unknown as Message[];
    }
}
