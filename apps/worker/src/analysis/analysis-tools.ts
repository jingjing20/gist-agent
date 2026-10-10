import { createHash } from 'crypto';
import type OpenAI from 'openai';
import type { AnalysisState, DatasourceMemory, QueryArtifactV1 } from '@gist/contracts';
import type { Tool, ToolContext, ToolExecutionResult } from '../chat/tools/base-tool';
import { exactKeys, record } from './tool-arguments';
import { patchAnalysisState, evidenceMismatch } from './analysis-state';
import type { AnalysisStateRepository } from './analysis-state.repository';
import type { SchemaService } from '../database/schema.service';
import type { ArtifactRepository } from '../chat/artifact.repository';
import type { GenerationIdentity } from '../chat/generation.service';
import { GenerationExecutionError } from '../chat/generation-errors';

const result = (data: unknown, succeeded = true): ToolExecutionResult => ({ toolResult: JSON.stringify(data), blocks: [], succeeded });
const number = (value: unknown, fallback: number, max: number) => {
    const n = value === undefined ? fallback : value;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) throw new Error('分页参数无效');
    return n;
};
const string = (v: unknown) => {
    if (typeof v !== 'string' || !v.trim() || v.length > 4000) throw new Error('文本参数无效');
    return v;
};
const properties = { offset: { type: 'integer', minimum: 0 }, q: { type: 'string' } };
function tool(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecutionResult>
): Tool {
    return {
        name,
        definition: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } },
        parseArguments(value) {
            const args = record(value);
            exactKeys(args, Object.keys(properties));
            for (const k of required) if (args[k] === undefined) throw new Error(`缺少 ${k}`);
            if (args.offset !== undefined) number(args.offset, 0, 100000);
            for (const k of ['q', 'table', 'id', 'queryArtifactId']) if (args[k] !== undefined) string(args[k]);
            return args;
        },
        execute,
    };
}
export interface AnalysisSession {
    state: AnalysisState;
    memories: DatasourceMemory[];
    observed: Map<string, QueryArtifactV1>;
    loadedSchema: Map<string, string>;
    memoryChanges: string[];
    prepared: boolean;
}
export function analysisTools(input: {
    session: AnalysisSession;
    schema: SchemaService;
    artifacts: ArtifactRepository;
    states: AnalysisStateRepository;
    generation: GenerationIdentity;
    readEvidence(id: string): Promise<QueryArtifactV1>;
}): Tool[] {
    const { session, schema, artifacts, states, generation: g } = input;
    const access = async (ctx: ToolContext) => {
        await ctx.assertWritable();
        try {
            await schema.assertDatasourceAccess(session.state.datasourceId, g.userId);
        } catch (e) {
            if (e instanceof Error && e.message.startsWith('DATASOURCE_ACCESS_CHANGED:')) throw new GenerationExecutionError('DATASOURCE_ACCESS_CHANGED', '数据源不可访问');
            throw e;
        }
    };
    const evidence = input.readEvidence;
    const fieldAllowed = async (field: string) => {
        const [table, column, ...rest] = field.split('.');
        if (rest.length || !column) return false;
        const d = await schema.getSchemaDetail(session.state.datasourceId, g.userId, table);
        return !!d?.columns.some((c) => c.name === column);
    };
    return [
        tool('get_analysis_state', '读取当前分析草稿及版本。', {}, [], async (_a, ctx) => {
            await access(ctx);
            return result(session.state);
        }),
        tool(
            'update_analysis_state',
            '必须独立调用，不与其他工具同批执行；收到成功结果后再执行依赖工具。先显式更新本轮问题、记忆引用、时间、筛选或粒度，再查询。新任务用 start_new_task。临时约定来源自动绑定当前用户消息；不写长期记忆。最新数据请求设 freshness=current_generation。',
            {
                expectedRevision: { type: 'integer' },
                mode: { type: 'string', enum: ['patch', 'start_new_task'] },
                reason: { type: 'string' },
                patch: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        question: { type: 'string' },
                        memoryRefs: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { id: { type: 'string' }, version: { type: 'integer' } },
                                required: ['id', 'version'],
                                additionalProperties: false,
                            },
                        },
                        temporaryNotes: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { name: { type: 'string' }, description: { type: 'string' } },
                                required: ['name', 'description'],
                                additionalProperties: false,
                            },
                        },
                        timeRange: {
                            type: ['object', 'null'],
                            properties: { start: { type: 'string' }, endExclusive: { type: 'string' }, timezone: { type: 'string' } },
                            required: ['start', 'endExclusive', 'timezone'],
                            additionalProperties: false,
                        },
                        comparisonRange: {
                            type: ['object', 'null'],
                            properties: { start: { type: 'string' }, endExclusive: { type: 'string' }, timezone: { type: 'string' } },
                            required: ['start', 'endExclusive', 'timezone'],
                            additionalProperties: false,
                        },
                        filters: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { field: { type: 'string' }, operator: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'] }, value: {} },
                                required: ['field', 'operator', 'value'],
                            },
                        },
                        grain: { type: ['string', 'null'] },
                        freshness: { type: 'string', enum: ['reuse_allowed', 'current_generation'] },
                        hypotheses: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    statement: { type: 'string' },
                                    status: { type: 'string', enum: ['open', 'supported', 'refuted', 'unresolved'] },
                                    evidenceIds: { type: 'array', items: { type: 'string' } },
                                },
                                required: ['id', 'statement', 'status', 'evidenceIds'],
                            },
                        },
                        openQuestions: { type: 'array', items: { type: 'string' } },
                    },
                },
            },
            ['expectedRevision', 'patch', 'reason'],
            async (args, ctx) => {
                await access(ctx);
                let next: AnalysisState;
                try {
                    next = await patchAnalysisState(session.state, args, {
                        memories: session.memories,
                        sourceMessageId: g.requestMessageId,
                        fieldAllowed: async (f) => {
                            try {
                                return await fieldAllowed(f);
                            } catch {
                                throw new GenerationExecutionError('TOOL_EXECUTION_FAILED', '筛选字段读取失败');
                            }
                        },
                        validateEvidence: async (id, state) => {
                            const a = await evidence(id);
                            if (!session.observed.has(id)) throw new Error('假设只能引用本轮已观察或回读的证据');
                            const mismatch = evidenceMismatch(a, state, g.id);
                            if (mismatch) throw new Error(mismatch);
                            if (a.isLimited || a.resultQuality?.warnings.some((w) => w.severity === 'blocking')) throw new Error('质量受限证据不能确认假设');
                        },
                    });
                } catch (e) {
                    if (e instanceof GenerationExecutionError) throw e;
                    return result({ error: (e as Error).message, state: session.state }, false);
                }
                await states.save(g, session.state.revision, next);
                session.state = next;
                session.prepared = true;
                ctx.analysisContext = { state: next, memories: session.memories.filter((d) => next.memoryRefs.some((r) => r.id === d.id && r.version === d.version)) };
                return result({ state: next, notice: '条件变化后旧证据需重新检查；状态记录不等于 SQL 已按这些条件执行，须核对实际查询。' });
            }
        ),
        tool('list_schema', '分页读取授权表目录。可按名称过滤；nextOffset 非空表示还有表。', properties, [], async (args, ctx) => {
            await access(ctx);
            const offset = number(args.offset, 0, 100000);
            const q = args.q === undefined ? '' : string(args.q).toLowerCase();
            const catalog = await schema.getSchemaCatalogSummary(session.state.datasourceId, g.userId);
            const rows = catalog.tables.filter((t) => `${t.name} ${t.displayName}`.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
            return result({
                tables: rows.slice(offset, offset + 20).map((t) => ({ ...t, description: t.description?.slice(0, 200), descriptionTruncated: (t.description?.length ?? 0) > 200 })),
                nextOffset: offset + 20 < rows.length ? offset + 20 : null,
            });
        }),
        tool(
            'get_schema',
            '读取一张授权表的字段页，字段不静默截断；nextOffset 非空表示还有字段，仅在所需字段尚未读取时继续分页。不得猜测未读取字段。表名来自目录，加载与否不改变权限。',
            { table: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
            ['table'],
            async (args, ctx) => {
                await access(ctx);
                const table = string(args.table),
                    offset = number(args.offset, 0, 100000);
                const detail = await schema.getSchemaDetail(session.state.datasourceId, g.userId, table);
                if (!detail) return result({ error: '表不存在或不可访问' }, false);
                session.loadedSchema.set(table, createHash('sha256').update(JSON.stringify(detail)).digest('hex'));
                return result({
                    ...detail,
                    columns: detail.columns.slice(offset, offset + 20),
                    nextOffset: offset + 20 < detail.columns.length ? offset + 20 : null,
                    schemaVersion: g.schemaContextVersion,
                });
            }
        ),
        tool('list_memories', '读取本轮固定版本的已保存记忆目录；候选不参与召回。', properties, [], async (args, ctx) => {
            await access(ctx);
            const offset = number(args.offset, 0, 100000),
                q = args.q === undefined ? '' : string(args.q).toLowerCase();
            const rows = session.memories.filter((d) => [d.name, d.description].some((n) => n.toLowerCase().includes(q)));
            return result({
                items: rows.slice(offset, offset + 20).map((d) => ({
                    id: d.id,
                    version: d.version,
                    name: d.name,
                    description: d.description.slice(0, 200),
                    descriptionTruncated: d.description.length > 200,
                })),
                nextOffset: offset + 20 < rows.length ? offset + 20 : null,
            });
        }),
        tool('read_memory', '读取一条本轮固定版本记忆的完整内容。管理页修改于下一轮生效。', { id: { type: 'string' } }, ['id'], async (args, ctx) => {
            await access(ctx);
            const d = session.memories.find((d) => d.id === string(args.id));
            return d ? result(d) : result({ error: '当前记忆快照中不存在该 ID' }, false);
        }),
        tool('list_analysis_evidence', '分页读取当前会话、数据源的成功历史证据目录；必须回读后才能引用。', { offset: { type: 'integer', minimum: 0 } }, [], async (args, ctx) => {
            await access(ctx);
            return result(await artifacts.listAnalysisEvidence(g.userId, g.conversationId, session.state.datasourceId, number(args.offset, 0, 100000)));
        }),
        tool(
            'read_query_artifact',
            '回读证据，默认检查当前条件适用性。显式历史条件比较可设 mode=comparison，正文必须解释两组比较条件；不能据此绕过跨源、任务或最新数据要求。',
            { queryArtifactId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, mode: { type: 'string', enum: ['current', 'comparison'] } },
            ['queryArtifactId'],
            async (args, ctx) => {
                await access(ctx);
                if (!session.prepared) return result({ error: '请先调用 update_analysis_state 确认本轮条件' }, false);
                const id = string(args.queryArtifactId),
                    offset = number(args.offset, 0, 100000);
                if (args.mode !== undefined && !['current', 'comparison'].includes(String(args.mode))) return result({ error: '读取模式错误' }, false);
                const a = await evidence(id);
                const mismatch = evidenceMismatch(a, session.state, g.id);
                const comparable =
                    args.mode === 'comparison' &&
                    a.datasourceId === session.state.datasourceId &&
                    a.analysisContext?.state.taskId === session.state.taskId &&
                    session.state.freshness !== 'current_generation';
                if (mismatch && !comparable) return result({ error: mismatch, queriedAt: a.createdAt, artifactState: a.analysisContext?.state }, false);
                const page = await artifacts.readQueryArtifact(id, g.userId, g.conversationId, 20, offset);
                if (JSON.stringify(page.rows).length > 16000)
                    return result({ error: '此页行数据超出上下文摘要上限，请查询更少字段或聚合结果', queryArtifactId: id, queriedAt: a.createdAt }, false);
                session.observed.set(id, a);
                return result({
                    queryArtifactId: id,
                    executedSql: a.executedSql,
                    columns: a.columns,
                    rows: page.rows,
                    nextOffset: offset + 20 < a.returnedRowCount ? offset + 20 : null,
                    queriedAt: a.createdAt,
                    isLimited: a.isLimited,
                    resultQuality: a.resultQuality,
                    artifactState: a.analysisContext?.state,
                    currentState: session.state,
                    comparisonOnly: !!mismatch,
                    notice: '历史证据读取不刷新数据库；分页结果不能用于凭空重算聚合。',
                });
            }
        ),
    ];
}
