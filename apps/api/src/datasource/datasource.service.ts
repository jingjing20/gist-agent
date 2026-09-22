import { quoteIdentifier } from '@gist/database';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SchemaService } from '../database/schema.service';
import { QueryRow as RowDataPacket } from '../database/database.service';
import { SchemaEnrichmentService } from './schema-enrichment.service';

export interface DataSource {
    id: number;
    name: string;
    is_local: number;
    created_by?: number | null;
    creator_name?: string | null;
    description?: string;
    created_at: string;
}

export interface DataSourceTable {
    id: number;
    datasource_id: number;
    schema_name: string;
    table_name: string;
    display_name: string;
    description?: string | null;
    dataset_key?: string | null;
    source_type: 'preset' | 'uploaded' | 'external';
    is_agent_visible: boolean;
    created_by?: number | null;
    creator_name?: string | null;
    created_at: string;
}

/**
 * 数据源管理服务：负责数据源 CRUD、文件上传建表、权限管理。
 *
 * 权限模型三层：
 *   1. 公共 (created_by = NULL) -> 所有用户可见
 *   2. 自建 (created_by = userId) -> 创建者全权
 *   3. 授权 (datasource_permission 表) -> grant/revoke 管理
 */
@Injectable()
export class DataSourceService {
    constructor(
        private readonly db: DatabaseService,
        @Inject(forwardRef(() => SchemaService))
        private readonly schemaService: SchemaService,
        private readonly schemaEnrichmentService: SchemaEnrichmentService
    ) {}

    /**
     * 判断用户是否有权访问数据源：公共 -> 自建 -> 被授权，三级短路
     */
    async canAccess(datasourceId: number, userId: number): Promise<boolean> {
        const rows = await this.db.query<RowDataPacket[]>(
            `SELECT d.created_by, p.user_id AS has_perm
             FROM data_source d
             LEFT JOIN datasource_permission p ON p.datasource_id = d.id AND p.user_id = ?
             WHERE d.id = ?`,
            [userId, datasourceId]
        );
        if (!rows.length) return false;
        const row = rows[0] as any;
        if (row.created_by == null) return true;
        if (row.created_by === userId) return true;
        return row.has_perm != null;
    }

    async findAllForUser(userId: number): Promise<DataSource[]> {
        const rows = await this.db.query<RowDataPacket[]>(
            `SELECT d.id, d.name, d.is_local, d.created_by, u.name as creator_name, d.description, d.created_at
       FROM data_source d
       LEFT JOIN app_user u ON d.created_by = u.id
       LEFT JOIN datasource_permission p ON d.id = p.datasource_id AND p.user_id = ?
       WHERE d.created_by IS NULL OR d.created_by = ? OR p.user_id IS NOT NULL
       ORDER BY d.id ASC`,
            [userId, userId]
        );
        return rows as unknown as DataSource[];
    }

    async findOne(id: number, userId: number): Promise<DataSource> {
        const ok = await this.canAccess(id, userId);
        if (!ok) throw new ForbiddenException('无权访问此数据源');
        const rows = await this.db.query<RowDataPacket[]>('SELECT id, name, is_local, created_by, description, created_at FROM data_source WHERE id = ?', [id]);
        if (!rows.length) throw new NotFoundException(`数据源 id=${id} 不存在`);
        return rows[0] as unknown as DataSource;
    }

    async create(
        userId: number,
        body: {
            name: string;
            description?: string;
        }
    ): Promise<DataSource> {
        const result = await this.db.execute(`INSERT INTO data_source (name, created_by, description) VALUES (?, ?, ?) RETURNING id`, [
            body.name,
            userId,
            body.description ?? null,
        ]);
        await this.db.execute('INSERT INTO datasource_permission (datasource_id, user_id, granted_by) VALUES (?, ?, ?)', [result.insertId, userId, null]);
        return this.findOne(result.insertId, userId);
    }

    async update(
        id: number,
        userId: number,
        body: {
            name?: string;
            description?: string;
        }
    ): Promise<DataSource> {
        const ds = await this.findOne(id, userId);
        if (ds.created_by !== userId) throw new ForbiddenException('仅创建人可编辑数据源信息');

        const fields: string[] = [];
        const values: any[] = [];
        if (body.name !== undefined) {
            fields.push('name = ?');
            values.push(body.name);
        }
        if (body.description !== undefined) {
            fields.push('description = ?');
            values.push(body.description ?? null);
        }

        if (fields.length > 0) {
            values.push(id);
            await this.db.execute(`UPDATE data_source SET ${fields.join(', ')} WHERE id = ?`, values);
        }

        return this.findOne(id, userId);
    }

