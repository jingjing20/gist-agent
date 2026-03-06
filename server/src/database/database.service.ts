import { Injectable, OnModuleDestroy } from '@nestjs/common';
import mysql, { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
	private pool: Pool;

	constructor() {
		this.pool = mysql.createPool({
			host: process.env.DB_HOST || 'localhost',
			port: Number(process.env.DB_PORT) || 3306,
			user: process.env.DB_USER || 'root',
			password: process.env.DB_PASSWORD || '',
			database: process.env.DB_NAME || 'ai_analysis',
			waitForConnections: true,
			connectionLimit: 10,
		});
	}

	async query<T extends RowDataPacket[]>(sql: string, params?: unknown[]): Promise<T> {
		const [rows] = await this.pool.query<T>(sql, params);
		return rows;
	}

	async execute(sql: string, params?: unknown[]): Promise<ResultSetHeader> {
		const [result] = await this.pool.execute<ResultSetHeader>(sql, params as any);
		return result;
	}

	async onModuleDestroy() {
		await this.pool.end();
	}
}
