import { Injectable, OnModuleInit, NotFoundException } from '@nestjs/common';
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
	llm_messages: unknown[];
	created_at: string;
}

@Injectable()
export class ConversationService implements OnModuleInit {
	constructor(private readonly db: DatabaseService) {}

	async onModuleInit() {
		await this.ensureTables();
	}

	private async ensureTables() {
		await this.db.query(`
			CREATE TABLE IF NOT EXISTS conversation (
				id VARCHAR(36) PRIMARY KEY,
				user_id INT NULL COMMENT 'NULL=迁移遗留，不展示',
				title VARCHAR(200) NOT NULL DEFAULT '新对话',
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
				FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
			)
		` as any);

		try {
			const [cols] = await this.db.query<any[]>(
				"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conversation' AND COLUMN_NAME = 'user_id'",
			);
			if (!cols?.length) {
				await this.db.execute('ALTER TABLE conversation ADD COLUMN user_id INT NULL AFTER id');
			}
		} catch { /* ignore */ }

		await this.db.query(`
			CREATE TABLE IF NOT EXISTS message (
				id VARCHAR(36) PRIMARY KEY,
				conversation_id VARCHAR(36) NOT NULL,
				role ENUM('user', 'assistant') NOT NULL,
				content TEXT,
				blocks JSON,
				llm_messages JSON,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (conversation_id) REFERENCES conversation(id) ON DELETE CASCADE,
				INDEX idx_conv_time (conversation_id, created_at)
			)
		` as any);

		try {
			const [cols] = await this.db.query<any[]>(
				"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message' AND COLUMN_NAME = 'llm_messages'",
			);
			if (!cols?.length) {
				await this.db.execute('ALTER TABLE message ADD COLUMN llm_messages JSON NULL AFTER blocks');
			}
		} catch { /* ignore */ }

		try {
			const [indexes] = await this.db.query<any[]>(
				"SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message' AND INDEX_NAME = 'idx_conv_time'",
			);
			if (!indexes?.length) {
				await this.db.execute('ALTER TABLE message ADD INDEX idx_conv_time (conversation_id, created_at)');
			}
		} catch { /* ignore */ }

		await this.db.query(`
			CREATE TABLE IF NOT EXISTS message_block (
				id VARCHAR(36) PRIMARY KEY,
				message_id VARCHAR(36) NOT NULL,
				sort_order INT NOT NULL,
				type VARCHAR(30) NOT NULL,
				content TEXT,
				metadata JSON,
				FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE,
				INDEX idx_message_blocks (message_id, sort_order)
			)
		` as any);
	}

	async findAll(userId: number): Promise<Conversation[]> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT * FROM conversation WHERE user_id = ? ORDER BY updated_at DESC',
			[userId],
		);
		return rows as unknown as Conversation[];
	}

	async findOne(id: string, userId: number): Promise<Conversation | null> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT * FROM conversation WHERE id = ? AND user_id = ?',
			[id, userId],
		);
		return (rows[0] as unknown as Conversation) || null;
	}

	async create(userId: number, title = '新对话'): Promise<Conversation> {
		const id = uuidv4();
		await this.db.execute(
			'INSERT INTO conversation (id, user_id, title) VALUES (?, ?, ?)',
			[id, userId, title],
		);
		return (await this.findOne(id, userId))!;
	}

	async updateTitle(id: string, title: string): Promise<void> {
		await this.db.execute(
			'UPDATE conversation SET title = ? WHERE id = ?',
			[title, id],
		);
	}

	async remove(id: string, userId: number): Promise<void> {
		const conv = await this.findOne(id, userId);
		if (!conv) throw new NotFoundException('对话不存在或无权删除');

		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT id FROM message WHERE conversation_id = ?',
			[id],
		);
		const messageIds = rows.map((r) => r.id);
		if (messageIds.length > 0) {
			const placeholders = messageIds.map(() => '?').join(', ');
			await this.db.execute(`DELETE FROM message_block WHERE message_id IN (${placeholders})`, messageIds);
			await this.db.execute('DELETE FROM message WHERE conversation_id = ?', [id]);
		}
		await this.db.execute('DELETE FROM conversation WHERE id = ?', [id]);
	}

	async getMessages(conversationId: string, userId: number): Promise<Message[]> {
		const conv = await this.findOne(conversationId, userId);
		if (!conv) return [];

		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT * FROM message WHERE conversation_id = ? ORDER BY created_at ASC',
			[conversationId],
		);

		if (rows.length === 0) return [];

		const messageIds = rows.map((r) => r.id);
		const placeholders = messageIds.map(() => '?').join(', ');
		const blockRows = await this.db.query<RowDataPacket[]>(
			`SELECT * FROM message_block WHERE message_id IN (${placeholders}) ORDER BY message_id, sort_order`,
			messageIds,
		);

		const blocksByMessageId = new Map<string, any[]>();
		for (const row of blockRows) {
			if (!blocksByMessageId.has(row.message_id)) {
				blocksByMessageId.set(row.message_id, []);
			}
			const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
			blocksByMessageId.get(row.message_id)!.push({
				type: row.type,
				...(row.content != null ? { content: row.content } : {}),
				...metadata,
			});
		}

		return rows.map((row) => {
			const blocksFromTable = blocksByMessageId.get(row.id);
			const blocksFromJson = typeof row.blocks === 'string' ? JSON.parse(row.blocks) : (row.blocks || []);
			const blocks = blocksFromTable && blocksFromTable.length > 0 ? blocksFromTable : blocksFromJson;

			return {
				...row,
				blocks,
				llm_messages: typeof row.llm_messages === 'string' ? JSON.parse(row.llm_messages) : (row.llm_messages || []),
			};
		}) as unknown as Message[];
	}

	async addMessage(
		conversationId: string,
		role: 'user' | 'assistant',
		content: string,
		blocks: unknown[],
		llmMessages: unknown[] = [],
	): Promise<Message> {
		const id = uuidv4();
		await this.db.execute(
			'INSERT INTO message (id, conversation_id, role, content, llm_messages) VALUES (?, ?, ?, ?, ?)',
			[id, conversationId, role, content, JSON.stringify(llmMessages)],
		);

		const blockValues: unknown[] = [];
		const blockPlaceholders: string[] = [];

		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i] as any;
			const blockId = uuidv4();
			const { type, content: blockContent, ...rest } = block;
			const hasMetadata = Object.keys(rest).length > 0;
			
			const metadataStr = hasMetadata ? JSON.stringify(rest) : null;
			blockValues.push(blockId, id, i, type, blockContent ?? null, metadataStr);
			blockPlaceholders.push('(?, ?, ?, ?, ?, ?)');
		}

		if (blockPlaceholders.length > 0) {
			const sql = `INSERT INTO message_block (id, message_id, sort_order, type, content, metadata) VALUES ${blockPlaceholders.join(', ')}`;
			await this.db.execute(sql, blockValues);
		}

		await this.db.execute(
			'UPDATE conversation SET updated_at = NOW() WHERE id = ?',
			[conversationId],
		);

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
}
