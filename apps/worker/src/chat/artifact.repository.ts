import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import type {
    ArtifactColumnV1,
    ArtifactSortV1,
    ChartArtifactV1,
    ChartFieldV1,
    ChartType,
    QueryArtifactResultV1,
    QueryArtifactV1,
    QueryPlanV1,
    ResultQualityV1,
} from '@gist/contracts';
import { resolveCatalogDatasourceId } from '@gist/database';
import { DatabaseService, type QueryRow } from '../database/database.service';
import { GenerationExecutionError } from './generation-errors';

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

interface CreateQueryArtifactInput {
    analysisContext?: import('@gist/contracts').AnalysisEvidenceContext;
    writerToken?: string;
    generationId: string;
    userId: number;
    conversationId: string;
    datasourceId: number | null;
    title: string;
    plan: QueryPlanV1;
    originalSql: string;
    executedSql: string;
    schemaContextVersion: string;
    columns: ArtifactColumnV1[];
    rows: Array<Record<string, unknown>>;
    returnedRowCount: number;
    totalRowCount?: number;
    isLimited: boolean;
    resultQuality?: ResultQualityV1;
}

interface CreateChartArtifactInput {
    writerToken?: string;
    generationId: string;
    userId: number;
    conversationId: string;
    queryArtifactId: string;
    chartType: ChartType;
    title: string;
    xField: string;
    yFields: ChartFieldV1[];
    sort?: ArtifactSortV1[];
}

@Injectable()
export class ArtifactRepository {
    constructor(private readonly db: DatabaseService) {}

    async createQueryArtifact(input: CreateQueryArtifactInput): Promise<QueryArtifactV1> {
        const datasourceId = await resolveCatalogDatasourceId(this.db, input.datasourceId);
        if (datasourceId == null) throw new GenerationExecutionError('ARTIFACT_ACCESS_DENIED', '无法解析查询所使用的数据源');
        const canonicalRows = stableStringify(input.rows);
        if (Buffer.byteLength(canonicalRows, 'utf8') > MAX_ARTIFACT_BYTES) {
            throw new GenerationExecutionError('ARTIFACT_RESULT_TOO_LARGE', '查询结果超过 5 MiB，请缩小字段、时间范围或聚合粒度');
        }
        const id = randomUUID();
        const hash = createHash('sha256').update(canonicalRows).digest('hex');
        const rows = await this.writeArtifact(
            input,
            `INSERT INTO query_artifact (
                id,generation_id,user_id,conversation_id,datasource_id,title,purpose,expected_grain,expected_shape,
                original_sql,executed_sql,schema_context_version,columns_json,result_rows,returned_row_count,
                total_row_count,is_limited,result_content_hash,result_quality,analysis_context
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?::jsonb,?,?,?,?,?::jsonb,?::jsonb)
             RETURNING created_at,expires_at`,
            [
                id,
                input.generationId,
                input.userId,
                input.conversationId,
                datasourceId,
                input.title,
                input.plan.purpose,
                input.plan.expectedGrain,
                input.plan.expectedShape,
                input.originalSql,
                input.executedSql,
                input.schemaContextVersion,
                JSON.stringify(input.columns),
                canonicalRows,
                input.returnedRowCount,
                input.totalRowCount ?? null,
                input.isLimited,
                hash,
                JSON.stringify(input.resultQuality ?? null),
                JSON.stringify(input.analysisContext ?? null),
            ]
        );
        return {
            id,
            ...(input.analysisContext ? { analysisContext: input.analysisContext } : {}),
            generationId: input.generationId,
            userId: input.userId,
            conversationId: input.conversationId,
            datasourceId,
            title: input.title,
            plan: input.plan,
            originalSql: input.originalSql,
            executedSql: input.executedSql,
            schemaContextVersion: input.schemaContextVersion,
            columns: input.columns,
            returnedRowCount: input.returnedRowCount,
            ...(input.totalRowCount === undefined ? {} : { totalRowCount: input.totalRowCount }),
            isLimited: input.isLimited,
            ...(input.resultQuality ? { resultQuality: input.resultQuality } : {}),
            resultContentHash: hash,
            createdAt: toIso(rows[0].created_at),
            ...(rows[0].expires_at ? { expiresAt: toIso(rows[0].expires_at) } : {}),
        };
    }

