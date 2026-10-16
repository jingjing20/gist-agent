import { assertCurrentSchema } from './schema';
import { agentDatabaseConfig, databaseConfig, type DatabaseConfig } from '@gist/config';
import { Pool, type PoolClient, type QueryResult } from 'pg';

export type QueryRow = Record<string, any>;
export interface ExecuteResult {
    insertId: number;
    rowCount: number;
    rows: QueryRow[];
}

export interface QueryFieldMetadata {
    name: string;
    dataTypeID: number;
}

export interface DetailedQueryResult<T extends QueryRow[] = QueryRow[]> {
    rows: T;
    fields: QueryFieldMetadata[];
}

export type TableSourceType = 'preset' | 'uploaded' | 'external';

export interface DataSourceTableCatalogEntry extends QueryRow {
    id: number;
    datasource_id: number;
    schema_name: string;
    table_name: string;
    display_name: string;
    description: string | null;
    source_type: TableSourceType;
    is_agent_visible: boolean;
    created_by: number | null;
    created_at: string;
}

interface CatalogQueryable {
    query<T extends QueryRow[] = QueryRow[]>(sql: string, params?: unknown[]): Promise<T>;
}

/** Resolve the selected datasource, defaulting to the built-in local datasource. */
export async function resolveCatalogDatasourceId(db: CatalogQueryable, datasourceId: number | null): Promise<number | null> {
    if (datasourceId != null) return datasourceId;
    const rows = await db.query<QueryRow[]>('SELECT id FROM data_source WHERE is_local = 1 LIMIT 1');
    return rows.length > 0 ? Number(rows[0].id) : null;
}

/** The catalog is the sole authority for tables that an agent may inspect or query. */
export async function getAgentVisibleCatalogTables(db: CatalogQueryable, datasourceId: number | null): Promise<DataSourceTableCatalogEntry[]> {
    const resolvedId = await resolveCatalogDatasourceId(db, datasourceId);
    if (resolvedId == null) return [];
    return db.query<DataSourceTableCatalogEntry[]>(
        `SELECT id, datasource_id, schema_name, table_name, display_name, description,
            source_type, is_agent_visible, created_by, created_at
       FROM datasource_table_catalog
      WHERE datasource_id = ? AND schema_name = current_schema() AND is_agent_visible = TRUE
      ORDER BY id`,
        [resolvedId]
    );
}

export class DatabaseClient {
    private readonly pool: Pool;
    private readonly agentPool: Pool;

    constructor(configuration: DatabaseConfig = databaseConfig()) {
        this.pool = new Pool(configuration);
        this.agentPool = new Pool(agentDatabaseConfig());
    }

    async connect(): Promise<void> {
        await this.pool.query('SELECT 1');
        await assertCurrentSchema(this);
    }
    async close(): Promise<void> {
        await Promise.all([this.pool.end(), this.agentPool.end()]);
    }
    async getPool(_datasourceId?: number | null): Promise<Pool> {
        return this.pool;
    }

    async query<T extends QueryRow[] = QueryRow[]>(sql: string, params: unknown[] = [], _datasourceId?: number | null): Promise<T> {
        return (await this.pool.query(params.length ? normalizeSql(sql) : sql, params)).rows as T;
    }

