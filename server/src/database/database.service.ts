import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import mysql, { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export interface DataSourceConfig {
	id?: number;
	host: string;
	port: number;
	user: string;
	password: string;
	database_name: string;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(DatabaseService.name);

	// 本地默认库的单例连接池（用 .env 初始化，系统自身表也走这里）
	private localPool: Pool;

	// 动态数据源连接池 Map，key 为 data_source.id
	// 存 Promise 而非 Pool，避免 async 懒初始化的并发竞态（双重创建/泄漏）
	private readonly pools = new Map<number, Promise<Pool>>();

	// 本地默认数据源的 id（从 data_source 表读取，避免硬编码）
	private localDatasourceId: number | null = null;

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
		// 读取本地默认数据源的 id，后续 getPool 可以识别它
		try {
			const rows = await this.localPool.query<RowDataPacket[]>(
				'SELECT id FROM data_source WHERE is_local = 1 LIMIT 1'
			);
			const list = rows[0] as RowDataPacket[];
			if (list.length > 0) {
				this.localDatasourceId = list[0].id;
				this.logger.log(`本地默认数据源 id: ${this.localDatasourceId}`);
			}
		} catch {
			// data_source 表可能还未建（首次运行前），忽略
		}
	}

	// 根据配置获取或创建连接池（懒初始化）
	private createPool(config: DataSourceConfig): Pool {
		return mysql.createPool({
			host: config.host,
			port: config.port,
			user: config.user,
			password: config.password,
			database: config.database_name,
			waitForConnections: true,
			connectionLimit: 5,
		});
	}

	// 获取指定数据源的连接池。不传 id 或传本地库 id 都走 localPool
	async getPool(datasourceId?: number | null): Promise<Pool> {
		if (!datasourceId || datasourceId === this.localDatasourceId) {
			return this.localPool;
		}

		if (this.pools.has(datasourceId)) {
			return this.pools.get(datasourceId)!;
		}

		// 把创建过程本身的 Promise 存入 Map，并发请求 await 同一个 Promise，消除竞态
		const poolPromise = (async () => {
			const rows = await this.localPool.query<RowDataPacket[]>(
				'SELECT * FROM data_source WHERE id = ?',
				[datasourceId]
			);
			const list = rows[0] as RowDataPacket[];
			if (!list.length) {
				throw new Error(`数据源 id=${datasourceId} 不存在`);
			}

			const row = list[0] as any;
			if (row.is_local || !row.host) {
				return this.localPool;
			}

			const config = row as DataSourceConfig;
			const pool = this.createPool(config);
			this.logger.log(`已创建数据源连接池: id=${datasourceId}, db=${config.database_name}`);
			return pool;
		})();

		// 如果初始化失败，清掉这条记录，允许下次重试
		poolPromise.catch(() => this.pools.delete(datasourceId));
		this.pools.set(datasourceId, poolPromise);
		return poolPromise;
	}

	// 释放指定数据源的连接池（数据源删除时调用）
	async releasePool(datasourceId: number): Promise<void> {
		const poolPromise = this.pools.get(datasourceId);
		if (poolPromise) {
			this.pools.delete(datasourceId);
			const pool = await poolPromise.catch(() => null);
			if (pool && pool !== this.localPool) {
				await pool.end();
			}
		}
	}

	// 测试数据源连接是否可达
	async testConnection(config: DataSourceConfig): Promise<void> {
		const conn = await mysql.createConnection({
			host: config.host,
			port: config.port,
			user: config.user,
			password: config.password,
			database: config.database_name,
			connectTimeout: 5000,
		});
		await conn.end();
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
		for (const [id, poolPromise] of this.pools.entries()) {
			const pool = await poolPromise.catch(() => null);
			if (pool && pool !== this.localPool) {
				await pool.end();
				this.logger.log(`已释放数据源连接池: id=${id}`);
			}
		}
	}
}
