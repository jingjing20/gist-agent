import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { SchemaService } from '../../database/schema.service';
import { QueryRow as RowDataPacket } from '../../database/database.service';
import { Parser } from 'node-sql-parser';
import type { ArtifactColumnV1 } from '@gist/contracts';
import type { DetailedQueryResult, QueryFieldMetadata } from '@gist/database';
import { GenerationExecutionError } from '../generation-errors';
import { createHash } from 'crypto';
import type { AgentColumnPolicy } from '../../database/schema.service';

// Bound every result with an outer LIMIT, including queries with an existing LIMIT or UNION.
const MAX_ROWS = 1000;

export interface QueryResult {
    finalSql: string;
    columns: ArtifactColumnV1[];
    rows: Record<string, unknown>[];
    rowCount: number;
    isLimited: boolean;
    sourceTables: string[];
    sourceFields: string[];
}

@Injectable()
export class SqlExecutor {
    constructor(
        private readonly db: DatabaseService,
        private readonly schemaService: SchemaService
    ) {}

    private async queryWithTimeout(sql: string, datasourceId?: number | null, timeoutMs = 15000, signal?: AbortSignal): Promise<DetailedQueryResult<RowDataPacket[]>> {
        const database = this.db as DatabaseService & {
            queryReadOnlyWithFields<R extends RowDataPacket[]>(
                statement: string,
                params: unknown[],
                selectedDatasourceId: number | null | undefined,
                options: { timeoutMs: number; signal?: AbortSignal }
            ): Promise<DetailedQueryResult<R>>;
        };
        return database.queryReadOnlyWithFields<RowDataPacket[]>(sql, [], datasourceId, { timeoutMs, signal });
    }

    /**
     * 防线一：AST 级白名单校验。
     * 将 SQL 解析为 AST 后逐节点检查语句类型，仅放行只读操作。
     * 为什么用 AST 而不是正则：正则无法处理子查询、CTE、注释注入等绕过手段
     */
    validate(
        sql: string,
        allowedTables: string[] | 'ALL' = 'ALL',
        columnPolicies: AgentColumnPolicy[] = []
    ): { astResult: any; parser: Parser; outputMasks: Map<string, AgentColumnPolicy> } {
        const parser = new Parser();
        let astResult;
        try {
            astResult = parser.parse(sql, { database: 'Postgresql' });
        } catch (error: any) {
            const line = error.location?.start?.line;
            const column = error.location?.start?.column;
            throw new GenerationExecutionError(
                'SQL_VALIDATION_FAILED',
                `SQL 解析器无法识别${line ? `第 ${line} 行、第 ${column} 列附近的` : ''}语法。请使用双引号包裹列别名（如 AS \"nulls\"），或改写为更简单的 PostgreSQL SELECT；未执行此查询。`
            );
        }

        // parser.ast 在单条查询时是对象，多条拼接（分号隔开等情况）时是数组
        const astList = Array.isArray(astResult.ast) ? astResult.ast : [astResult.ast];
        if (astList.length !== 1) throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '仅允许执行单条 SELECT 查询');

        for (const node of astList) {
            const type = (node.type || '').toLowerCase();
            if (type !== 'select') throw new GenerationExecutionError('SQL_SECURITY_REJECTED', `仅允许 SELECT，拒绝 [${type || 'unknown'}] 操作`);
        }