    async readQueryArtifact(id: string, userId: number, conversationId: string, rowLimit?: number, offset = 0): Promise<QueryArtifactResultV1> {
        const rows = await this.db.query<QueryRow[]>('SELECT * FROM query_artifact WHERE id=?', [id]);
        if (!rows.length) throw new GenerationExecutionError('ARTIFACT_NOT_FOUND', '查询证据不存在或已删除');
        const row = rows[0];
        if (Number(row.user_id) !== userId || row.conversation_id !== conversationId || !(await this.canAccessDatasource(Number(row.datasource_id), userId))) {
            throw new GenerationExecutionError('ARTIFACT_ACCESS_DENIED', '无权读取该查询证据');
        }
        if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
            throw new GenerationExecutionError('ARTIFACT_NOT_FOUND', '查询证据已过期');
        }
        const resultRows = row.result_rows as Array<Record<string, unknown>>;
        return {
            artifact: this.mapQueryArtifact(row),
            rows: rowLimit == null ? resultRows : resultRows.slice(offset, offset + Math.max(0, rowLimit)),
        };
    }

    async listAnalysisEvidence(userId: number, conversationId: string, datasourceId: number, offset = 0) {
        if (!(await this.canAccessDatasource(datasourceId, userId))) throw new GenerationExecutionError('ARTIFACT_ACCESS_DENIED', '无权读取证据目录');
        const rows = await this.db.query(
            `SELECT a.id,a.title,a.created_at,a.analysis_context->'state'->>'revision' AS revision FROM query_artifact a
         JOIN conversation_turn t ON t.generation_id=a.generation_id WHERE a.user_id=? AND a.conversation_id=? AND a.datasource_id=?
         AND a.analysis_context IS NOT NULL AND t.status='completed' ORDER BY a.created_at DESC,a.id LIMIT 21 OFFSET ?`,
            [userId, conversationId, datasourceId, offset]
        );
        return { items: rows.slice(0, 20), nextOffset: rows.length > 20 ? offset + 20 : null };
    }

    async assertUsableInGeneration(artifact: QueryArtifactV1, currentGenerationId: string): Promise<void> {
        if (artifact.generationId === currentGenerationId) return;
        const rows = await this.db.query<QueryRow[]>(
            `SELECT 1
               FROM conversation_turn
              WHERE generation_id=? AND conversation_id=? AND status='completed'
              LIMIT 1`,
            [artifact.generationId, artifact.conversationId]
        );
        if (!rows.length) {
            throw new GenerationExecutionError('ARTIFACT_ACCESS_DENIED', '只能复用当前 generation 或历史 completed Turn 的查询证据');
        }
    }

    async createChartArtifact(input: CreateChartArtifactInput, datasourceId: number): Promise<ChartArtifactV1> {
        const id = randomUUID();
        const rows = await this.writeArtifact(
            input,
            `INSERT INTO chart_artifact (
                id,generation_id,query_artifact_id,user_id,conversation_id,datasource_id,
                chart_type,title,x_field,y_fields,sort
             ) VALUES (?,?,?,?,?,?,?,?,?,?::jsonb,?::jsonb)
             RETURNING created_at`,
            [
                id,
                input.generationId,
                input.queryArtifactId,
                input.userId,
                input.conversationId,
                datasourceId,
                input.chartType,
                input.title,
                input.xField,
                JSON.stringify(input.yFields),
                input.sort ? JSON.stringify(input.sort) : null,
            ]
        );
        return {
            id,
            generationId: input.generationId,
            queryArtifactId: input.queryArtifactId,
            chartType: input.chartType,
            title: input.title,
            xField: input.xField,
            yFields: input.yFields,
            ...(input.sort ? { sort: input.sort } : {}),
            createdAt: toIso(rows[0].created_at),
        };
    }

    /** Serialize new-core evidence writes with cancellation/finalization on the generation row. */
    private async writeArtifact(
        input: { generationId: string; userId: number; conversationId: string; writerToken?: string },
        sql: string,
        params: unknown[]
    ): Promise<QueryRow[]> {
        if (!input.writerToken) return this.db.query<QueryRow[]>(sql, params);
        return this.db.withTransaction(async (tx) => {
            const [owned] = await tx.query<QueryRow[]>(
                "SELECT 1 FROM generation WHERE id=? AND user_id=? AND conversation_id=? AND writer_token=? AND status IN ('starting','running') FOR UPDATE",
                [input.generationId, input.userId, input.conversationId, input.writerToken]
            );
            if (!owned.length) throw new GenerationExecutionError('WRITER_OWNERSHIP_LOST', '任务已停止，不能保存证据');
            const [rows] = await tx.query<QueryRow[]>(sql, params);
            return rows;
        });
    }

    private async canAccessDatasource(datasourceId: number, userId: number): Promise<boolean> {
        const rows = await this.db.query<QueryRow[]>(
            `SELECT 1
               FROM data_source d
               LEFT JOIN datasource_permission p ON p.datasource_id=d.id AND p.user_id=?
              WHERE d.id=? AND (d.created_by IS NULL OR d.created_by=? OR p.user_id IS NOT NULL)`,
            [userId, datasourceId, userId]
        );
        return rows.length > 0;
    }

    private mapQueryArtifact(row: QueryRow): QueryArtifactV1 {
        return {
            id: row.id,
            ...(row.analysis_context ? { analysisContext: row.analysis_context } : {}),
            generationId: row.generation_id,
            userId: Number(row.user_id),
            conversationId: row.conversation_id,
            datasourceId: Number(row.datasource_id),
            title: row.title,
            plan: { purpose: row.purpose, expectedGrain: row.expected_grain, expectedShape: row.expected_shape },
            originalSql: row.original_sql,
            executedSql: row.executed_sql,
            schemaContextVersion: row.schema_context_version,
            columns: row.columns_json as ArtifactColumnV1[],
            returnedRowCount: Number(row.returned_row_count),
            ...(row.total_row_count == null ? {} : { totalRowCount: Number(row.total_row_count) }),
            isLimited: row.is_limited === true,
            ...(row.result_quality ? { resultQuality: row.result_quality as ResultQualityV1 } : {}),
            resultContentHash: row.result_content_hash,
            createdAt: toIso(row.created_at),
            ...(row.expires_at ? { expiresAt: toIso(row.expires_at) } : {}),
        };
    }
}

export function stableStringify(value: unknown): string {
    return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, sortValue(item)])
        );
    }
    if (value instanceof Date) return value.toISOString();
    return value;
}

function toIso(value: unknown): string {
    return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
