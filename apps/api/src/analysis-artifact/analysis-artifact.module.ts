import { Controller, Get, Module, Param, Query, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import { getAgentVisibleCatalogTables } from '@gist/database';
import { DatabaseService } from '../database/database.service';
import { CurrentUser } from '../auth/user.decorator';
import type { User } from '../auth/auth.service';

function stable(value: any): any {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, stable(v)])
        );
    return value;
}
function integer(value: string | undefined, fallback: number, min: number, max: number) {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max || value === '') throw new BadRequestException('分页参数无效');
    return n;
}
@Controller('analysis-artifacts')
export class AnalysisArtifactController {
    constructor(private readonly db: DatabaseService) {}
    private async read(user: User, id: string, conversationId: string) {
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuid.test(id) || !uuid.test(conversationId || '')) throw new BadRequestException('证据或会话参数无效');
        const rows = await this.db.query<any[]>(
            `SELECT a.* FROM query_artifact a JOIN data_source d ON d.id=a.datasource_id
            WHERE a.id=? AND a.user_id=? AND a.conversation_id=? AND (a.expires_at IS NULL OR a.expires_at>NOW())
            AND (d.created_by IS NULL OR d.created_by=? OR EXISTS (SELECT 1 FROM datasource_permission p WHERE p.datasource_id=d.id AND p.user_id=?))`,
            [id, user.id, conversationId, user.id, user.id]
        );
        if (!rows.length) throw new NotFoundException('证据不存在、已过期或无权访问');
        const row = rows[0];
        const tables = (await getAgentVisibleCatalogTables(this.db, Number(row.datasource_id))).map((t) => t.table_name).sort();
        const policies = (
            await this.db.query<any[]>(
                `SELECT p.table_name,p.column_name,p.agent_access,p.mask_type FROM datasource_column_policy p
            JOIN datasource_table_catalog t ON t.datasource_id=p.datasource_id AND t.schema_name=p.schema_name AND t.table_name=p.table_name
            WHERE p.datasource_id=? AND p.schema_name=current_schema() AND t.is_agent_visible=TRUE`,
                [row.datasource_id]
            )
        )
            .map((p) => ({ tableName: p.table_name, columnName: p.column_name, access: p.agent_access, maskType: p.mask_type }))
            .sort((a, b) => `${a.tableName}.${a.columnName}`.localeCompare(`${b.tableName}.${b.columnName}`));
        const fingerprint = createHash('sha256')
            .update(JSON.stringify(stable({ tables, policies })))
            .digest('hex');
        if (row.analysis_context?.accessFingerprint !== fingerprint) throw new ConflictException('证据权限快照无效或字段权限已变化，请重新查询');
        return row;
    }
    @Get(':id') async metadata(@CurrentUser() user: User, @Param('id') id: string, @Query('conversationId') conversation: string) {
        const r = await this.read(user, id, conversation);
        return {
            id: r.id,
            title: r.title,
            purpose: r.purpose,
            expectedGrain: r.expected_grain,
            originalSql: r.original_sql,
            executedSql: r.executed_sql,
            columns: r.columns_json,
            returnedRowCount: r.returned_row_count,
            totalRowCount: r.total_row_count,
            isLimited: r.is_limited,
            createdAt: r.created_at,
            context: r.analysis_context,
            quality: r.result_quality,
        };
    }
    @Get(':id/rows') async rows(
        @CurrentUser() user: User,
        @Param('id') id: string,
        @Query('conversationId') conversation: string,
        @Query('cursor') cursor?: string,
        @Query('limit') limit?: string
    ) {
        const offset = integer(cursor, 0, 0, Number.MAX_SAFE_INTEGER),
            size = integer(limit, 50, 1, 100);
        const r = await this.read(user, id, conversation);
        const rows = r.result_rows as Record<string, unknown>[];
        return { rows: rows.slice(offset, offset + size), nextCursor: offset + size < rows.length ? String(offset + size) : null };
    }
}
@Module({ controllers: [AnalysisArtifactController] })
export class AnalysisArtifactModule {}
