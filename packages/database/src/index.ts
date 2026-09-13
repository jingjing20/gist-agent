import { databaseConfig, type DatabaseConfig } from '@gist/config';
import { Pool, type PoolClient, type QueryResult } from 'pg';

export type QueryRow = Record<string, any>;
export interface ExecuteResult { insertId: number; rowCount: number; rows: QueryRow[] }

export class DatabaseClient {
  private readonly pool: Pool;

  constructor(configuration: DatabaseConfig = databaseConfig()) {
    this.pool = new Pool(configuration);
  }

  async connect(): Promise<void> { await this.pool.query('SELECT 1'); }
  async close(): Promise<void> { await this.pool.end(); }
  async getPool(_datasourceId?: number | null): Promise<Pool> { return this.pool; }

  async query<T extends QueryRow[] = QueryRow[]>(sql: string, params: unknown[] = [], _datasourceId?: number | null): Promise<T> {
    return (await this.pool.query(normalizeSql(sql), params)).rows as T;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    return resultOf(await this.pool.query(normalizeSql(sql), params));
  }

  async executeLoad(_sql: string, _streamFactory: (path: string) => NodeJS.ReadableStream): Promise<ExecuteResult> {
    throw new Error('PostgreSQL 使用批量 INSERT 导入数据');
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
    return [(await this.client.query(normalizeSql(sql), params)).rows as T];
  }
  async execute(sql: string, params: unknown[] = []): Promise<[ExecuteResult]> {
    return [resultOf(await this.client.query(normalizeSql(sql), params))];
  }
}

function resultOf(result: QueryResult): ExecuteResult {
  return { insertId: Number((result.rows[0] as QueryRow | undefined)?.id ?? 0), rowCount: result.rowCount ?? 0, rows: result.rows };
}

export function normalizeSql(sql: string): string {
  let parameter = 0;
  return sql
    .replace(/`([^`]+)`/g, '"$1"')
    .replace(/\b(FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\s+(?:"user"|user)(?=\s|$|[,;)])/gi, '$1 app_user')
    .replace(/\?/g, () => `$${++parameter}`);
}