        const forbiddenFunctions = new Set([
            'pg_read_file',
            'pg_read_binary_file',
            'pg_ls_dir',
            'pg_stat_file',
            'dblink',
            'dblink_exec',
            'lo_import',
            'lo_export',
            'copy',
            'set_config',
            'current_setting',
            'pg_terminate_backend',
            'pg_cancel_backend',
            'pg_advisory_lock',
            'pg_advisory_xact_lock',
        ]);
        const rejectForbiddenFunctions = (value: any): void => {
            if (!value || typeof value !== 'object') return;
            if (value.type === 'function' || value.type === 'aggr_func') {
                const name = typeof value.name === 'string' ? value.name : value.name?.name?.at(-1)?.value;
                if (name && forbiddenFunctions.has(String(name).toLowerCase())) {
                    throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '查询包含禁止的数据库函数');
                }
            }
            for (const item of Object.values(value)) {
                if (Array.isArray(item)) item.forEach(rejectForbiddenFunctions);
                else rejectForbiddenFunctions(item);
            }
        };
        rejectForbiddenFunctions(astResult.ast);

        if (allowedTables !== 'ALL') this.validateTableScopes(astResult.ast, new Set(allowedTables));
        const tables = new Set((astResult.tableList as string[]).map((ref) => ref.split('::').at(-1)!.replace(/["`]/g, '').toLowerCase()));
        const restricted = columnPolicies.filter((p) => p.access !== 'allow' && tables.has(p.tableName.toLowerCase()));
        const restrictedRowAliases = new Set<string>();
        const collectRowAliases = (value: any): void => {
            if (!value || typeof value !== 'object') return;
            for (const from of value.from ?? []) {
                if (restricted.some((policy) => policy.tableName.toLowerCase() === String(from.table || '').toLowerCase())) {
                    restrictedRowAliases.add(String(from.as || from.table).toLowerCase());
                }
            }
            for (const item of Object.values(value)) {
                if (Array.isArray(item)) item.forEach(collectRowAliases);
                else collectRowAliases(item);
            }
        };
        collectRowAliases(astResult.ast);
        const referencedPolicies = (astResult.columnList as string[]).flatMap((ref) => {
            const parts = ref.split('::').map((part) => part.replace(/["`]/g, '').toLowerCase());
            const name = parts.at(-1)!;
            const table = parts.at(-2);
            if (name === '*' || name === '(.*)') {
                if (restricted.some((policy) => !table || table === 'null' || !tables.has(table) || policy.tableName.toLowerCase() === table))
                    throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '存在受限字段时请显式列出允许的字段');
                return [];
            }
            if ((!table || table === 'null') && restrictedRowAliases.has(name)) {
                throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '受限数据表不能作为整行对象返回或参与函数');
            }
            return restricted.filter((p) => p.columnName.toLowerCase() === name && (!table || table === 'null' || !tables.has(table) || p.tableName.toLowerCase() === table));
        });
        if (referencedPolicies.some((p) => p.access === 'deny')) {
            throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '查询引用了不允许访问的字段');
        }
        const masks = referencedPolicies.filter((p) => p.access === 'mask');
        const outputMasks = new Map<string, AgentColumnPolicy>();
        if (masks.length) {
            const node: any = astList[0];
            // Derived expressions can reveal raw values through predicates, aggregates or aliases.
            // Permit masked values only as direct columns of a single plain SELECT.
            if (node.with?.length || node._next || node.distinct?.type || node.groupby || node.window || (node.from ?? []).some((f: any) => f.expr)) {
                throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '脱敏字段仅支持直接查询，不能用于派生查询或去重');
            }
            const aliases = new Map<string, string>((node.from ?? []).map((f: any) => [String(f.as || f.table).toLowerCase(), String(f.table).toLowerCase()]));
            const policyFor = (ref: any) => {
                const name = this.columnName(ref.column).toLowerCase();
                const table = ref.table ? aliases.get(String(ref.table).toLowerCase()) : null;
                const policies = masks.filter((p) => p.columnName.toLowerCase() === name && (!table || p.tableName.toLowerCase() === table));
                if (policies.length > 1) throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '脱敏字段必须明确指定所属表');
                return policies[0];
            };
            const containsMask = (value: any): boolean => {
                if (!value || typeof value !== 'object') return false;
                if (value.type === 'column_ref' && policyFor(value)) return true;
                return Object.values(value).some((item) => (Array.isArray(item) ? item.some(containsMask) : containsMask(item)));
            };
            for (const col of node.columns ?? []) {
                if (!containsMask(col.expr)) continue;
                if (col.expr.type !== 'column_ref') throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '脱敏字段不能参与表达式或聚合');
                const policy = policyFor(col.expr)!;
                const outputName = String(col.as || this.columnName(col.expr.column));
                outputMasks.set(outputName, policy);
            }
            const clauses = [node.where, node.having, node.groupby, node.orderby, node.window, ...(node.from ?? []).map((f: any) => f.on)];
            const maskedAliases = new Set([...outputMasks.keys()].map((name) => name.toLowerCase()));
            const containsAlias = (value: any): boolean => {
                if (!value || typeof value !== 'object') return false;
                if (value.type === 'column_ref' && !value.table && maskedAliases.has(this.columnName(value.column).toLowerCase())) return true;
                return Object.values(value).some((item) => (Array.isArray(item) ? item.some(containsAlias) : containsAlias(item)));
            };
            const maskedPositions = new Set((node.columns ?? []).flatMap((col: any, index: number) => (containsMask(col.expr) ? [index + 1] : [])));
            const ordersByMaskedPosition = (node.orderby ?? []).some((order: any) => order.expr?.type === 'number' && maskedPositions.has(Number(order.expr.value)));
            if (ordersByMaskedPosition || clauses.some((clause) => containsMask(clause) || containsAlias(clause))) {
                throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '脱敏字段不能用于筛选、排序、分组或关联');
            }
        }
        return { astResult, parser, outputMasks };
    }

    private columnName(column: any): string {
        return typeof column === 'string' ? column : String(column?.expr?.value ?? column?.value ?? '');
    }

    private validateTableScopes(value: any, allowed: Set<string>, inherited = new Set<string>()): void {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            for (const item of value) this.validateTableScopes(item, allowed, inherited);
            return;
        }
        if (value.type !== 'select') {
            if (['insert', 'update', 'delete'].includes(value.type)) throw new GenerationExecutionError('SQL_SECURITY_REJECTED', 'CTE 和子查询只允许 SELECT');
            for (const item of Object.values(value)) this.validateTableScopes(item, allowed, inherited);
            return;
        }
        if (value.into?.expr || value.into?.type || value.locking_read) throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '不允许 SELECT 写入或锁定数据');
        const ctes = new Set(inherited);
        for (const cte of value.with ?? []) {
            this.validateTableScopes(cte.stmt, allowed, ctes);
            ctes.add(String(cte.name?.value ?? ''));
        }
        for (const from of value.from ?? []) {
            if (from.table) {
                const schema = String(from.db || '');
                const name = String(from.table);
                if (schema && schema !== 'public') throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '禁止访问其他 schema');
                if (!(!schema && ctes.has(name)) && !allowed.has(name)) throw new GenerationExecutionError('SQL_SECURITY_REJECTED', `表 [${name}] 不在当前数据源的允许范围内`);
            } else if (!from.expr) throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '无法确认数据表来源');
        }
        for (const [key, item] of Object.entries(value)) if (key !== 'with') this.validateTableScopes(item, allowed, ctes);
    }

    /** An outer LIMIT also bounds UNION, LIMIT ALL and user-supplied large limits. */
    ensureLimit(astResult: any, parser: Parser): string {
        const statement = parser.sqlify(astResult.ast, { database: 'Postgresql' }).replace(/;\s*$/, '');
        return `SELECT * FROM (${statement}) AS "__gist_result" LIMIT ${MAX_ROWS}`;
    }

    /** One deterministic attempt. SQL errors return to the main Agent for visible correction. */
    async execute(sql: string, datasourceId?: number | null, userId?: number, signal?: AbortSignal): Promise<QueryResult> {
        if (!userId) throw new GenerationExecutionError('DATASOURCE_ACCESS_CHANGED', '缺少用户身份，拒绝执行数据查询');
        let allowedTables: string[];
        let columnPolicies: AgentColumnPolicy[];
        try {
            allowedTables = await this.schemaService.getAllowedTableNames(datasourceId || null, userId);
            columnPolicies = await this.schemaService.getColumnPolicies(datasourceId || null, userId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.startsWith('DATASOURCE_ACCESS_CHANGED:')) {
                throw new GenerationExecutionError('DATASOURCE_ACCESS_CHANGED', message.replace(/^DATASOURCE_ACCESS_CHANGED:\s*/, ''));
            }
            throw error;
        }

        if (signal?.aborted) throw signal.reason ?? new GenerationExecutionError('CANCELLED', '已取消');
        const { astResult, parser, outputMasks } = this.validate(sql, allowedTables, columnPolicies);
        let safeSql: string;
        try {
            safeSql = this.ensureLimit(astResult, parser);
        } catch {
            throw new GenerationExecutionError('SQL_VALIDATION_FAILED', 'SQL 无法规范化为安全的只读查询，请简化 PostgreSQL 表达式后重试；未执行此查询。');
        }
        const detailed = await this.queryWithTimeout(safeSql, datasourceId, 15000, signal);
        const normalized = this.normalizeRows(detailed.rows as Record<string, unknown>[], detailed.fields);
        this.applyColumnMasks(normalized.rows, outputMasks);
        for (const column of normalized.columns) if (outputMasks.has(column.name)) column.type = 'string';
        const limit = this.extractLimit(safeSql);
        const sourceTables = [...new Set((astResult.tableList as string[]).map((item) => this.cleanAstReference(item)).filter(Boolean))];
        const sourceFields = [...new Set((astResult.columnList as string[]).map((item) => this.cleanAstReference(item)).filter((item) => item && item !== '*'))];
        return {
            finalSql: safeSql,
            columns: normalized.columns,
            rows: normalized.rows,
            rowCount: normalized.rows.length,
            isLimited: limit !== null && normalized.rows.length >= limit,
            sourceTables,
            sourceFields,
        };
    }

    private cleanAstReference(value: string): string {
        const parts = value.split('::').map((item) => item.replace(/["`]/g, ''));
        const name = parts.at(-1);
        const qualifier = parts.at(-2);
        if (!name || name === 'null') return '';
        return qualifier && qualifier !== 'null' && !['select', 'where', 'groupby', 'orderby', 'having', 'join'].includes(qualifier.toLowerCase()) ? `${qualifier}.${name}` : name;
    }

    private extractLimit(sql: string): number | null {
        const match = sql.match(/\bLIMIT\s+(\d+)\b/i);
        return match ? Number(match[1]) : null;
    }

    private normalizeRows(rows: Record<string, unknown>[], fields: QueryFieldMetadata[]): { rows: Record<string, unknown>[]; columns: ArtifactColumnV1[] } {
        const normalizedRows = rows.map((row) => ({ ...row }));
        const columns = fields.map((field) => {
            const values = normalizedRows.map((row) => row[field.name]).filter((value) => value !== null && value !== undefined);
            const type = this.normalizeColumn(field.dataTypeID, values);
            if (type === 'number') {
                for (const row of normalizedRows) {
                    const value = row[field.name];
                    if (typeof value === 'string') row[field.name] = Number(value);
                }
            } else if (type === 'date') {
                for (const row of normalizedRows) {
                    const value = row[field.name];
                    if (value instanceof Date) row[field.name] = value.toISOString();
                }
            }
            return { name: field.name, type };
        });
        return { rows: normalizedRows, columns };
    }

    private normalizeColumn(dataTypeId: number, values: unknown[]): ArtifactColumnV1['type'] {
        if (dataTypeId === 16) return 'boolean';
        if ([1082, 1083, 1114, 1184, 1266].includes(dataTypeId)) return 'date';
        if ([20, 21, 23, 26, 700, 701, 1700].includes(dataTypeId)) {
            return values.every((value) => this.isLosslessNumber(value)) ? 'number' : 'unknown';
        }
        if ([18, 19, 25, 1042, 1043, 2950, 3802].includes(dataTypeId)) return 'string';
        if (values.every((value) => typeof value === 'number' && Number.isFinite(value))) return 'number';
        if (values.every((value) => typeof value === 'boolean')) return 'boolean';
        if (values.every((value) => typeof value === 'string')) return 'string';
        return 'unknown';
    }

    private isLosslessNumber(value: unknown): boolean {
        if (typeof value === 'number') return Number.isFinite(value);
        if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) return false;
        const input = value.trim();
        const numeric = Number(input);
        if (!Number.isFinite(numeric)) return false;
        if (/^[+-]?\d+$/.test(input)) {
            try {
                return Number.isSafeInteger(numeric) && BigInt(input) === BigInt(numeric);
            } catch {
                return false;
            }
        }
        const normalizedInput = input
            .replace(/^\+/, '')
            .replace(/^(-?)0+(?=\d)/, '$1')
            .replace(/(\.\d*?)0+$/, '$1')
            .replace(/\.$/, '');
        return String(numeric) === normalizedInput;
    }

    private applyColumnMasks(rows: Record<string, unknown>[], policies: Map<string, AgentColumnPolicy>): void {
        for (const row of rows) {
            for (const key of Object.keys(row)) {
                const policy = policies.get(key);
                const mask = policy?.maskType || (policy ? 'redact' : null);
                if (!mask || row[key] == null) continue;
                const value = String(row[key]);
                row[key] = mask === 'last4' ? `***${value.slice(-4)}` : mask === 'hash' ? createHash('sha256').update(value).digest('hex').slice(0, 12) : '[REDACTED]';
            }
        }
    }
}
