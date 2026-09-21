export const BUSINESS_DEFINITION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS business_definition_seed_import (
 datasource_id INTEGER NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
 seed_key TEXT NOT NULL,
 imported_by INTEGER NOT NULL REFERENCES app_user(id),
 imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(datasource_id,seed_key)
);
CREATE TABLE IF NOT EXISTS business_definition (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 datasource_id INTEGER NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version > 0),
 status TEXT NOT NULL CHECK(status IN ('active','deleted')),
 normalized_name TEXT NOT NULL,
 created_by INTEGER NOT NULL REFERENCES app_user(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS business_definition_active_name
 ON business_definition(datasource_id, normalized_name) WHERE status='active';
CREATE TABLE IF NOT EXISTS business_definition_revision (
 definition_id UUID NOT NULL REFERENCES business_definition(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version > 0),
 content JSONB NOT NULL CHECK(jsonb_typeof(content)='object'),
 status TEXT NOT NULL CHECK(status IN ('active','deleted')),
 source TEXT NOT NULL CHECK(source IN ('manual','conversation')),
 source_message_id UUID REFERENCES message(id),
 confirmed_by INTEGER NOT NULL REFERENCES app_user(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(definition_id, version),
 CHECK(source <> 'conversation' OR source_message_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS business_definition_candidate (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 datasource_id INTEGER NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES app_user(id),
 generation_id UUID NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
 source_message_id UUID NOT NULL REFERENCES message(id),
 definition_id UUID REFERENCES business_definition(id),
 expected_version INTEGER,
 content JSONB NOT NULL CHECK(jsonb_typeof(content)='object'),
 version INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
 result_definition_id UUID REFERENCES business_definition(id),
 result_version INTEGER,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK((definition_id IS NULL AND expected_version IS NULL) OR (definition_id IS NOT NULL AND expected_version > 0))
);
CREATE INDEX IF NOT EXISTS business_definition_candidate_pending ON business_definition_candidate(datasource_id, user_id, status);
`;
export async function applyBusinessDefinitionSchema(db: { query(sql: string): Promise<unknown> }): Promise<void> {
    await db.query(BUSINESS_DEFINITION_SCHEMA_SQL);
}
