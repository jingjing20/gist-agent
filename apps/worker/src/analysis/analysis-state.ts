import { randomUUID } from 'crypto';
import type { AnalysisState, DatasourceMemory, QueryArtifactV1 } from '@gist/contracts';
import { stableStringify } from '../chat/artifact.repository';
import { exactKeys, record } from './submission';

export function newAnalysisState(conversationId: string, datasourceId: number, question: string, revision = 1): AnalysisState {
    return {
        taskId: randomUUID(),
        conversationId,
        datasourceId,
        revision,
        question,
        status: 'active',
        memoryRefs: [],
        temporaryNotes: [],
        timeRange: null,
        comparisonRange: null,
        filters: [],
        grain: null,
        freshness: 'reuse_allowed',
        hypotheses: [],
        openQuestions: [],
    };
}
export function conditionSignature(state: AnalysisState): string {
    return stableStringify({
        taskId: state.taskId,
        datasourceId: state.datasourceId,
        memoryRefs: [...state.memoryRefs].sort((a, b) => a.id.localeCompare(b.id)),
        temporaryNotes: state.temporaryNotes,
        timeRange: state.timeRange,
        comparisonRange: state.comparisonRange,
        filters: state.filters,
        grain: state.grain,
    });
}
export function evidenceMismatch(artifact: QueryArtifactV1, state: AnalysisState, generationId: string): string | null {
    if (artifact.datasourceId !== state.datasourceId) return '证据属于其他数据源';
    if (!artifact.analysisContext) return '证据缺少必要分析条件，无法验证适用性';
    if (artifact.analysisContext.state.taskId !== state.taskId) return '证据属于其他分析任务';
    if (state.freshness === 'current_generation' && artifact.generationId !== generationId) return '本轮要求最新数据，请重新查询';
    if (conditionSignature(artifact.analysisContext.state) !== conditionSignature(state)) return '定义、时间、筛选或粒度已变化，请重新查询或显式比较历史条件';
    return null;
}
export function validateEvidenceReference(
    artifact: QueryArtifactV1,
    state: AnalysisState,
    generationId: string,
    reference: { role: string; comparisonLabel?: string },
    comparisonRead: boolean
): void {
    const mismatch = evidenceMismatch(artifact, state, generationId);
    if (!mismatch) return;
    if (
        comparisonRead &&
        reference.role === 'comparison' &&
        reference.comparisonLabel?.trim() &&
        artifact.datasourceId === state.datasourceId &&
        artifact.analysisContext?.state.taskId === state.taskId &&
        state.freshness !== 'current_generation'
    )
        return;
    throw new Error(mismatch);
}