    async remove(id: number, userId: number): Promise<void> {
        const rows = await this.db.query<RowDataPacket[]>('SELECT is_local, created_by FROM data_source WHERE id = ?', [id]);
        if (!rows.length) throw new NotFoundException(`数据源 id=${id} 不存在`);
        const row = rows[0] as any;
        if (row.is_local) throw new BadRequestException('默认本地库不可删除');
        if (row.created_by !== userId) throw new ForbiddenException('仅创建人可删除');

        const tableRows = await this.db.query<RowDataPacket[]>("SELECT table_name FROM datasource_table_catalog WHERE datasource_id = ? AND source_type = 'uploaded'", [id]);
        for (const t of tableRows) {
            await this.db.execute(`DROP TABLE IF EXISTS ${quoteIdentifier((t as any).table_name)}`);
        }

        await this.db.execute('DELETE FROM data_source WHERE id = ?', [id]);
        this.schemaService.clearUserCache(id, userId);
    }

    /**
     * 文件上传建表核心流程：
     * 1. CREATE TABLE (动态列定义)
     * 2. PostgreSQL 参数化批量 INSERT
     * 3. COMMENT ON 写入表和列注释
     * 4. 注册到统一表目录
     * 5. 异步触发: Schema 增强 (LLM 推断业务语义) + 推荐问题重新生成
     *
     * 表名使用 ut_{timestamp}_{random} 格式，避免用户输入带来的注入风险
     */
    async uploadTable(
        datasourceId: number,
        userId: number,
        displayName: string,
        columns: Array<{ name: string; originalName?: string; type: string }>,
        rows: Array<Record<string, unknown>>
    ): Promise<DataSourceTable> {
        const ds = await this.findOne(datasourceId, userId);
        if (ds.is_local === 1) throw new ForbiddenException('公共默认数据源不支持上传文件');

        if (columns.length === 0) throw new BadRequestException('文件不包含有效列');

        const SAFE_COLUMN_NAME = /^[a-zA-Z_\u4e00-\u9fff][a-zA-Z0-9_\u4e00-\u9fff]*$/;
        for (const col of columns) {
            if (!SAFE_COLUMN_NAME.test(col.name)) {
                throw new BadRequestException(`列名 "${col.name}" 包含非法字符，仅允许字母、数字、下划线和中文`);
            }
        }

        const tableName = `ut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        const pgType = (type: string) => {
            const value = type.toUpperCase();
            if (value.includes('INT')) return 'BIGINT';
            if (value.includes('DECIMAL') || value.includes('NUMERIC') || value.includes('DOUBLE') || value.includes('FLOAT')) return 'NUMERIC';
            if (value.includes('DATE') || value.includes('TIME')) return 'TIMESTAMPTZ';
            if (value.includes('BOOL')) return 'BOOLEAN';
            return 'TEXT';
        };
        const colDefs = columns.map((c) => `${quoteIdentifier(c.name)} ${pgType(c.type)}`).join(', ');
        await this.db.execute(`CREATE TABLE ${quoteIdentifier(tableName)} (${colDefs})`);

        try {
            const batchSize = Math.max(1, Math.floor(60000 / columns.length));
            for (let i = 0; i < rows.length; i += batchSize) {
                const batch = rows.slice(i, i + batchSize);
                const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
                const values = batch.flatMap((row) => columns.map((c) => row[c.name] ?? null));
                await this.db.execute(`INSERT INTO ${quoteIdentifier(tableName)} (${columns.map((c) => quoteIdentifier(c.name)).join(', ')}) VALUES ${placeholders}`, values);
            }

            const esc = (s: string) => s.replace(/'/g, "''");
            await this.db.execute(`COMMENT ON TABLE ${quoteIdentifier(tableName)} IS '${esc(displayName)}'`);
            for (const col of columns) {
                const comment = col.originalName ?? col.name;
                await this.db.execute(`COMMENT ON COLUMN ${quoteIdentifier(tableName)}.${quoteIdentifier(col.name)} IS '${esc(comment)}'`);
            }

            const result = await this.db.execute(
                `INSERT INTO datasource_table_catalog
                    (datasource_id, schema_name, table_name, display_name, description, source_type, is_agent_visible, created_by)
                 VALUES (?, 'public', ?, ?, ?, 'uploaded', TRUE, ?) RETURNING id`,
                [datasourceId, tableName, displayName, displayName, userId]
            );
            await this.grantAgentReadAccess(tableName);

            this.schemaService.clearDatasourceCache(datasourceId);
            this.schemaEnrichmentService.enrichTableSchemaAsync(tableName);

            return {
                id: result.insertId,
                datasource_id: datasourceId,
                schema_name: 'public',
                table_name: tableName,
                display_name: displayName,
                description: displayName,
                dataset_key: null,
                source_type: 'uploaded',
                is_agent_visible: true,
                created_by: userId,
                created_at: new Date().toISOString(),
            };
        } catch (error) {
            await this.db.execute(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
            throw error;
        }
    }

    private async grantAgentReadAccess(tableName: string): Promise<void> {
        const role = process.env.AGENT_DB_USER;
        if (!role) return;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(role) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
            throw new Error('只读角色或数据表名称不合法');
        }
        await this.db.execute(`GRANT SELECT ON TABLE public.${quoteIdentifier(tableName)} TO ${quoteIdentifier(role)}`);
    }

    async listTables(datasourceId: number, userId: number): Promise<DataSourceTable[]> {
        await this.findOne(datasourceId, userId); // 走一遍 findOne 就是包含了鉴权，未抛错即可

        const rows = await this.db.query<RowDataPacket[]>(
            `SELECT t.id, t.datasource_id, t.schema_name, t.table_name, t.display_name, t.description,
                    t.dataset_key, t.source_type, t.is_agent_visible, t.created_by, u.name as creator_name, t.created_at
       FROM datasource_table_catalog t
       LEFT JOIN app_user u ON t.created_by = u.id
       WHERE t.datasource_id = ?
       ORDER BY t.dataset_key NULLS LAST, t.id`,
            [datasourceId]
        );
        return rows as unknown as DataSourceTable[];
    }

    async deleteTable(tableId: number, userId: number): Promise<number> {
        const rows = await this.db.query<RowDataPacket[]>(
            `SELECT t.table_name, t.created_by, t.datasource_id, t.source_type, d.created_by as ds_creator_id
       FROM datasource_table_catalog t
       LEFT JOIN data_source d ON t.datasource_id = d.id
       WHERE t.id = ?`,
            [tableId]
        );
        if (!rows.length) throw new NotFoundException(`数据表 id=${tableId} 不存在`);
        const row = rows[0] as any;
        if (row.source_type !== 'uploaded') throw new ForbiddenException('仅用户上传表可以删除');
        if (row.created_by !== userId && row.ds_creator_id !== userId) {
            throw new ForbiddenException('仅数据源创建者或表上传人可删除');
        }

        await this.db.execute(`DROP TABLE IF EXISTS ${quoteIdentifier(row.table_name)}`);
        await this.db.execute('DELETE FROM datasource_table_catalog WHERE id = ?', [tableId]);
        this.schemaService.clearDatasourceCache(row.datasource_id ?? null);
        return row.datasource_id;
    }

    async grant(datasourceId: number, targetUserId: number, grantorId: number): Promise<void> {
        const rows = await this.db.query<RowDataPacket[]>('SELECT created_by FROM data_source WHERE id = ?', [datasourceId]);
        if (!rows.length) throw new NotFoundException(`数据源 id=${datasourceId} 不存在`);
        if ((rows[0] as any).created_by !== grantorId) {
            throw new ForbiddenException('仅创建人可授权');
        }
        await this.db.execute('INSERT INTO datasource_permission (datasource_id, user_id, granted_by) VALUES (?, ?, ?) ON CONFLICT (datasource_id, user_id) DO NOTHING', [
            datasourceId,
            targetUserId,
            grantorId,
        ]);
    }

    async revoke(datasourceId: number, targetUserId: number, grantorId: number): Promise<void> {
        const rows = await this.db.query<RowDataPacket[]>('SELECT created_by FROM data_source WHERE id = ?', [datasourceId]);
        if (!rows.length) throw new NotFoundException(`数据源 id=${datasourceId} 不存在`);
        if ((rows[0] as any).created_by !== grantorId) {
            throw new ForbiddenException('仅创建人可撤销授权');
        }
        await this.db.execute('DELETE FROM datasource_permission WHERE datasource_id = ? AND user_id = ?', [datasourceId, targetUserId]);
    }

    async listPermissionUsers(datasourceId: number, grantorId: number): Promise<{ id: number; email: string; name: string }[]> {
        const rows = await this.db.query<RowDataPacket[]>('SELECT created_by FROM data_source WHERE id = ?', [datasourceId]);
        if (!rows.length) throw new NotFoundException(`数据源 id=${datasourceId} 不存在`);
        if ((rows[0] as any).created_by !== grantorId) {
            throw new ForbiddenException('仅创建人可查看授权列表');
        }
        const users = await this.db.query<RowDataPacket[]>(
            `SELECT u.id, u.email, u.name FROM app_user u
       INNER JOIN datasource_permission p ON u.id = p.user_id AND p.datasource_id = ?
       ORDER BY u.email`,
            [datasourceId]
        );
        return users as unknown as { id: number; email: string; name: string }[];
    }
}
