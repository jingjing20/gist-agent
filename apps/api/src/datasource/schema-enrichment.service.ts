import { quoteIdentifier } from '@gist/database';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ENRICHMENT_PROMPT, parseJsonArray, PROMPT_METADATA } from '@gist/llm';
import type { SchemaColumnComment, SchemaCommentChange, SchemaCommentSuggestion, SchemaEnrichmentResult } from '@gist/contracts';
import { DatabaseService, type TransactionConnection } from '../database/database.service';
import { LlmService } from '../llm/llm.service';
import { SchemaService } from '../database/schema.service';

type TableIdentity = { schema_name: string; table_name: string };
export function validateCommentChanges(value: unknown): SchemaCommentChange[] {
    if (!Array.isArray(value) || !value.length || value.length > 100) throw new BadRequestException('请选择 1–100 个字段');
    const seen = new Set<string>();
    return value.map((v) => {
        if (
            !v ||
            typeof v !== 'object' ||
            Object.keys(v).some((k) => !['column', 'originalComment', 'comment'].includes(k)) ||
            typeof v.column !== 'string' ||
            !v.column ||
            seen.has(v.column) ||
            typeof v.originalComment !== 'string' ||
            typeof v.comment !== 'string' ||
            !v.comment.trim() ||
            v.comment.length > 1000 ||
            v.comment.includes('\0')
        )
            throw new BadRequestException('字段注释格式错误、重复或超过 1000 字符');
        seen.add(v.column);
        return { column: v.column, originalComment: v.originalComment, comment: v.comment.trim() };
    });
}
export function parseEnrichments(raw: string, allowed: string[]): SchemaCommentSuggestion[] {
    const seen = new Set<string>();
    return parseJsonArray(raw).map((v: any) => {
        if (
            !v ||
            typeof v !== 'object' ||
            Object.keys(v).some((k) => !['column', 'suggestedComment', 'basis', 'needsVerification'].includes(k)) ||
            !allowed.includes(v.column) ||
            seen.has(v.column) ||
            typeof v.suggestedComment !== 'string' ||
            !v.suggestedComment.trim() ||
            v.suggestedComment.length > 1000 ||
            v.suggestedComment.includes('\0') ||
            !['original_metadata', 'sample_observation'].includes(v.basis) ||
            !Array.isArray(v.needsVerification) ||
            v.needsVerification.length > 10 ||
            v.needsVerification.some((s: unknown) => typeof s !== 'string' || s.length > 300)
        )
            throw new BadRequestException('生成的注释格式不合法，请重新生成');
        seen.add(v.column);
        return { column: v.column, suggestedComment: v.suggestedComment.trim(), basis: v.basis, needsVerification: v.needsVerification };
    });
}
@Injectable()
export class SchemaEnrichmentService {
    constructor(
        private readonly db: DatabaseService,
        private readonly llm: LlmService,
        private readonly schema: SchemaService
    ) {}

