import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { SchemaService } from '../../database/schema.service';
import { LlmService } from '../../llm/llm.service';
import { QueryRow as RowDataPacket } from '../../database/database.service';
import { Parser } from 'node-sql-parser';
import type { ArtifactColumnV1 } from '@gist/contracts';
import type { DetailedQueryResult, QueryFieldMetadata } from '@gist/database';
import { GenerationExecutionError } from '../generation-errors';
import { createHash } from 'crypto';
import type { AgentColumnPolicy } from '../../database/schema.service';

// SQL 查询返回给前端的上限行数，通过 AST 注入 LIMIT 子句强制生效
const MAX_ROWS = 1000;

export interface QueryResult {
    finalSql: string;
    wasFixed: boolean;
    columns: ArtifactColumnV1[];
    rows: Record<string, unknown>[];
    rowCount: number;
    isLimited: boolean;
}

@Injectable()
export class SqlExecutorAgent {
    private readonly logger = new Logger(SqlExecutorAgent.name);

    constructor(
        private readonly db: DatabaseService,
        private readonly llm: LlmService,
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
    validate(sql: string, allowedTables: string[] | 'ALL' = 'ALL', columnPolicies: AgentColumnPolicy[] = []): { astResult: any; parser: Parser } {
        const parser = new Parser();
        let astResult;
        try {
            astResult = parser.parse(sql, { database: 'Postgresql' });
        } catch (error: any) {
            throw new GenerationExecutionError('SQL_SECURITY_REJECTED', `SQL 安全校验无法确认语法范围: ${error.message}`);
        }

        // parser.ast 在单条查询时是对象，多条拼接（分号隔开等情况）时是数组
        const astList = Array.isArray(astResult.ast) ? astResult.ast : [astResult.ast];
        if (astList.length !== 1) throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '仅允许执行单条 SELECT 查询');

        for (const node of astList) {
            const type = (node.type || '').toLowerCase();
            if (type !== 'select') throw new GenerationExecutionError('SQL_SECURITY_REJECTED', `仅允许 SELECT，拒绝 [${type || 'unknown'}] 操作`);
        }

        const forbiddenFunction = /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|dblink|lo_import|lo_export|copy|set_config|current_setting)\s*\(/i;
        if (forbiddenFunction.test(sql)) throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '查询包含禁止的数据库函数');