function text(v: unknown): string {
    if (typeof v !== 'string' || !v.trim() || v.length > 4000) throw new Error('状态文本必须非空且不超过 4000 字符');
    return v.trim();
}
function list(v: unknown, max = 30): unknown[] {
    if (!Array.isArray(v) || v.length > max) throw new Error(`状态列表最多 ${max} 项`);
    return v;
}
function range(v: unknown): AnalysisState['timeRange'] {
    if (v === null) return null;
    const r = record(v);
    exactKeys(r, ['start', 'endExclusive', 'timezone']);
    const start = text(r.start),
        endExclusive = text(r.endExclusive),
        timezone = text(r.timezone);
    if (
        !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(start) ||
        !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(endExclusive) ||
        !Number.isFinite(Date.parse(start)) ||
        !Number.isFinite(Date.parse(endExclusive)) ||
        Date.parse(start) >= Date.parse(endExclusive)
    )
        throw new Error('时间区间必须是带时区的有效半开区间');
    try {
        new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
        throw new Error('时区无效');
    }
    return { start: new Date(start).toISOString(), endExclusive: new Date(endExclusive).toISOString(), timezone };
}
export async function patchAnalysisState(
    current: AnalysisState,
    args: Record<string, unknown>,
    deps: {
        memories: DatasourceMemory[];
        sourceMessageId: string;
        fieldAllowed(field: string): Promise<boolean>;
        validateEvidence(id: string, state: AnalysisState): Promise<void>;
    }
): Promise<AnalysisState> {
    exactKeys(args, ['expectedRevision', 'mode', 'patch', 'reason']);
    if (args.expectedRevision !== current.revision) throw new Error('状态版本冲突，请读取工具返回的当前状态后重试');
    text(args.reason);
    if (args.mode !== undefined && !['patch', 'start_new_task'].includes(String(args.mode))) throw new Error('状态模式无效');
    const patch = record(args.patch);
    exactKeys(patch, ['question', 'memoryRefs', 'temporaryNotes', 'timeRange', 'comparisonRange', 'filters', 'grain', 'freshness', 'hypotheses', 'openQuestions']);
    const state = args.mode === 'start_new_task' ? newAnalysisState(current.conversationId, current.datasourceId, current.question, current.revision) : structuredClone(current);
    if (patch.question !== undefined) state.question = text(patch.question);
    if (patch.memoryRefs !== undefined) {
        state.memoryRefs = list(patch.memoryRefs).map((v) => {
            const r = record(v);
            exactKeys(r, ['id', 'version']);
            const d = deps.memories.find((d) => d.id === r.id && d.version === r.version && d.status === 'active');
            if (!d) throw new Error('定义不存在、版本过期或字段失效，请读取本轮定义目录');
            return { id: d.id, version: d.version };
        });
        if (new Set(state.memoryRefs.map((d) => d.id)).size !== state.memoryRefs.length) throw new Error('定义引用重复');
    }
    if (patch.temporaryNotes !== undefined)
        state.temporaryNotes = list(patch.temporaryNotes).map((v) => {
            const d = record(v);
            exactKeys(d, ['name', 'description']);
            return { name: text(d.name), description: text(d.description), sourceMessageId: deps.sourceMessageId };
        });
    if (patch.timeRange !== undefined) state.timeRange = range(patch.timeRange);
    if (patch.comparisonRange !== undefined) state.comparisonRange = range(patch.comparisonRange);
    if (patch.grain !== undefined) state.grain = patch.grain === null ? null : text(patch.grain);
    if (patch.freshness !== undefined) {
        if (!['reuse_allowed', 'current_generation'].includes(String(patch.freshness))) throw new Error('时效要求无效');
        state.freshness = patch.freshness as AnalysisState['freshness'];
    }
    if (patch.filters !== undefined) {
        state.filters = [];
        for (const v of list(patch.filters)) {
            const f = record(v);
            exactKeys(f, ['field', 'operator', 'value']);
            const field = text(f.field);
            if (!(await deps.fieldAllowed(field))) throw new Error('筛选字段未获授权或不存在');
            if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'].includes(String(f.operator))) throw new Error('筛选操作符无效');
            const scalar = (x: unknown) => (typeof x === 'string' ? x.length <= 1000 : typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)));
            if (f.operator === 'in' ? !Array.isArray(f.value) || !f.value.length || f.value.length > 100 || !f.value.every(scalar) : f.value !== null && !scalar(f.value))
                throw new Error('筛选值格式无效');
            state.filters.push({ field, operator: f.operator as AnalysisState['filters'][number]['operator'], value: f.value as AnalysisState['filters'][number]['value'] });
        }
    }
    for (const filter of state.filters) if (!(await deps.fieldAllowed(filter.field))) throw new Error('已有筛选字段失效，请移除或修订');
    if (conditionSignature(state) !== conditionSignature(current)) state.hypotheses = [];
    if (patch.openQuestions !== undefined) state.openQuestions = list(patch.openQuestions).map(text);
    if (patch.hypotheses !== undefined) {
        state.hypotheses = [];
        for (const v of list(patch.hypotheses)) {
            const h = record(v);
            exactKeys(h, ['id', 'statement', 'status', 'evidenceIds']);
            if (!['open', 'supported', 'refuted', 'unresolved'].includes(String(h.status))) throw new Error('假设状态无效');
            const evidenceIds = list(h.evidenceIds).map(text);
            if (['supported', 'refuted'].includes(String(h.status)) && !evidenceIds.length) throw new Error('已判断假设需要证据');
            for (const id of evidenceIds) await deps.validateEvidence(id, state);
            state.hypotheses.push({ id: text(h.id), statement: text(h.statement), status: h.status as AnalysisState['hypotheses'][number]['status'], evidenceIds });
        }
        if (new Set(state.hypotheses.map((h) => h.id)).size !== state.hypotheses.length) throw new Error('假设 ID 重复');
    }
    state.revision = current.revision + 1;
    state.status = 'active';
    return state;
}
