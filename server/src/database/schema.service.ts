import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { RowDataPacket } from 'mysql2/promise';

const PRESET_BUSINESS_TABLES = ['platform_info', 'daily_active_stats', 'user_behavior_log'];

interface SchemaCacheEntry {
	prompt: string;
	timestamp: number;
}

const CACHE_TTL_MS = 60 * 1000; // 1 分钟缓存

@Injectable()
export class SchemaService {
	private readonly cache = new Map<string, SchemaCacheEntry>();

	constructor(private readonly db: DatabaseService) { }

	async getDatabaseSchemaPrompt(datasourceId: number | null, userId: number): Promise<string> {
		const cacheKey = `${datasourceId || 'local'}_${userId}`;
		const cached = this.cache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
			return cached.prompt;
		}

		const isInternal = await this.isInternalDs(datasourceId);
		const uploadedTableNames = await this.getUserUploadedTableNames(datasourceId, userId);
		
		const allowedTables = isInternal 
			? [...PRESET_BUSINESS_TABLES, ...uploadedTableNames]
			: uploadedTableNames;

		if (allowedTables.length === 0) {
			return isInternal ? '当前数据库中没有可用的业务表。' : '当前数据源中还没有上传的表。';
		}

		const prompt = await this.fetchSchemaPromptFromLocal(allowedTables, uploadedTableNames);
		
		if (prompt) {
			this.cache.set(cacheKey, { prompt, timestamp: Date.now() });
		}
		return prompt;
	}

	clearUserCache(datasourceId: number | null, userId: number): void {
		const cacheKey = `${datasourceId || 'local'}_${userId}`;
		this.cache.delete(cacheKey);
	}

	async getAllowedTableNames(datasourceId: number | null, userId: number): Promise<string[]> {
		const isInternal = await this.isInternalDs(datasourceId);
		const uploadedTableNames = await this.getUserUploadedTableNames(datasourceId, userId);
		
		if (isInternal) {
			return [...PRESET_BUSINESS_TABLES, ...uploadedTableNames];
		}
		return uploadedTableNames;
	}

	private async isInternalDs(datasourceId: number | null): Promise<boolean> {
		if (!datasourceId) return true;
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT is_local FROM data_source WHERE id = ?',
			[datasourceId],
		);
		if (!rows.length) return true;
		return !!(rows[0] as any).is_local;
	}

	private async fetchSchemaPromptFromLocal(allowedTables: string[], uploadedTableNames: string[]): Promise<string> {
		const dbNameRows = await this.db.query<any[]>('SELECT DATABASE() AS db_name');
		const dbName = dbNameRows[0]?.db_name;
		if (!dbName) return '无法获取目标数据库名称。';

		const placeholders = allowedTables.map(() => '?').join(', ');
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
			  AND c.TABLE_NAME IN (${placeholders})
			ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
		`;

		const rows = await this.db.query<any[]>(sql, [dbName, ...allowedTables]);
		return this.formatSchemaRows(rows, uploadedTableNames);
	}

	async getStructuredSchema(datasourceId: number | null, userId: number): Promise<any[]> {
		const isInternal = await this.isInternalDs(datasourceId);
		const uploadedTableNames = await this.getUserUploadedTableNames(datasourceId, userId);
		
		const allowedTables = isInternal 
			? [...PRESET_BUSINESS_TABLES, ...uploadedTableNames]
			: uploadedTableNames;

		if (allowedTables.length === 0) return [];

		const dbNameRows = await this.db.query<any[]>('SELECT DATABASE() AS db_name');
		const dbName = dbNameRows[0]?.db_name;
		if (!dbName) return [];

		const placeholders = allowedTables.map(() => '?').join(', ');
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
			  AND c.TABLE_NAME IN (${placeholders})
			ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
		`;

		const rows = await this.db.query<any[]>(sql, [dbName, ...allowedTables]);
		const tablesMap = new Map<string, { tableName: string; display_name: string; isUploaded: boolean; fields: any[] }>();

		for (const row of rows) {
			const tableName = row.TABLE_NAME;
			if (!tablesMap.has(tableName)) {
				tablesMap.set(tableName, {
					tableName,
					display_name: row.TABLE_COMMENT || tableName,
					isUploaded: uploadedTableNames.includes(tableName),
					fields: [],
				});
			}
			const tableInfo = tablesMap.get(tableName)!;
			tableInfo.fields.push({
				name: row.COLUMN_NAME,
				type: row.COLUMN_TYPE,
				comment: row.COLUMN_COMMENT || '',
			});
		}

		return Array.from(tablesMap.values());
	}

	private async getUserUploadedTableNames(datasourceId: number | null, userId: number): Promise<string[]> {
		const actualDatasourceId = datasourceId ?? await this.getLocalDatasourceId();
		if (!actualDatasourceId) return [];

		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT table_name FROM uploaded_table WHERE datasource_id = ? AND user_id = ?',
			[actualDatasourceId, userId],
		);
		return rows.map((r: any) => r.table_name);
	}

	private async getLocalDatasourceId(): Promise<number | null> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT id FROM data_source WHERE is_local = 1 LIMIT 1',
		);
		return rows.length > 0 ? (rows[0] as any).id : null;
	}

	private formatSchemaRows(rows: any[], uploadedTableNames: string[]): string {
		if (!rows || rows.length === 0) {
			return '当前数据库中没有可用的业务表。';
		}

		const tablesMap = new Map<string, { comment: string; columns: string[]; isUploaded: boolean }>();

		for (const row of rows) {
			const tableName = row.TABLE_NAME;
			if (!tablesMap.has(tableName)) {
				tablesMap.set(tableName, {
					comment: row.TABLE_COMMENT || '',
					columns: [],
					isUploaded: uploadedTableNames.includes(tableName),
				});
			}
			const tableInfo = tablesMap.get(tableName)!;
			const colDef = `  ${row.COLUMN_NAME} ${row.COLUMN_TYPE} -- ${row.COLUMN_COMMENT || ''}`;
			tableInfo.columns.push(colDef);
		}

		const promptLines: string[] = [];
		for (const [tableName, info] of tablesMap.entries()) {
			const label = info.isUploaded ? ' [用户上传]' : '';
			promptLines.push(`表名: ${tableName}${label}`);
			promptLines.push(`说明: ${info.comment}`);
			promptLines.push(`字段:\n${info.columns.join('\n')}`);
			promptLines.push('');
		}

		return promptLines.join('\n').trim();
	}
}
