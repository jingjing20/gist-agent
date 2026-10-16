import { resolveCatalogDatasourceId, type DatabaseClient } from './index';

export interface AgentColumnPolicy {
    tableName: string;
    columnName: string;
    access: 'allow' | 'mask' | 'deny';
    maskType: 'redact' | 'last4' | 'hash' | null;
}

export async function assertDatasourceAccess(db: DatabaseClient, datasourceId: number | null, userId: number): Promise<number> {
    const id = await resolveCatalogDatasourceId(db, datasourceId);
    if (id == null) throw new Error('DATASOURCE_ACCESS_CHANGED: 数据源不存在');
    const rows = await db.query(
        `SELECT 1 FROM data_source d LEFT JOIN datasource_permission p ON p.datasource_id=d.id AND p.user_id=?
        WHERE d.id=? AND (d.created_by IS NULL OR d.created_by=? OR p.user_id IS NOT NULL)`,
        [userId, id, userId]
    );
    if (!rows.length) throw new Error('DATASOURCE_ACCESS_CHANGED: 数据源权限已被撤销');
    return id;
}

export async function getDatasourceColumnPolicies(db: DatabaseClient, datasourceId: number | null, userId: number): Promise<AgentColumnPolicy[]> {
    const id = await assertDatasourceAccess(db, datasourceId, userId);
    const rows = await db.query(
        `SELECT p.table_name,p.column_name,p.agent_access,p.mask_type FROM datasource_column_policy p
        JOIN datasource_table_catalog t ON t.datasource_id=p.datasource_id AND t.schema_name=p.schema_name AND t.table_name=p.table_name
        WHERE p.datasource_id=? AND p.schema_name=current_schema() AND t.is_agent_visible=TRUE`,
        [id]
    );
    return rows.map((row) => ({ tableName: row.table_name, columnName: row.column_name, access: row.agent_access, maskType: row.mask_type }));
}