        if (allowedTables !== 'ALL') {
            let tables: string[];
            try {
                tables = parser.tableList(sql);
            } catch (error: any) {
                throw new GenerationExecutionError('SQL_SECURITY_REJECTED', `无法确认查询访问的表范围: ${error.message}`);
            }
            const allowed = new Set(allowedTables.map((table) => table.toLowerCase()));
            const cteNames = this.collectCteNames(astResult.ast);
            for (const tableStr of tables) {
                const parts = tableStr.split('::');
                if (parts.length < 3 || !parts[2]) throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '无法确认查询访问的表名');
                const schema = (parts[1] === 'null' ? '' : parts[1] || '').replace(/["`]/g, '').toLowerCase();
                const tableName = parts[2].replace(/["`]/g, '').toLowerCase();
                if (cteNames.has(tableName)) continue;
                if (schema && schema !== 'public') throw new GenerationExecutionError('SQL_SECURITY_REJECTED', `禁止访问 schema [${schema}]`);
                if (!allowed.has(tableName)) {
                    throw new GenerationExecutionError('SQL_SECURITY_REJECTED', `表 [${tableName}] 不在当前数据源的允许范围内`);
                }
            }
        }

        const denied = new Set(columnPolicies.filter((policy) => policy.access === 'deny').map((policy) => policy.columnName.toLowerCase()));
        if (denied.size) {
            if (/\bselect\s+(?:distinct\s+)?(?:[a-zA-Z_][\w]*\.)?\*/i.test(sql)) {
                throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '存在受限字段时禁止使用 SELECT *');
            }
            let columns: string[];
            try {
                columns = parser.columnList(sql);
            } catch (error: any) {
                throw new GenerationExecutionError('SQL_SECURITY_REJECTED', `无法确认查询访问的字段范围: ${error.message}`);
            }
            for (const columnRef of columns) {
                const name = columnRef.split('::').at(-1)?.replace(/["`]/g, '').toLowerCase();
                if (name === '*') throw new GenerationExecutionError('SQL_SECURITY_REJECTED', '存在受限字段时禁止使用 SELECT *');
                if (name && denied.has(name)) throw new GenerationExecutionError('SQL_SECURITY_REJECTED', `字段 [${name}] 不允许 Agent 访问`);
            }
        }

        return { astResult, parser };
    }

    /**
     * 防线二：自动注入 LIMIT。
     * 针对无 LIMIT 的 SELECT，通过 AST 修改注入 LIMIT 1000。
     * 最终统一 sqlify 输出，既注入了约束又规范化了 SQL 格式
     */
    ensureLimit(astResult: any, parser: Parser): string {
        const astList = Array.isArray(astResult.ast) ? astResult.ast : [astResult.ast];
        let modified = false;

        for (const node of astList) {
            if (node.type?.toLowerCase() === 'select') {
                if (!node.limit) {
                    // 注入 limit
                    node.limit = {
                        seperator: '',
                        value: [{ type: 'number', value: MAX_ROWS }],
                    };
                    modified = true;
                }
            }
        }

        if (modified) {
            return parser.sqlify(astResult.ast, { database: 'Postgresql' });
        }
        // 如果没修改（比如原本就有 limit 或者 不是 select 语句），我们也可以直接 sqlify
        // 但为了保持原有格式，返回原 sql（其实 AST 里没存原 SQL，需要外部传或者默认全 sqlify）
        // 我们直接无脑 sqlify，还能起到统一格式化的作用
        return parser.sqlify(astResult.ast, { database: 'Postgresql' });
    }

    /**
     * 核心决策点：区分"语法错误"和"语义错误"。
     * 语法错误 = LLM 的笔误，可由内部小模型静默修复。
     * 语义错误 = 表/字段不存在，需要完整 Schema，强行修复会编造字段导致数据灾难。
     * 设计原则：可修复的自动修，不可修复的暴露给上层
     */
    private isSyntaxError(error: any): boolean {
        if (!error || typeof error !== 'object') return false;

        // 核心原则：只拦截且只修复纯粹的“语法层面（Syntax/Dialect）”错误。
        // 严禁拦截语义层面（Semantic）错误，如 ER_NO_SUCH_TABLE, ER_BAD_FIELD_ERROR
        // 因为这些需要全量 Schema 上下文，强行修复会导致胡乱猜测字段，引发数据错误灾难。
        const syntaxErrorCodes = [
            'ER_PARSE_ERROR', // 1064 语法错误
            'ER_WRONG_FIELD_WITH_GROUP', // 1055 ONLY_FULL_GROUP_BY 限制
            'ER_MIX_OF_GROUP_FUNC_AND_FIELDS', // 1140 聚合与非聚合混用
            'ER_TOO_MANY_TABLES', // 连接太多表
            'ER_NON_UNIQ_ERROR', // 模糊的列引用
        ];

        return error.code && syntaxErrorCodes.includes(error.code);
    }

    private async attemptFixSql(originalSql: string, errorMessage: string): Promise<string> {
        const systemPrompt =
            `你是一个顶尖的 PostgreSQL 数据分析工程师。你的任务是修复一段报错的 SQL 语句。` +
            `由于你是在一个自动拦截防腐层内运行，你的上下文中没有完整的数据库 Schema。` +
            `因此，你 **绝不能** 随意猜测或编造表名、字段名，你只能仅就 SQL 的**语法层面**进行修复（例如修改 GROUP BY、修复标点符号、处理严格模式等）。\n\n` +
            `你 **必须且只能** 返回修复后的并且可以直接在 PostgreSQL 运行的纯 SQL 代码。\n` +
            `不要返回任何 markdown 格式（例如 \`\`\`sql），不要加任何解释，不要包含多余的话语。`;

        const userPrompt = `原始 SQL:\n${originalSql}\n\nPostgreSQL 报错信息:\n${errorMessage}`;

        const response = await this.llm.chat(systemPrompt, userPrompt, 0);
        // 清理可能的 markdown 后缀
        let cleanSql = response
            .replace(/```sql/i, '')
            .replace(/```/g, '')
            .trim();
        // 如果小模型还是习惯性地返回了包含 SELECT 之外的不相干文字，通过正则进一步保护
        return cleanSql;
    }

    /**
     * 公开入口：执行 SQL 并返回结构化结果。
     * 整合三道防线 + 自愈重试循环：
     *   validate() -> ensureLimit() -> queryWithTimeout()
     *   若语法错误 -> attemptFixSql() -> 重试 (max 2 次)
     *   若语义错误 -> 直接向上层暴露
     */
    async execute(sql: string, datasourceId?: number | null, userId?: number, signal?: AbortSignal): Promise<QueryResult> {
        const maxRetries = 2;
        let currentSql = sql;
        let attempt = 0;

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

        while (attempt <= maxRetries) {
            try {
                const { astResult, parser } = this.validate(currentSql, allowedTables, columnPolicies);
                const safeSql = this.ensureLimit(astResult, parser);

                const detailed = await this.queryWithTimeout(safeSql, datasourceId, 15000, signal);
                const rows = detailed.rows;

                const normalized = this.normalizeRows(rows as Record<string, unknown>[], detailed.fields);
                this.applyColumnMasks(normalized.rows, columnPolicies);
                const limit = this.extractLimit(safeSql);

                return {
                    finalSql: safeSql,
                    wasFixed: currentSql !== sql,
                    columns: normalized.columns,
                    rows: normalized.rows,
                    rowCount: normalized.rows.length,
                    isLimited: limit !== null && normalized.rows.length >= limit,
                };
            } catch (error: any) {
                attempt++;

                if (this.isSyntaxError(error) && attempt <= maxRetries) {
                    this.logger.warn(`检测到 SQL 语法错误 (${error.code})，正在启动内部小模型尝试修复 (第 ${attempt} 次尝试)...`);
                    try {
                        currentSql = await this.attemptFixSql(currentSql, error.message);
                        this.logger.log(`小模型自动修复完成，重试新 SQL: ${currentSql}`);
                        continue; // 进入下一次重试循环
                    } catch (fixError: any) {
                        this.logger.error(`小模型修复 SQL 失败: ${fixError.message}`);
                        throw error; // 如果修复过程本身报错（比如调 LLM 失败），依然抛出原始的 SQL 错误
                    }
                }

                // 1. 如果不是语法错误（比如表不存在，即语义错误）
                // 2. 或者已经达到了最大重试次数
                // 就直接向上一层大模型报错，绝不含糊
                this.logger.error(`SQL 执行异常，暴露错误给上层: ${error.message}`);
                throw error;
            }
        }

        throw new Error('超出最大 SQL 执行重试限制');
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

    private collectCteNames(value: unknown, names = new Set<string>()): Set<string> {
        if (!value || typeof value !== 'object') return names;
        if (Array.isArray(value)) {
            for (const item of value) this.collectCteNames(item, names);
            return names;
        }
        const record = value as Record<string, any>;
        if (Array.isArray(record.with)) {
            for (const item of record.with) {
                const name = item?.name?.value;
                if (typeof name === 'string') names.add(name.toLowerCase());
            }
        }
        for (const item of Object.values(record)) this.collectCteNames(item, names);
        return names;
    }

    private applyColumnMasks(rows: Record<string, unknown>[], policies: AgentColumnPolicy[]): void {
        const masks = new Map(policies.filter((policy) => policy.access === 'mask').map((policy) => [policy.columnName.toLowerCase(), policy.maskType || 'redact']));
        for (const row of rows) {
            for (const key of Object.keys(row)) {
                const mask = masks.get(key.toLowerCase());
                if (!mask || row[key] == null) continue;
                const value = String(row[key]);
                row[key] = mask === 'last4' ? `***${value.slice(-4)}` : mask === 'hash' ? createHash('sha256').update(value).digest('hex').slice(0, 12) : '[REDACTED]';
            }
        }
    }
}
