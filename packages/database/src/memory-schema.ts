export const DATASOURCE_MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS datasource_memory (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 datasource_id INTEGER NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version > 0),
 status TEXT NOT NULL CHECK(status IN ('active','deleted')),
 normalized_name TEXT NOT NULL,
 created_by INTEGER NOT NULL REFERENCES app_user(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS datasource_memory_active_name
 ON datasource_memory(datasource_id, normalized_name) WHERE status='active';
CREATE TABLE IF NOT EXISTS datasource_memory_revision (
 memory_id UUID NOT NULL REFERENCES datasource_memory(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version > 0),
 content JSONB NOT NULL CHECK(jsonb_typeof(content)='object'),
 status TEXT NOT NULL CHECK(status IN ('active','deleted')),
 source TEXT NOT NULL CHECK(source IN ('manual','conversation')),
 source_message_id UUID REFERENCES message(id),
 confirmed_by INTEGER NOT NULL REFERENCES app_user(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(memory_id, version),
 CHECK(source <> 'conversation' OR source_message_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS datasource_memory_candidate (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 datasource_id INTEGER NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES app_user(id),
 generation_id UUID NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
 source_message_id UUID NOT NULL REFERENCES message(id),
 memory_id UUID REFERENCES datasource_memory(id),
 expected_version INTEGER,
 content JSONB NOT NULL CHECK(jsonb_typeof(content)='object'),
 version INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
 result_memory_id UUID REFERENCES datasource_memory(id),
 result_version INTEGER,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK((memory_id IS NULL AND expected_version IS NULL) OR (memory_id IS NOT NULL AND expected_version > 0))
);
CREATE INDEX IF NOT EXISTS datasource_memory_candidate_pending ON datasource_memory_candidate(datasource_id, user_id, status);
`;
export async function applyDatasourceMemorySchema(db: { query(sql: string): Promise<unknown> }): Promise<void> {
    await db.query(DATASOURCE_MEMORY_SCHEMA_SQL);
}
