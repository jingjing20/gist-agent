import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService, DataSourceConfig } from '../database/database.service';
import { RowDataPacket } from 'mysql2/promise';

export interface DataSource {
	id: number;
	name: string;
	host?: string;
	port?: number;
	user?: string;
	database_name?: string;
	is_local: number;
	created_by?: number | null;
	description?: string;
	created_at: string;
}

export interface UploadedTable {
	id: number;
	datasource_id: number;
	user_id: number;
	table_name: string;
	display_name: string;
	created_at: string;
}

@Injectable()
export class DataSourceService {
	constructor(private readonly db: DatabaseService) { }

	async canAccess(datasourceId: number, userId: number): Promise<boolean> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT created_by FROM data_source WHERE id = ?',
			[datasourceId],
		);
		if (!rows.length) return false;
		const row = rows[0] as any;
		if (row.created_by == null) return true;
		if (row.created_by === userId) return true;
		const perm = await this.db.query<RowDataPacket[]>(
			'SELECT 1 FROM datasource_permission WHERE datasource_id = ? AND user_id = ?',
			[datasourceId, userId],
		);
		return perm.length > 0;
	}

	async findAllForUser(userId: number): Promise<DataSource[]> {
		const rows = await this.db.query<RowDataPacket[]>(
			`SELECT d.id, d.name, d.host, d.port, d.user, d.database_name, d.is_local, d.created_by, d.description, d.created_at
       FROM data_source d
       LEFT JOIN datasource_permission p ON d.id = p.datasource_id AND p.user_id = ?
       WHERE d.created_by IS NULL OR d.created_by = ? OR p.user_id IS NOT NULL
       ORDER BY d.id ASC`,
			[userId, userId],
		);
		return rows as unknown as DataSource[];
	}

	async findOne(id: number, userId: number): Promise<DataSource> {
		const ok = await this.canAccess(id, userId);
		if (!ok) throw new ForbiddenException('无权访问此数据源');
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT id, name, host, port, user, database_name, is_local, created_by, description, created_at FROM data_source WHERE id = ?',
			[id],
		);
		if (!rows.length) throw new NotFoundException(`数据源 id=${id} 不存在`);
		return rows[0] as unknown as DataSource;
	}

	async create(userId: number, body: {
		name: string;
		host?: string;
		port?: number;
		user?: string;
		password?: string;
		database_name?: string;
		description?: string;
	}): Promise<DataSource> {
		if (body.host) {
			await this.db.testConnection({
				host: body.host,
				port: body.port!,
				user: body.user!,
				password: body.password ?? '',
				database_name: body.database_name!,
			});
		}

		const result = await this.db.execute(
			`INSERT INTO data_source (name, host, port, user, password, database_name, created_by, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[body.name, body.host ?? null, body.port ?? null, body.user ?? null, body.password ?? null, body.database_name ?? null, userId, body.description ?? null],
		);
		await this.db.execute(
			'INSERT INTO datasource_permission (datasource_id, user_id, granted_by) VALUES (?, ?, ?)',
			[result.insertId, userId, null],
		);
		return this.findOne(result.insertId, userId);
	}

	async remove(id: number, userId: number): Promise<void> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT is_local, created_by FROM data_source WHERE id = ?',
			[id],
		);
		if (!rows.length) throw new NotFoundException(`数据源 id=${id} 不存在`);
		const row = rows[0] as any;
		if (row.is_local) throw new BadRequestException('默认本地库不可删除');
		if (row.created_by !== userId) throw new ForbiddenException('仅创建人可删除');

		const tableRows = await this.db.query<RowDataPacket[]>(
			'SELECT table_name FROM uploaded_table WHERE datasource_id = ?',
			[id],
		);
		for (const t of tableRows) {
			await this.db.execute(`DROP TABLE IF EXISTS \`${(t as any).table_name}\``);
		}

		await this.db.releasePool(id);
		await this.db.execute('DELETE FROM data_source WHERE id = ?', [id]);
	}

	async testConnection(config: DataSourceConfig): Promise<void> {
		await this.db.testConnection(config);
	}

	async testById(id: number, userId: number): Promise<void> {
		await this.findOne(id, userId);
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT * FROM data_source WHERE id = ?',
			[id],
		);
		await this.db.testConnection(rows[0] as unknown as DataSourceConfig);
	}

	async uploadTable(
		datasourceId: number,
		userId: number,
		displayName: string,
		columns: Array<{ name: string; type: string }>,
		rows: Array<Record<string, unknown>>,
	): Promise<UploadedTable> {
		const dsRows = await this.db.query<RowDataPacket[]>(
			'SELECT is_local FROM data_source WHERE id = ?',
			[datasourceId],
		);
		if (!dsRows.length) throw new NotFoundException(`数据源 id=${datasourceId} 不存在`);
		if ((dsRows[0] as any).is_local === 1) throw new ForbiddenException('公共默认数据源不支持上传文件');

		const ok = await this.canAccess(datasourceId, userId);
		if (!ok) throw new ForbiddenException('无权访问此数据源');

		if (columns.length === 0) throw new BadRequestException('文件不包含有效列');

		const tableName = `ut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		const colDefs = columns.map(c => `\`${c.name}\` ${c.type}`).join(', ');
		await this.db.execute(`CREATE TABLE \`${tableName}\` (${colDefs})`);

		const BATCH = 200;
		for (let i = 0; i < rows.length; i += BATCH) {
			const batch = rows.slice(i, i + BATCH);
			if (!batch.length) continue;
			const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
			const values = batch.flatMap(row => columns.map(c => row[c.name] ?? null));
			await this.db.execute(
				`INSERT INTO \`${tableName}\` (${columns.map(c => `\`${c.name}\``).join(', ')}) VALUES ${placeholders}`,
				values,
			);
		}

		const result = await this.db.execute(
			'INSERT INTO uploaded_table (datasource_id, user_id, table_name, display_name) VALUES (?, ?, ?, ?)',
			[datasourceId, userId, tableName, displayName],
		);

		return {
			id: result.insertId,
			datasource_id: datasourceId,
			user_id: userId,
			table_name: tableName,
			display_name: displayName,
			created_at: new Date().toISOString(),
		};
	}

	async listUploadedTables(datasourceId: number, userId: number): Promise<UploadedTable[]> {
		const ok = await this.canAccess(datasourceId, userId);
		if (!ok) throw new ForbiddenException('无权访问此数据源');

		const rows = await this.db.query<RowDataPacket[]>(
			`SELECT id, datasource_id, user_id, table_name, display_name, created_at
       FROM uploaded_table
       WHERE datasource_id = ? AND user_id = ?
       ORDER BY created_at DESC`,
			[datasourceId, userId],
		);
		return rows as unknown as UploadedTable[];
	}

	async deleteUploadedTable(tableId: number, userId: number): Promise<void> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT table_name, user_id FROM uploaded_table WHERE id = ?',
			[tableId],
		);
		if (!rows.length) throw new NotFoundException(`上传表 id=${tableId} 不存在`);
		const row = rows[0] as any;
		if (row.user_id !== userId) throw new ForbiddenException('仅上传人可删除');

		await this.db.execute(`DROP TABLE IF EXISTS \`${row.table_name}\``);
		await this.db.execute('DELETE FROM uploaded_table WHERE id = ?', [tableId]);
	}

	async getUploadedTableNames(datasourceId: number, userId: number): Promise<string[]> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT table_name FROM uploaded_table WHERE datasource_id = ? AND user_id = ?',
			[datasourceId, userId],
		);
		return rows.map((r: any) => r.table_name);
	}

	async grant(datasourceId: number, targetUserId: number, grantorId: number): Promise<void> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT created_by FROM data_source WHERE id = ?',
			[datasourceId],
		);
		if (!rows.length) throw new NotFoundException(`数据源 id=${datasourceId} 不存在`);
		if ((rows[0] as any).created_by !== grantorId) {
			throw new ForbiddenException('仅创建人可授权');
		}
		await this.db.execute(
			'INSERT IGNORE INTO datasource_permission (datasource_id, user_id, granted_by) VALUES (?, ?, ?)',
			[datasourceId, targetUserId, grantorId],
		);
	}

	async revoke(datasourceId: number, targetUserId: number, grantorId: number): Promise<void> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT created_by FROM data_source WHERE id = ?',
			[datasourceId],
		);
		if (!rows.length) throw new NotFoundException(`数据源 id=${datasourceId} 不存在`);
		if ((rows[0] as any).created_by !== grantorId) {
			throw new ForbiddenException('仅创建人可撤销授权');
		}
		await this.db.execute(
			'DELETE FROM datasource_permission WHERE datasource_id = ? AND user_id = ?',
			[datasourceId, targetUserId],
		);
	}

	async listPermissionUsers(datasourceId: number, grantorId: number): Promise<{ id: number; email: string; name: string }[]> {
		const rows = await this.db.query<RowDataPacket[]>(
			'SELECT created_by FROM data_source WHERE id = ?',
			[datasourceId],
		);
		if (!rows.length) throw new NotFoundException(`数据源 id=${datasourceId} 不存在`);
		if ((rows[0] as any).created_by !== grantorId) {
			throw new ForbiddenException('仅创建人可查看授权列表');
		}
		const users = await this.db.query<RowDataPacket[]>(
			`SELECT u.id, u.email, u.name FROM user u
       INNER JOIN datasource_permission p ON u.id = p.user_id AND p.datasource_id = ?
       ORDER BY u.email`,
			[datasourceId],
		);
		return users as unknown as { id: number; email: string; name: string }[];
	}
}
