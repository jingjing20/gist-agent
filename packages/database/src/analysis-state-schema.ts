import type { TransactionConnection } from './index';

export const ANALYSIS_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS analysis_state (
 conversation_id UUID PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL CHECK(revision > 0),
 state JSONB NOT NULL CHECK(jsonb_typeof(state)='object'),
 generation_id UUID NOT NULL REFERENCES generation(id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS analysis_state_draft (
 generation_id UUID PRIMARY KEY REFERENCES generation(id) ON DELETE CASCADE,
 conversation_id UUID NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
 base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
 revision INTEGER NOT NULL CHECK(revision > base_revision),
 state JSONB NOT NULL CHECK(jsonb_typeof(state)='object'),
 definitions JSONB NOT NULL,
 context_reports JSONB NOT NULL DEFAULT '[]'::jsonb,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
export async function applyAnalysisStateSchema(db: { query(sql: string): Promise<unknown> }): Promise<void> {
    await db.query(ANALYSIS_STATE_SCHEMA_SQL);
}
/** Must run inside the same transaction that commits generation completed. */
export async function promoteAnalysisDraft(tx: TransactionConnection, generationId: string): Promise<void> {
    const [drafts] = await tx.query('SELECT * FROM analysis_state_draft WHERE generation_id=? FOR UPDATE', [generationId]);
    if (!drafts.length) throw new Error('ANALYSIS_DRAFT_MISSING');
    const d = drafts[0];
    // Lock the conversation to serialize the absent-row case as well as existing state.
    await tx.query('SELECT id FROM conversation WHERE id=? FOR UPDATE', [d.conversation_id]);
    const [current] = await tx.query('SELECT revision FROM analysis_state WHERE conversation_id=? FOR UPDATE', [d.conversation_id]);
    if ((current[0]?.revision ?? 0) !== d.base_revision) throw new Error('ANALYSIS_STATE_CONFLICT');
    await tx.execute(
        `INSERT INTO analysis_state(conversation_id,revision,state,generation_id) VALUES (?,?,?::jsonb,?)
     ON CONFLICT(conversation_id) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,generation_id=EXCLUDED.generation_id,updated_at=NOW()`,
        [d.conversation_id, d.revision, JSON.stringify(d.state), generationId]
    );
}
