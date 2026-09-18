import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { getAgentVisibleCatalogTables, type DataSourceTableCatalogEntry } from '@gist/database';
import { resolveCatalogDatasourceId } from '@gist/database';
import type { SchemaCatalogSummaryV1, SchemaDetailV1 } from '@gist/contracts';

interface SchemaCacheEntry {
    prompt: string;
    timestamp: number;
}

export interface AgentColumnPolicy {
    tableName: string;
    columnName: string;
    access: 'allow' | 'mask' | 'deny';
    maskType: 'redact' | 'last4' | 'hash' | null;
}

const CACHE_TTL_MS = 60 * 1000; // 1 分钟缓存

/**
 * 管理数据库 Schema 可见性及 AI 提示词生成。
 * 核心逻辑：以数据源表目录作为唯一授权来源，将已登记结构转换为 AI 可理解的文本。
 */
@Injectable()
export class SchemaService {
    private readonly cache = new Map<string, SchemaCacheEntry>();

    constructor(private readonly db: DatabaseService) {}

    /**
     * 获取用于 AI 会话的数据库结构 Prompt。
     * 包含权限控制：仅列出目录中明确对 Agent 开放的表。
     */
    async getDatabaseSchemaPrompt(datasourceId: number | null, userId: number): Promise<string> {
        const cacheKey = `${datasourceId || 'local'}_${userId}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
            return cached.prompt;
        }

        const catalogTables = await getAgentVisibleCatalogTables(this.db, datasourceId);
        const allowedTables = catalogTables.map((table) => table.table_name);

        if (allowedTables.length === 0) {
            return '当前数据源中没有对 Agent 开放的业务表。';
        }

        const rows = await this.fetchRawSchemaRows(allowedTables);
        const policies = await this.getColumnPolicies(datasourceId, userId);
        const prompt = rows.length > 0 ? this.formatSchemaRows(rows, catalogTables, policies) : '当前数据源中没有可用的业务表。';

        if (prompt) {
            this.cache.set(cacheKey, { prompt, timestamp: Date.now() });
        }
        return prompt;
    }

    clearUserCache(datasourceId: number | null, userId: number): void {
        const cacheKey = `${datasourceId || 'local'}_${userId}`;
        this.cache.delete(cacheKey);
    }

    clearDatasourceCache(datasourceId: number | null): void {
        const prefix = `${datasourceId || 'local'}_`;
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) this.cache.delete(key);
        }
    }

    async getAllowedTableNames(datasourceId: number | null, userId: number): Promise<string[]> {
        await this.assertDatasourceAccess(datasourceId, userId);
        const catalogTables = await getAgentVisibleCatalogTables(this.db, datasourceId);
        return catalogTables.map((table) => table.table_name);
    }

    async getColumnPolicies(datasourceId: number | null, userId: number): Promise<AgentColumnPolicy[]> {
        await this.assertDatasourceAccess(datasourceId, userId);
        const resolved = await resolveCatalogDatasourceId(this.db, datasourceId);
        if (resolved == null) return [];
        const rows = await this.db.query<any[]>(
            `SELECT p.table_name,p.column_name,p.agent_access,p.mask_type
             FROM datasource_column_policy p
             JOIN datasource_table_catalog t ON t.datasource_id=p.datasource_id
               AND t.schema_name=p.schema_name AND t.table_name=p.table_name
             WHERE p.datasource_id=? AND p.schema_name=current_schema() AND t.is_agent_visible=TRUE`,
            [resolved]
        );
        return rows.map((row) => ({ tableName: row.table_name, columnName: row.column_name, access: row.agent_access, maskType: row.mask_type }));
    }

    async assertDatasourceAccess(datasourceId: number | null, userId: number): Promise<void> {
        const resolved = await resolveCatalogDatasourceId(this.db, datasourceId);
        if (resolved == null) throw new Error('DATASOURCE_ACCESS_CHANGED: 数据源不存在');
        const rows = await this.db.query<any[]>(
            `SELECT 1 FROM data_source d
             LEFT JOIN datasource_permission p ON p.datasource_id=d.id AND p.user_id=?
             WHERE d.id=? AND (d.created_by IS NULL OR d.created_by=? OR p.user_id IS NOT NULL)`,
            [userId, resolved, userId]
        );
        if (!rows.length) throw new Error('DATASOURCE_ACCESS_CHANGED: 数据源权限已被撤销');
    }

    /**
     * 从 information_schema 抓取物理表结构原始行，供各格式化方法复用。
     */
    private async fetchRawSchemaRows(allowedTables: string[]): Promise<any[]> {
        const placeholders = allowedTables.map(() => '?').join(', ');
        const sql = `
            SELECT
                c.table_name AS "TABLE_NAME",
                COALESCE(obj_description((quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass), '') AS "TABLE_COMMENT",
                c.column_name AS "COLUMN_NAME",
                c.data_type AS "COLUMN_TYPE",
                COALESCE(col_description((quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass, c.ordinal_position), '') AS "COLUMN_COMMENT"
            FROM information_schema.columns c
            WHERE c.table_schema = current_schema()
              AND c.table_name IN (${placeholders})
            ORDER BY c.table_name, c.ordinal_position
        `;
        return this.db.query<any[]>(sql, allowedTables);
    }

    async getStructuredSchema(datasourceId: number | null, userId: number): Promise<any[]> {
        const catalogTables = await getAgentVisibleCatalogTables(this.db, datasourceId);
        const allowedTables = catalogTables.map((table) => table.table_name);
        const catalogByName = new Map(catalogTables.map((table) => [table.table_name, table]));
        const policies = await this.getColumnPolicies(datasourceId, userId);
        const policyByColumn = new Map(policies.map((policy) => [`${policy.tableName}.${policy.columnName}`.toLowerCase(), policy]));

        if (allowedTables.length === 0) return [];

        const rows = await this.fetchRawSchemaRows(allowedTables);
        const tablesMap = new Map<
            string,
            {
                tableName: string;
                display_name: string;
                isUploaded: boolean;
                sourceType?: string;
                datasetKey?: string | null;
                fields: any[];
            }
        >();

        for (const row of rows) {
            const tableName = row.TABLE_NAME;
            const policy = policyByColumn.get(`${tableName}.${row.COLUMN_NAME}`.toLowerCase());
            if (policy?.access === 'deny') continue;
            if (!tablesMap.has(tableName)) {
                tablesMap.set(tableName, {
                    tableName,
                    display_name: catalogByName.get(tableName)?.display_name || row.TABLE_COMMENT || tableName,
                    isUploaded: catalogByName.get(tableName)?.source_type === 'uploaded',
                    sourceType: catalogByName.get(tableName)?.source_type,
                    datasetKey: catalogByName.get(tableName)?.dataset_key,
                    fields: [],
                });
            }
            const tableInfo = tablesMap.get(tableName)!;
            tableInfo.fields.push({
                name: row.COLUMN_NAME,
                type: row.COLUMN_TYPE,
                comment: row.COLUMN_COMMENT || '',
                masked: policy?.access === 'mask',
            });
        }

        return Array.from(tablesMap.values());
    }

    async getSchemaCatalogSummary(datasourceId: number | null, _userId: number): Promise<SchemaCatalogSummaryV1> {
        const resolved = await resolveCatalogDatasourceId(this.db, datasourceId);
        if (resolved == null) return { datasourceId: 0, tables: [] };
        const tables = await getAgentVisibleCatalogTables(this.db, resolved);
        return {
            datasourceId: resolved,
            tables: tables.map((table) => ({
                schema: table.schema_name,
                name: table.table_name,
                displayName: table.display_name,
                ...(table.description ? { description: table.description } : {}),
            })),
        };
    }

    async getSchemaDetail(datasourceId: number | null, userId: number, tableName: string): Promise<SchemaDetailV1 | null> {
        const resolved = await resolveCatalogDatasourceId(this.db, datasourceId);
        if (resolved == null) return null;
        const tables = await this.getStructuredSchema(resolved, userId);
        const table = tables.find((candidate) => candidate.tableName === tableName);
        if (!table) return null;
        return {
            datasourceId: resolved,
            schema: 'public',
            table: table.tableName,
            columns: table.fields.map((field: any) => ({ name: field.name, type: field.type, ...(field.comment ? { description: field.comment } : {}) })),
        };
    }

    /**
     * 将数据库行数据转换为 AI 友好的文本格式。
     */
    private formatSchemaRows(rows: any[], catalogTables: DataSourceTableCatalogEntry[], policies: AgentColumnPolicy[] = []): string {
        if (!rows || rows.length === 0) {
            return '当前数据库中没有可用的业务表。';
        }

        const catalogByName = new Map(catalogTables.map((table) => [table.table_name, table]));
        const policyByColumn = new Map(policies.map((policy) => [`${policy.tableName}.${policy.columnName}`.toLowerCase(), policy]));
        const tablesMap = new Map<string, { comment: string; columns: string[]; catalog?: DataSourceTableCatalogEntry }>();

        for (const row of rows) {
            const tableName = row.TABLE_NAME;
            const policy = policyByColumn.get(`${tableName}.${row.COLUMN_NAME}`.toLowerCase());
            if (policy?.access === 'deny') continue;
            if (!tablesMap.has(tableName)) {
                tablesMap.set(tableName, {
                    comment: row.TABLE_COMMENT || '',
                    columns: [],
                    catalog: catalogByName.get(tableName),
                });
            }
            const tableInfo = tablesMap.get(tableName)!;
            const colDef = `  ${row.COLUMN_NAME} ${row.COLUMN_TYPE}${policy?.access === 'mask' ? ' [输出脱敏]' : ''} -- ${row.COLUMN_COMMENT || ''}`;
            tableInfo.columns.push(colDef);
        }

        const promptLines: string[] = [];
        for (const [tableName, info] of tablesMap.entries()) {
            const label = info.catalog?.source_type === 'uploaded' ? ' [用户上传]' : '';
            promptLines.push(`表名: ${tableName}${label}`);
            if (info.catalog?.dataset_key) promptLines.push(`数据集: ${info.catalog.dataset_key}`);
            promptLines.push(`说明: ${info.catalog?.description || info.comment}`);
            promptLines.push(`字段:\n${info.columns.join('\n')}`);
            promptLines.push('');
        }

        return promptLines.join('\n').trim();
    }
}
