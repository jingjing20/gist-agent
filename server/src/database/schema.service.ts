import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Injectable()
export class SchemaService {
	constructor(private readonly db: DatabaseService) { }

	/**
	 * Retrieves tables and their columns from information_schema dynamically
	 * Returns a markdown formatted string to be used as LLM prompt context
	 */
	async getDatabaseSchemaPrompt(): Promise<string> {
		const dbName = process.env.DB_NAME || 'ai_analysis';

		// Exclude our system tables, currently just conversation and message
		// If you want full exposure, just remove the WHERE clause condition
		const sql = `
			SELECT
				c.TABLE_NAME,
				t.TABLE_COMMENT,
				c.COLUMN_NAME,
				c.COLUMN_TYPE,
				c.COLUMN_COMMENT
			FROM information_schema.COLUMNS c
			JOIN information_schema.TABLES t
			  ON c.TABLE_NAME = t.TABLE_NAME AND c.TABLE_SCHEMA = t.TABLE_SCHEMA
			WHERE c.TABLE_SCHEMA = ?
			  AND c.TABLE_NAME NOT IN ('conversation', 'message')
			ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
		`;

		const rows = await this.db.query<any[]>(sql, [dbName]);

		if (!rows || rows.length === 0) {
			return '当前数据库中没有可用的业务表。';
		}

		// Group columns by table
		const tablesMap = new Map<string, { comment: string; columns: string[] }>();

		for (const row of rows) {
			const tableName = row.TABLE_NAME;
			if (!tablesMap.has(tableName)) {
				tablesMap.set(tableName, {
					comment: row.TABLE_COMMENT || '',
					columns: [],
				});
			}
			const tableInfo = tablesMap.get(tableName)!;
			const colDef = `  ${row.COLUMN_NAME} ${row.COLUMN_TYPE} -- ${row.COLUMN_COMMENT || ''}`;
			tableInfo.columns.push(colDef);
		}

		// Format into markdown
		const promptLines: string[] = [];
		for (const [tableName, info] of tablesMap.entries()) {
			promptLines.push(`表名: ${tableName}`);
			promptLines.push(`说明: ${info.comment}`);
			promptLines.push(`字段:\n${info.columns.join('\n')}`);
			promptLines.push(''); // blank line between tables
		}

		return promptLines.join('\n').trim();
	}
}
