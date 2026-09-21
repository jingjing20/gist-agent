import type { AnalysisState, BusinessDefinition } from '@gist/contracts';
import { DatabaseService } from '../database/database.service';
import type { GenerationIdentity } from '../chat/generation.service';
import { GenerationExecutionError } from '../chat/generation-errors';
import { newAnalysisState } from './analysis-state';

export class AnalysisStateRepository {
    constructor(private readonly db: DatabaseService) {}
    private async owned(tx: { query(sql: string, params: unknown[]): Promise<any> }, g: GenerationIdentity) {
        const [rows] = await tx.query(
            "SELECT id FROM generation WHERE id=? AND user_id=? AND conversation_id=? AND writer_token=? AND status IN ('starting','running') FOR UPDATE",
            [g.id, g.userId, g.conversationId, g.writerToken]
        );
        if (!rows.length) throw new GenerationExecutionError('WRITER_OWNERSHIP_LOST', '任务已停止，不能更新分析草稿');
    }
    async begin(
        g: GenerationIdentity,
        ds: number,
        question: string,
        definitions: BusinessDefinition[]
    ): Promise<{ state: AnalysisState; definitions: BusinessDefinition[]; definitionChanges: string[] }> {
        return this.db.withTransaction(async (tx) => {
            await this.owned(tx, g);
            const [drafts] = await tx.query('SELECT state,definitions FROM analysis_state_draft WHERE generation_id=?', [g.id]);
            if (drafts.length) return { state: drafts[0].state as AnalysisState, definitions: drafts[0].definitions as BusinessDefinition[], definitionChanges: [] };
            const [rows] = await tx.query('SELECT revision,state FROM analysis_state WHERE conversation_id=?', [g.conversationId]);
            const base = rows[0]?.revision ?? 0;
            const previous = rows[0]?.state as AnalysisState | undefined;
            const state = previous?.datasourceId === ds ? structuredClone(previous) : newAnalysisState(g.conversationId, ds, question);
            state.revision = base + 1;
            state.status = 'active';
            const definitionChanges: string[] = [];
            state.definitionRefs = state.definitionRefs.flatMap((ref) => {
                const current = definitions.find((d) => d.id === ref.id && !d.needsReview);
                if (!current || current.version !== ref.version) definitionChanges.push(`定义 ${ref.id} v${ref.version} 已变更或不可用，请重新确认当前问题的口径`);
                return current ? [{ id: current.id, version: current.version }] : [];
            });
            if (definitionChanges.length) {
                state.hypotheses = [];
                state.openQuestions = [...definitionChanges, ...state.openQuestions].slice(0, 30);
            }
            await tx.execute('INSERT INTO analysis_state_draft(generation_id,conversation_id,base_revision,revision,state,definitions) VALUES (?,?,?,?,?::jsonb,?::jsonb)', [
                g.id,
                g.conversationId,
                base,
                state.revision,
                JSON.stringify(state),
                JSON.stringify(definitions),
            ]);
            return { state, definitions, definitionChanges };
        });
    }
    async save(g: GenerationIdentity, expected: number, state: AnalysisState): Promise<void> {
        await this.db.withTransaction(async (tx) => {
            await this.owned(tx, g);
            const [updated] = await tx.execute('UPDATE analysis_state_draft SET revision=?,state=?::jsonb,updated_at=NOW() WHERE generation_id=? AND revision=?', [
                state.revision,
                JSON.stringify(state),
                g.id,
                expected,
            ]);
            if (updated.rowCount !== 1) throw new Error('分析草稿版本冲突');
        });
    }
    async report(g: GenerationIdentity, report: unknown): Promise<void> {
        await this.db.withTransaction(async (tx) => {
            await this.owned(tx, g);
            await tx.execute('UPDATE analysis_state_draft SET context_reports=context_reports || ?::jsonb WHERE generation_id=?', [JSON.stringify([report]), g.id]);
        });
    }
    async history(g: GenerationIdentity, ds: number) {
        // Only completed new-core turns on this datasource, never old memory or failed drafts.
        return this.db.query(
            `SELECT ct.id,ct.sequence,u.content AS question,ct.final_answer AS answer FROM conversation_turn ct
         JOIN generation g ON g.id=ct.generation_id JOIN message u ON u.id=ct.user_message_id
         WHERE ct.conversation_id=? AND g.user_id=? AND ct.status='completed' AND g.id<>?
         AND g.prompt_policy_version='analysis-core-v2' AND COALESCE(g.datasource_id,(SELECT id FROM data_source WHERE is_local=1 ORDER BY id LIMIT 1))=?
         AND g.created_at<=? ORDER BY ct.sequence DESC LIMIT 4`,
            [g.conversationId, g.userId, g.id, ds, g.contextUpperBound]
        );
    }
}
