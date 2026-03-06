import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { v4 as uuidv4 } from 'uuid';
import { RowDataPacket } from 'mysql2/promise';

export interface Conversation {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
}

export interface Message {
	id: string;
	conversation_id: string;
	role: 'user' | 'assistant';
	content: string;
	blocks: unknown[];
	created_at: string;
}

@Injectable()
export class ConversationService implements OnModuleInit {
	constructor(private readonly db: DatabaseService) { }

	async onModuleInit() {
		await this.ensureTables();
	}

	private async ensureTables() {
		await this.db.query(`
      CREATE TABLE IF NOT EXISTS conversation (
        id VARCHAR(36) PRIMARY KEY,
        title VARCHAR(200) NOT NULL DEFAULT '新对话',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    ` as any);

		await this.db.query(`
      CREATE TABLE IF NOT EXISTS message (
        id VARCHAR(36) PRIMARY KEY,
        conversation_id VARCHAR(36) NOT NULL,
        role ENUM('user', 'assistant') NOT NULL,
        content TEXT,
        blocks JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversation(id) ON DELETE CASCADE
      )
    ` as any);
	}

	async findAll(): Promise<Conversation[]> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT * FROM conversation ORDER BY updated_at DESC',
		);
		return rows as unknown as Conversation[];
	}

	async findOne(id: string): Promise<Conversation | null> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT * FROM conversation WHERE id = ?',
			[id],
		);
		return (rows[0] as unknown as Conversation) || null;
	}

	async create(title = '新对话'): Promise<Conversation> {
		const id = uuidv4();
		await this.db.execute(
			'INSERT INTO conversation (id, title) VALUES (?, ?)',
			[id, title],
		);
		return (await this.findOne(id))!;
	}

	async updateTitle(id: string, title: string): Promise<void> {
		await this.db.execute(
			'UPDATE conversation SET title = ? WHERE id = ?',
			[title, id],
		);
	}

	async remove(id: string): Promise<void> {
		await this.db.execute('DELETE FROM conversation WHERE id = ?', [id]);
	}

	async getMessages(conversationId: string): Promise<Message[]> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT * FROM message WHERE conversation_id = ? ORDER BY created_at ASC',
			[conversationId],
		);
		return rows.map((row) => ({
			...row,
			blocks: typeof row.blocks === 'string' ? JSON.parse(row.blocks) : (row.blocks || []),
		})) as unknown as Message[];
	}

	async addMessage(
		conversationId: string,
		role: 'user' | 'assistant',
		content: string,
		blocks: unknown[],
	): Promise<Message> {
		const id = uuidv4();
		await this.db.execute(
			'INSERT INTO message (id, conversation_id, role, content, blocks) VALUES (?, ?, ?, ?, ?)',
			[id, conversationId, role, content, JSON.stringify(blocks)],
		);

		// 更新对话的 updated_at
		await this.db.execute(
			'UPDATE conversation SET updated_at = NOW() WHERE id = ?',
			[conversationId],
		);

		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT * FROM message WHERE id = ?',
			[id],
		);
		const msg = rows[0];
		return {
			...msg,
			blocks: typeof msg.blocks === 'string' ? JSON.parse(msg.blocks) : (msg.blocks || []),
		} as unknown as Message;
	}
}