    private async table(tx: TransactionConnection, datasourceId: number, tableId: number, userId: number): Promise<TableIdentity> {
        const [rows] = await tx.query(
            `SELECT t.schema_name,t.table_name,t.created_by,d.created_by AS owner,
            (d.created_by IS NULL OR d.created_by=? OR EXISTS(SELECT 1 FROM datasource_permission p WHERE p.datasource_id=d.id AND p.user_id=?)) AS accessible
            FROM datasource_table_catalog t JOIN data_source d ON d.id=t.datasource_id
            WHERE t.id=? AND t.datasource_id=? FOR UPDATE OF t,d`,
            [userId, userId, tableId, datasourceId]
        );
        if (!rows.length) throw new NotFoundException('数据表不存在');
        const row = rows[0];
        if (!row.accessible || (row.owner !== userId && row.created_by !== userId)) throw new ForbiddenException('仅数据源创建者或表上传人可增强和编辑注释');
        return row as TableIdentity;
    }
    private async columns(tx: TransactionConnection, table: TableIdentity): Promise<SchemaColumnComment[]> {
        const [rows] = await tx.query(
            `SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
            COALESCE(col_description(c.oid,a.attnum),'') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname=? AND c.relname=? AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
            [table.schema_name, table.table_name]
        );
        return rows as unknown as SchemaColumnComment[];
    }
    async inspect(datasourceId: number, tableId: number, userId: number) {
        return this.db.withTransaction(async (tx) => this.columns(tx, await this.table(tx, datasourceId, tableId, userId)));
    }
    async generate(datasourceId: number, tableId: number, userId: number, selected: unknown): Promise<SchemaEnrichmentResult> {
        if (!Array.isArray(selected) || !selected.length || selected.length > 100 || selected.some((s) => typeof s !== 'string') || new Set(selected).size !== selected.length)
            throw new BadRequestException('请选择 1–100 个不重复字段');
        const context = await this.db.withTransaction(async (tx) => {
            const table = await this.table(tx, datasourceId, tableId, userId);
            const columns = await this.columns(tx, table);
            if (selected.some((name) => !columns.some((c) => c.name === name))) throw new BadRequestException('字段不存在');
            const [policies] = await tx.query('SELECT column_name FROM datasource_column_policy WHERE datasource_id=? AND schema_name=? AND table_name=? AND agent_access<>?', [
                datasourceId,
                table.schema_name,
                table.table_name,
                'allow',
            ]);
            const restricted = new Set(policies.map((p) => p.column_name));
            const sampleColumns = selected.filter((name) => !restricted.has(name));
            // Bound each sampled cell at the database boundary. Restricted field values are never sent to the model.
            const sampleCellLimit = Math.max(24, Math.min(300, Math.floor(12000 / Math.max(1, sampleColumns.length * 5))));
            const [samples] = sampleColumns.length
                ? await tx.queryNative(
                      `SELECT ${sampleColumns.map((name) => `LEFT(${quoteIdentifier(name)}::text,${sampleCellLimit}) AS ${quoteIdentifier(name)}`).join(',')} FROM ${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)} LIMIT 5`
                  )
                : [[]];
            return { columns: columns.filter((c) => selected.includes(c.name)), samples };
        });
        const raw = await this.llm.chat(
            ENRICHMENT_PROMPT,
            JSON.stringify({ ...context, columns: context.columns.map((c) => ({ ...c, comment: c.comment.slice(0, 200), commentTruncated: c.comment.length > 200 })) }),
            0
        );
        // Permission may have changed while the model was running.
        await this.inspect(datasourceId, tableId, userId);
        return { columns: context.columns, suggestions: parseEnrichments(raw, selected), prompt: PROMPT_METADATA.enrichment };
    }
    async save(datasourceId: number, tableId: number, userId: number, value: unknown): Promise<SchemaColumnComment[]> {
        const changes = validateCommentChanges(value);
        const result = await this.db.withTransaction(async (tx) => {
            const table = await this.table(tx, datasourceId, tableId, userId);
            await tx.executeNative(`LOCK TABLE ${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)} IN SHARE UPDATE EXCLUSIVE MODE`);
            const columns = await this.columns(tx, table);
            for (const change of changes) {
                const column = columns.find((c) => c.name === change.column);
                if (!column) throw new ConflictException(`字段 ${change.column} 已删除，请重新打开审核`);
                if (column.comment !== change.originalComment) throw new ConflictException(`字段 ${change.column} 的正式注释已变化，请刷新原注释后重新核对；你的编辑尚未保存`);
            }
            for (const change of changes) {
                // COMMENT does not accept bind parameters. Server-side format safely quotes both identifiers and literal.
                const [sql] = await tx.query("SELECT format('COMMENT ON COLUMN %I.%I.%I IS %L',?::text,?::text,?::text,?::text) AS statement", [
                    table.schema_name,
                    table.table_name,
                    change.column,
                    change.comment,
                ]);
                await tx.executeNative(String(sql[0].statement));
            }
            await tx.execute('DELETE FROM datasource_suggestions WHERE datasource_id=?', [datasourceId]);
            return this.columns(tx, table);
        });
        this.schema.clearDatasourceCache(datasourceId);
        return result;
    }
}
