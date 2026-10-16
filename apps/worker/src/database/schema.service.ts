import { assertDatasourceAccess, getDatasourceColumnPolicies, type AgentColumnPolicy } from '@gist/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { getAgentVisibleCatalogTables } from '@gist/database';
import { resolveCatalogDatasourceId } from '@gist/database';
import type { SchemaCatalogSummaryV1, SchemaDetailV1 } from '@gist/contracts';

export type { AgentColumnPolicy } from '@gist/database';

/**
 * 管理数据库 Schema 可见性及 AI 提示词生成。
 * 核心逻辑：以数据源表目录作为唯一授权来源，将已登记结构转换为 AI 可理解的文本。
 */
@Injectable()
export class SchemaService {
    constructor(private readonly db: DatabaseService) {}

    async getAllowedTableNames(datasourceId: number | null, userId: number): Promise<string[]> {
        await this.assertDatasourceAccess(datasourceId, userId);
        const catalogTables = await getAgentVisibleCatalogTables(this.db, datasourceId);
        return catalogTables.map((table) => table.table_name);
    }

    async getColumnPolicies(datasourceId: number | null, userId: number): Promise<AgentColumnPolicy[]> {
        return getDatasourceColumnPolicies(this.db, datasourceId, userId);
    }

    async assertDatasourceAccess(datasourceId: number | null, userId: number): Promise<void> {
        await assertDatasourceAccess(this.db, datasourceId, userId);
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

    async getStructuredSchema(datasourceId: number | null, userId: number, tableNames?: string[]): Promise<any[]> {
        await this.assertDatasourceAccess(datasourceId, userId);
        const catalogTables = (await getAgentVisibleCatalogTables(this.db, datasourceId)).filter((t) => !tableNames || tableNames.includes(t.table_name));
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
        await this.assertDatasourceAccess(datasourceId, _userId);
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
        const tables = await this.getStructuredSchema(resolved, userId, [tableName]);
        const table = tables.find((candidate) => candidate.tableName === tableName);
        if (!table) return null;
        return {
            datasourceId: resolved,
            schema: 'public',
            table: table.tableName,
            columns: table.fields.map((field: any) => ({ name: field.name, type: field.type, ...(field.comment ? { description: field.comment } : {}) })),
        };
    }
}
