import { agentDatabaseConfig, databaseConfig, type DatabaseConfig } from '@gist/config';
import { Pool, type PoolClient, type QueryResult } from 'pg';

export const PHASE3_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_turn (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  generation_id UUID NOT NULL UNIQUE REFERENCES generation(id) ON DELETE CASCADE,
  user_message_id UUID NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  assistant_message_id UUID NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL CHECK(status IN ('pending','completed','failed','cancelled')),
  final_answer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(conversation_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_conversation_turn_history
  ON conversation_turn(conversation_id, status, sequence);

CREATE TABLE IF NOT EXISTS query_artifact (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id UUID NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  datasource_id INTEGER NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  purpose TEXT NOT NULL,
  expected_grain TEXT NOT NULL,
  expected_shape VARCHAR(20) NOT NULL CHECK(expected_shape IN ('scalar','timeseries','category','detail')),
  original_sql TEXT NOT NULL,
  executed_sql TEXT NOT NULL,
  schema_context_version VARCHAR(64) NOT NULL,
  columns_json JSONB NOT NULL,
  result_rows JSONB NOT NULL,
  returned_row_count INTEGER NOT NULL CHECK(returned_row_count >= 0),
  total_row_count BIGINT CHECK(total_row_count IS NULL OR total_row_count >= 0),
  is_limited BOOLEAN NOT NULL DEFAULT FALSE,
  result_content_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_query_artifact_generation ON query_artifact(generation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_query_artifact_conversation ON query_artifact(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS chart_artifact (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id UUID NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
  query_artifact_id UUID NOT NULL REFERENCES query_artifact(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  datasource_id INTEGER NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  chart_type VARCHAR(20) NOT NULL CHECK(chart_type IN ('line','bar','pie','scatter','radar','funnel')),
  title VARCHAR(200) NOT NULL,
  x_field VARCHAR(200) NOT NULL,
  y_fields JSONB NOT NULL,
  filters JSONB,
  sort JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chart_artifact_generation ON chart_artifact(generation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chart_artifact_query ON chart_artifact(query_artifact_id);
`;

export const PHASE3_TURN_BACKFILL_SQL = `
INSERT INTO conversation_turn (
  id, conversation_id, sequence, generation_id, user_message_id, assistant_message_id,
  status, final_answer, created_at, completed_at
)
SELECT
  gen_random_uuid(), g.conversation_id,
  COALESCE((SELECT MAX(existing.sequence) FROM conversation_turn existing WHERE existing.conversation_id=g.conversation_id), 0)
    + ROW_NUMBER() OVER (PARTITION BY g.conversation_id ORDER BY g.created_at, g.id),
  g.id, g.request_message_id, g.response_message_id,
  CASE
    WHEN g.status='completed' THEN 'completed'
    WHEN g.status='failed' THEN 'failed'
    WHEN g.status='cancelled' THEN 'cancelled'
    ELSE 'pending'
  END,
  CASE WHEN g.status='completed' THEN NULLIF(CONCAT_WS(E'\\n', NULLIF(m.content,''), (
    SELECT STRING_AGG(block->>'content', '' ORDER BY ordinality)
      FROM JSONB_ARRAY_ELEMENTS(COALESCE(m.blocks, '[]'::jsonb)) WITH ORDINALITY AS item(block, ordinality)
     WHERE block->>'type'='text' AND COALESCE(block->>'content','')<>''
  )), '') ELSE NULL END,
  g.created_at, g.completed_at
FROM generation g
JOIN message m ON m.id=g.response_message_id
WHERE NOT EXISTS (SELECT 1 FROM conversation_turn existing WHERE existing.generation_id=g.id)
ON CONFLICT (generation_id) DO NOTHING;

WITH ranked AS (
  SELECT ct.id, ROW_NUMBER() OVER (PARTITION BY ct.conversation_id ORDER BY g.created_at, g.id)::int AS stable_sequence
    FROM conversation_turn ct
    JOIN generation g ON g.id=ct.generation_id
)
UPDATE conversation_turn ct SET sequence=-ranked.stable_sequence
FROM ranked WHERE ranked.id=ct.id;

UPDATE conversation_turn SET sequence=-sequence WHERE sequence < 0;
`;

export const PHASE4_SCHEMA_SQL = `
ALTER TABLE query_artifact ADD COLUMN IF NOT EXISTS result_quality JSONB;

CREATE TABLE IF NOT EXISTS datasource_column_policy (
  datasource_id INTEGER NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  schema_name VARCHAR(63) NOT NULL DEFAULT 'public',
  table_name VARCHAR(63) NOT NULL,
  column_name VARCHAR(63) NOT NULL,
  classification VARCHAR(20) NOT NULL CHECK(classification IN ('public','internal','sensitive','restricted')),
  agent_access VARCHAR(20) NOT NULL CHECK(agent_access IN ('allow','mask','deny')),
  mask_type VARCHAR(20) CHECK(mask_type IS NULL OR mask_type IN ('redact','last4','hash')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(datasource_id, schema_name, table_name, column_name)
);
CREATE INDEX IF NOT EXISTS idx_column_policy_lookup
  ON datasource_column_policy(datasource_id, schema_name, table_name);
`;

export const PHASE5_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_record (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  scope VARCHAR(20) NOT NULL CHECK(scope IN ('user','datasource','conversation')),
  scope_id VARCHAR(100),
  type VARCHAR(40) NOT NULL CHECK(type IN ('metric_definition','dimension_definition','analysis_preference','locale_preference')),
  key VARCHAR(100) NOT NULL,
  value JSONB NOT NULL,
  source_message_id UUID NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  source_quote VARCHAR(500),
  status VARCHAR(20) NOT NULL CHECK(status IN ('proposed','active','superseded','deleted')),
  version INTEGER NOT NULL CHECK(version > 0),
  supersedes_id UUID REFERENCES memory_record(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  CHECK((scope='user' AND scope_id IS NULL) OR (scope<>'user' AND scope_id IS NOT NULL)),
  CHECK(jsonb_typeof(value)='object')
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_active_key
  ON memory_record(user_id, scope, COALESCE(scope_id,''), type, key)
  WHERE status='active';
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_source_operation
  ON memory_record(source_message_id, scope, COALESCE(scope_id,''), type, key, version);
CREATE INDEX IF NOT EXISTS idx_memory_resolver
  ON memory_record(user_id, status, scope, scope_id, type, key);
CREATE INDEX IF NOT EXISTS idx_memory_supersedes ON memory_record(supersedes_id);
CREATE TABLE IF NOT EXISTS memory_change_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memory_record(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL CHECK(action IN ('confirm','correct','forget')),
  previous_version INTEGER NOT NULL,
  new_memory_id UUID REFERENCES memory_record(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_audit_user ON memory_change_audit(user_id,created_at);
ALTER TABLE conversation DROP COLUMN IF EXISTS semantic_state;
`;

export const PHASE6_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS generation_metric (
  generation_id UUID PRIMARY KEY REFERENCES generation(id) ON DELETE CASCADE,
  llm_call_count INTEGER NOT NULL DEFAULT 0 CHECK(llm_call_count >= 0),
  tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK(tool_call_count >= 0),
  sql_call_count INTEGER NOT NULL DEFAULT 0 CHECK(sql_call_count >= 0),
  input_tokens_estimated INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens_estimated >= 0),
  output_tokens_estimated INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens_estimated >= 0),
  schema_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(schema_candidate_count >= 0),
  schema_selected_count INTEGER NOT NULL DEFAULT 0 CHECK(schema_selected_count >= 0),
  schema_prompt_tokens_estimated INTEGER NOT NULL DEFAULT 0 CHECK(schema_prompt_tokens_estimated >= 0),
  schema_retrieval_ms INTEGER NOT NULL DEFAULT 0 CHECK(schema_retrieval_ms >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS generation_trace_span (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id UUID NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
  name VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK(status IN ('ok','error')),
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_generation_trace_span_generation
  ON generation_trace_span(generation_id,created_at);

`;

export interface SchemaQueryable {
    query(sql: string): Promise<unknown>;
}

export async function applyPhase3Schema(db: SchemaQueryable): Promise<void> {
    await db.query(PHASE3_SCHEMA_SQL);
    await db.query(PHASE3_TURN_BACKFILL_SQL);
}

export async function applyPhase4Schema(db: SchemaQueryable): Promise<void> {
    await db.query(PHASE4_SCHEMA_SQL);
}

export async function applyPhase5Schema(db: SchemaQueryable): Promise<void> {
    await db.query(PHASE5_SCHEMA_SQL);
}

export async function applyPhase6Schema(db: SchemaQueryable): Promise<void> {
    await db.query(PHASE6_SCHEMA_SQL);
}

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
    dataset_key: string | null;
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
            dataset_key, source_type, is_agent_visible, created_by, created_at
       FROM datasource_table_catalog
      WHERE datasource_id = ? AND schema_name = current_schema() AND is_agent_visible = TRUE
      ORDER BY dataset_key NULLS LAST, id`,
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
    }
    async close(): Promise<void> {
        await Promise.all([this.pool.end(), this.agentPool.end()]);
    }
    async getPool(_datasourceId?: number | null): Promise<Pool> {
        return this.pool;
    }

    async query<T extends QueryRow[] = QueryRow[]>(sql: string, params: unknown[] = [], _datasourceId?: number | null): Promise<T> {
        return (await this.pool.query(normalizeSql(sql), params)).rows as T;
    }

    async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
        return resultOf(await this.pool.query(normalizeSql(sql), params));
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
            return (await client.query(normalizeSql(sql), params)).rows as T;
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
            const result = await client.query(normalizeSql(sql), params);
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
