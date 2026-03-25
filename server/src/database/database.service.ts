import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import mysql, { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';


@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(DatabaseService.name);
	private readonly localPool: Pool;

	constructor() {
		this.localPool = mysql.createPool({
			host: process.env.DB_HOST || 'localhost',
			port: Number(process.env.DB_PORT) || 3306,
			user: process.env.DB_USER || 'root',
			password: process.env.DB_PASSWORD || '',
			database: process.env.DB_NAME || 'ai_analysis',
			waitForConnections: true,
			connectionLimit: 10,
			flags: ['+LOCAL_FILES'],
		});
	}

	async onModuleInit() {
		// 不再需要检测本地数据源 ID
	}

	// 获取连接池。由于不再支持外部数据源，始终返回本地连接池
	async getPool(_datasourceId?: number | null): Promise<Pool> {
		return this.localPool;
	}


	// 通用查询，支持动态路由到指定数据源
	async query<T extends RowDataPacket[]>(
		sql: string,
		params?: unknown[],
		datasourceId?: number | null,
	): Promise<T> {
		const pool = await this.getPool(datasourceId);
		const [rows] = await pool.query<T>(sql, params);
		return rows;
	}

	// 写操作，只走本地库（只有建影子表等系统操作才会用到）
	async execute(sql: string, params?: unknown[]): Promise<ResultSetHeader> {
		const [result] = await this.localPool.execute<ResultSetHeader>(sql, params as any);
		return result;
	}

	/**
	 * 在本地默认库执行事务
	 */
	async withTransaction<T>(worker: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
		const conn = await this.localPool.getConnection();
		await conn.beginTransaction();
		try {
			const result = await worker(conn);
			await conn.commit();
			return result;
		} catch (err) {
			await conn.rollback();
			throw err;
		} finally {
			conn.release();
		}
	}

	// 专门处理极速批量写入的 TSV/CSV 数据流
	async executeLoad(sql: string, streamFactory: (path: string) => NodeJS.ReadableStream): Promise<ResultSetHeader> {
		const [result] = await (this.localPool.query as any)({
			sql,
			infileStreamFactory: streamFactory,
		});
		return result as ResultSetHeader;
	}

	async onModuleDestroy() {
		await this.localPool.end();
	}
}
