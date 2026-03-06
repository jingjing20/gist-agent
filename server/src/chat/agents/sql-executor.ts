import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RowDataPacket } from 'mysql2/promise';

const MAX_ROWS = 1000;

export interface QueryResult {
	columns: string[];
	rows: Record<string, unknown>[];
	rowCount: number;
}

@Injectable()
export class SqlExecutorAgent {
	constructor(private readonly db: DatabaseService) { }

	validate(sql: string): void {
		const normalized = sql.trim().toUpperCase();

		if (!normalized.startsWith('SELECT')) {
			throw new Error('只允许执行 SELECT 查询');
		}

		const forbidden = [
			'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER',
			'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE',
		];
		for (const keyword of forbidden) {
			const pattern = new RegExp(`\\b${keyword}\\b`, 'i');
			if (pattern.test(sql)) {
				throw new Error(`SQL 包含禁止的操作: ${keyword}`);
			}
		}
	}

	ensureLimit(sql: string): string {
		const normalized = sql.trim().toUpperCase();
		if (!normalized.includes('LIMIT')) {
			return `${sql.replace(/;\s*$/, '')} LIMIT ${MAX_ROWS}`;
		}
		return sql;
	}

	async execute(sql: string): Promise<QueryResult> {
		this.validate(sql);
		const safeSql = this.ensureLimit(sql);

		const rows = await this.db.query<RowDataPacket[]>(safeSql);
		const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

		return {
			columns,
			rows: rows as Record<string, unknown>[],
			rowCount: rows.length,
		};
	}
}
