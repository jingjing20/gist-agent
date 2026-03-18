import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SchemaService } from '../database/schema.service';
import { LlmService } from '../llm/llm.service';
import { RowDataPacket } from 'mysql2/promise';

@Injectable()
export class SuggestionService {
	constructor(
		private readonly db: DatabaseService,
		private readonly schema: SchemaService,
		private readonly llm: LlmService,
	) { }

	async getSuggestions(datasourceId: number, userId: number): Promise<string[]> {
		const cached = await this.getFromCache(datasourceId, userId);
		if (cached) return cached;
		return this.generateAndCache(datasourceId, userId);
	}

	triggerAsync(datasourceId: number, userId: number): void {
		this.generateAndCache(datasourceId, userId).catch(() => { });
	}

	invalidateAndRegenerate(datasourceId: number, userId: number): void {
		this.db.execute(
			'DELETE FROM datasource_suggestions WHERE datasource_id = ? AND user_id = ?',
			[datasourceId, userId],
		).then(() => {
			this.triggerAsync(datasourceId, userId);
		}).catch(() => { });
	}

	private async getFromCache(datasourceId: number, userId: number): Promise<string[] | null> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT questions FROM datasource_suggestions WHERE datasource_id = ? AND user_id = ?',
			[datasourceId, userId],
		);
		if (!rows.length) return null;
		const q = (rows[0] as any).questions;
		return typeof q === 'string' ? JSON.parse(q) : q;
	}

	private async generateAndCache(datasourceId: number, userId: number): Promise<string[]> {
		const schemaPrompt = await this.schema.getDatabaseSchemaPrompt(datasourceId, userId);
		const questions = await this.callLlm(schemaPrompt);
		await this.db.execute(
			`INSERT INTO datasource_suggestions (datasource_id, user_id, questions) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE questions = VALUES(questions), created_at = CURRENT_TIMESTAMP`,
			[datasourceId, userId, JSON.stringify(questions)],
		);
		return questions;
	}

	private async callLlm(schemaPrompt: string): Promise<string[]> {
		const system = `你是一个数据分析专家。根据给定的数据库 schema，生成 3 个用户可能会问的数据分析问题。
要求：
- 问题要具体，涉及真实的表名和字段语义
- 问题要有分析价值，体现数据洞察
- 只返回 JSON 数组，格式：["问题1", "问题2", "问题3"]
- 不要有任何其他文字`;
		const user = `数据库 Schema:\n${schemaPrompt}`;
		const raw = await this.llm.chat(system, user, 0.3);
		const match = raw.match(/\[[\s\S]*\]/);
		if (!match) throw new Error('LLM returned invalid JSON for suggestions');
		const parsed = JSON.parse(match[0]);
		if (!Array.isArray(parsed) || parsed.length < 1) throw new Error('LLM returned invalid array');
		return parsed.slice(0, 3);
	}
}