    async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
        return resultOf(await this.pool.query(params.length ? normalizeSql(sql) : sql, params));
    }

    async queryReadOnly<T extends QueryRow[] = QueryRow[]>(
        sql: string,
        params: unknown[] = [],
        _datasourceId?: number | null,
        options: { timeoutMs?: number; signal?: AbortSignal } = {}
    ): Promise<T> {
        const client = await this.agentPool.connect();
        const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 15_000));
        let backendPid: number | null = null;
        const cancel = () => {
            if (backendPid != null) void this.agentPool.query('SELECT pg_cancel_backend($1)', [backendPid]).catch(() => undefined);
        };
        if (options.signal?.aborted) {
            client.release();
            throw options.signal.reason instanceof Error ? options.signal.reason : new Error('已取消');
        }
        options.signal?.addEventListener('abort', cancel, { once: true });
        try {
            await client.query('BEGIN READ ONLY');
            await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
            backendPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
            if (options.signal?.aborted) cancel();
            return (await client.query(params.length ? normalizeSql(sql) : sql, params)).rows as T;
        } catch (error) {
            if (options.signal?.aborted) {
                throw options.signal.reason instanceof Error ? options.signal.reason : new Error('已取消');
            }
            throw error;
        } finally {
            options.signal?.removeEventListener('abort', cancel);
            await client.query('ROLLBACK').catch(() => undefined);
            client.release();
        }
    }

    async queryReadOnlyWithFields<T extends QueryRow[] = QueryRow[]>(
        sql: string,
        params: unknown[] = [],
        _datasourceId?: number | null,
        options: { timeoutMs?: number; signal?: AbortSignal } = {}
    ): Promise<DetailedQueryResult<T>> {
        const client = await this.agentPool.connect();
        const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 15_000));
        let backendPid: number | null = null;
        const cancel = () => {
            if (backendPid != null) void this.agentPool.query('SELECT pg_cancel_backend($1)', [backendPid]).catch(() => undefined);
        };
        if (options.signal?.aborted) {
            client.release();
            throw options.signal.reason instanceof Error ? options.signal.reason : new Error('已取消');
        }
        options.signal?.addEventListener('abort', cancel, { once: true });
        try {
            await client.query('BEGIN READ ONLY');
            await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
            backendPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
            if (options.signal?.aborted) cancel();
            const result = await client.query(params.length ? normalizeSql(sql) : sql, params);
            return {
                rows: result.rows as T,
                fields: result.fields.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID })),
            };
        } catch (error) {
            if (options.signal?.aborted) {
                throw options.signal.reason instanceof Error ? options.signal.reason : new Error('已取消');
            }
            throw error;
        } finally {
            options.signal?.removeEventListener('abort', cancel);
            await client.query('ROLLBACK').catch(() => undefined);
            client.release();
        }
    }

    async withTransaction<T>(worker: (connection: TransactionConnection) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const value = await worker(new TransactionConnection(client));
            await client.query('COMMIT');
            return value;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}

export class TransactionConnection {
    constructor(private readonly client: PoolClient) {}
    async query<T extends QueryRow[] = QueryRow[]>(sql: string, params: unknown[] = []): Promise<[T]> {
        return [(await this.client.query(params.length ? normalizeSql(sql) : sql, params)).rows as T];
    }
    /** Native PostgreSQL SELECT, preserving question marks in quoted identifiers. */
    async queryNative<T extends QueryRow[] = QueryRow[]>(sql: string): Promise<[T]> {
        return [(await this.client.query(sql)).rows as T];
    }
    /** PostgreSQL-native statement: no question-mark placeholder rewriting (e.g. COMMENT literals). */
    async executeNative(sql: string): Promise<ExecuteResult> {
        return resultOf(await this.client.query(sql));
    }
    async execute(sql: string, params: unknown[] = []): Promise<[ExecuteResult]> {
        return [resultOf(await this.client.query(params.length ? normalizeSql(sql) : sql, params))];
    }
}

function resultOf(result: QueryResult): ExecuteResult {
    return { insertId: Number((result.rows[0] as QueryRow | undefined)?.id ?? 0), rowCount: result.rowCount ?? 0, rows: result.rows };
}

export function normalizeSql(sql: string): string {
    let output = '',
        parameter = 0,
        index = 0;
    while (index < sql.length) {
        const char = sql[index];
        if (char === "'" || char === '"') {
            const quote = char;
            const escaped = quote === "'" && /(?:^|[^\w])e$/i.test(sql.slice(0, index));
            output += char;
            index++;
            while (index < sql.length) {
                const next = sql[index++];
                output += next;
                if (escaped && next === '\\' && index < sql.length) output += sql[index++];
                else if (next === quote) {
                    if (sql[index] === quote) output += sql[index++];
                    else break;
                }
            }
        } else if (sql.startsWith('--', index)) {
            const end = sql.indexOf('\n', index);
            output += sql.slice(index, end < 0 ? sql.length : end);
            index = end < 0 ? sql.length : end;
        } else if (sql.startsWith('/*', index)) {
            let depth = 1;
            output += '/*';
            index += 2;
            while (index < sql.length && depth) {
                if (sql.startsWith('/*', index)) {
                    depth++;
                    output += '/*';
                    index += 2;
                } else if (sql.startsWith('*/', index)) {
                    depth--;
                    output += '*/';
                    index += 2;
                } else output += sql[index++];
            }
        } else if (char === '$' && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(index))) {
            const tag = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)![0];
            const end = sql.indexOf(tag, index + tag.length);
            const stop = end < 0 ? sql.length : end + tag.length;
            output += sql.slice(index, stop);
            index = stop;
        } else if (char === '?' && !['|', '&'].includes(sql[index + 1])) {
            output += `$${++parameter}`;
            index++;
        } else output += sql[index++];
    }
    return output;
}

export * from './memory-schema';
export * from './memory-repository';
export * from './memory-policy';
export * from './analysis-state-schema';

export * from './schema';

/** Quote a PostgreSQL identifier, including embedded double quotes. */
export function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

export * from './schema-access';
export * from './generation-events';
