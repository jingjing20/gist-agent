import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PROMPT_METADATA } from '@gist/llm';
import { generateSuggestions } from './follow-up-suggestions';
import type OpenAI from 'openai';
import { ANALYSIS_RUNTIME_VERSIONS, type AnalysisRunSnapshot } from '@gist/contracts';
import { MemoryRepository } from '@gist/database';
import { DatabaseService } from '../database/database.service';
import { SchemaService } from '../database/schema.service';
import { LlmService } from '../llm/llm.service';
import { SqlQueryTool } from '../chat/tools/sql-query.tool';
import { GenerateChartTool } from '../chat/tools/generate-chart.tool';
import { ArtifactRepository, stableStringify } from '../chat/artifact.repository';
import type { GenerationIdentity, GenerationExecutionMetrics } from '../chat/generation.service';
import { requireNonEmptyString, type SSEEmitter, type SSEEvent, type ToolContext, type Tool } from '../chat/tools/base-tool';
import { GenerationExecutionError } from '../chat/generation-errors';
import { resolveModelCapability } from '../chat/model-capabilities';
import { AnalysisAgent } from './analysis-agent';
import { record } from './tool-arguments';
import { buildAnalysisPrompt, buildAnalysisData, ANALYSIS_PROMPT_METADATA } from './analysis-prompt';
import { ProposeMemoryTool } from './propose-memory-tool';
import { AnalysisStateRepository } from './analysis-state.repository';
import { analysisTools, type AnalysisSession } from './analysis-tools';
import { evidenceMismatch } from './analysis-state';
import { assembleContext, type ContextCandidate } from './context-assembler';

@Injectable()
export class AnalysisRuntimeAdapter {
    private readonly logger = new Logger(AnalysisRuntimeAdapter.name);
    constructor(
        private readonly schema: SchemaService,
        private readonly llm: LlmService,
        private readonly sql: SqlQueryTool,
        private readonly chart: GenerateChartTool,
        private readonly artifacts: ArtifactRepository,
        private readonly db: DatabaseService
    ) {}
    async run(input: {
        generation: GenerationIdentity;
        message: string;
        signal: AbortSignal;
        emitter: SSEEmitter;
        blocks: SSEEvent[];
        turnMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
        metrics: GenerationExecutionMetrics;
        assertWritable(): Promise<void>;
        checkpoint(): Promise<void>;
        onFirstDelta(): Promise<void>;
    }): Promise<void> {
        const { generation: g, signal } = input;
        if (!g.writerToken) throw new GenerationExecutionError('WRITER_OWNERSHIP_LOST', '新核心缺少任务写入凭证');
        const check = async () => {
            if (signal.aborted) throw signal.reason ?? new GenerationExecutionError('CANCELLED', '已取消');
            await input.assertWritable();
        };
        const access = async () => {
            await check();
            try {
                await this.schema.assertDatasourceAccess(g.datasourceId, g.userId);
            } catch (e) {
                if (e instanceof Error && e.message.startsWith('DATASOURCE_ACCESS_CHANGED:')) throw new GenerationExecutionError('DATASOURCE_ACCESS_CHANGED', '当前数据源不可访问');
                throw e;
            }
        };
        await access();
        const catalog = await this.schema.getSchemaCatalogSummary(g.datasourceId, g.userId);
        const memoriesRepository = new MemoryRepository(this.db),
            states = new AnalysisStateRepository(this.db);
        const explicitMemory = input.message.match(/^\s*(?:请|帮我|请帮我)?记住(?:这条|以下|下面)?(?:规则|口径|信息|内容)?\s*[：:，,]\s*([\s\S]+)$/);
        if (explicitMemory) {
            const description = explicitMemory[1].trim();
            await memoriesRepository.rememberFromConversation(g.userId, catalog.datasourceId, g.requestMessageId, {
                name: description.split(/\n/)[0].slice(0, 80),
                description,
            });
        }
        const draft = await states.begin(g, catalog.datasourceId, input.message, await memoriesRepository.snapshot(g.userId, catalog.datasourceId));
        const session: AnalysisSession = { ...draft, observed: new Map(), loadedSchema: new Map(), prepared: false };
        const history = await states.history(g, catalog.datasourceId);
        const evidenceIndex = await this.artifacts.listAnalysisEvidence(g.userId, g.conversationId, catalog.datasourceId);
        const anchor = new Date(g.contextUpperBound).toISOString();
        const snapshot = (): AnalysisRunSnapshot => ({
            taskId: session.state.taskId,
            datasourceId: catalog.datasourceId,
            stateRevision: session.state.revision,
            requestMessageId: g.requestMessageId,
            question: input.message,
            timeAnchor: anchor,
            memoryRefs: session.state.memoryRefs,
            schemaTables: [...session.loadedSchema.keys()].sort(),
        });
        const selectedMemories = () => session.memories.filter((d) => session.state.memoryRefs.some((r) => r.id === d.id && r.version === d.version));
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: 'system', content: '' },
            { role: 'user', content: input.message },
        ];
        const reports: unknown[] = [];
        const emit = (event: SSEEvent) => {
            if (event.type === 'table' && !event.display) return;
            if (signal.aborted) throw signal.reason ?? new GenerationExecutionError('CANCELLED', '已取消');
            input.emitter.send(event);
            if (event.type === 'text_chunk') {
                const last = input.blocks.at(-1);
                if (last?.type === 'text' && !last.analysis) last.content = String(last.content || '') + String(event.content || '');
                else input.blocks.push({ type: 'text', content: event.content || '' });
            } else if (event.type === 'analysis_activity' && event.activity && typeof event.activity === 'object') {
                const id = String((event.activity as { id?: unknown }).id ?? '');
                const index = input.blocks.findIndex((block) => block.type === 'analysis_activity' && String((block.activity as { id?: unknown } | undefined)?.id ?? '') === id);
                if (index >= 0) input.blocks[index] = event;
                else input.blocks.push(event);
            } else if (event.type === 'analysis_activity_remove') {
                const index = input.blocks.findIndex(
                    (block) => block.type === 'analysis_activity' && String((block.activity as { id?: unknown } | undefined)?.id ?? '') === String(event.activityId ?? '')
                );
                if (index >= 0) input.blocks.splice(index, 1);
            } else if (event.type === 'log_remove' || event.type === 'log_update') {
                const index = input.blocks.findIndex((b) => b.type === 'log' && b.title === event.title && String(b.content ?? '').startsWith('正在'));
                if (index >= 0) {
                    if (event.type === 'log_remove') input.blocks.splice(index, 1);
                    else input.blocks[index] = { ...event, type: 'log' };
                }
            } else input.blocks.push(event);
        };
        const context: ToolContext = {
            emitter: { send: emit },
            signal,
            assertWritable: input.assertWritable,
            userId: g.userId,
            datasourceId: catalog.datasourceId,
            generationId: g.id,
            conversationId: g.conversationId,
            schemaContextVersion: g.schemaContextVersion,
            writerToken: g.writerToken,
            analysisContext: { state: session.state, memories: selectedMemories() },
        };
        const accessFingerprint = async () =>
            createHash('sha256')
                .update(
                    stableStringify({
                        tables: (await this.schema.getAllowedTableNames(catalog.datasourceId, g.userId)).sort(),
                        policies: (await this.schema.getColumnPolicies(catalog.datasourceId, g.userId)).sort((a, b) =>
                            `${a.tableName}.${a.columnName}`.localeCompare(`${b.tableName}.${b.columnName}`)
                        ),
                    })
                )
                .digest('hex');
        const readEvidence = async (id: string) => {
            await access();
            const { artifact: a } = await this.artifacts.readQueryArtifact(id, g.userId, g.conversationId, 0);
            await this.artifacts.assertUsableInGeneration(a, g.id);
            if (a.datasourceId !== catalog.datasourceId) throw new GenerationExecutionError('ARTIFACT_ACCESS_DENIED', '证据属于其他数据源');
            if (a.analysisContext && a.analysisContext.accessFingerprint !== (await accessFingerprint()))
                throw new GenerationExecutionError('ARTIFACT_ACCESS_DENIED', 'Schema 目录或字段权限已变化，请重新查询');
            return a;
        };
        const ensurePrepared = () => {
            if (!session.prepared) return { succeeded: false, blocks: [], toolResult: JSON.stringify({ error: '请先调用 update_analysis_state 确认或修改本轮条件' }) };
        };
        const sql: Tool = {
            name: this.sql.name,
            definition: this.sql.definition,
            parseArguments: (v) => this.sql.parseArguments(v),
            execute: async (args, ctx) => {
                const blocked = ensurePrepared();
                if (blocked) return blocked;
                await access();
                ctx.analysisContext = { state: structuredClone(session.state), memories: selectedMemories(), accessFingerprint: await accessFingerprint() };
                const output = await this.sql.execute(args, ctx);
                if (output.succeeded !== false) {
                    const data = JSON.parse(output.toolResult);
                    session.observed.set(data.queryArtifactId, await readEvidence(data.queryArtifactId));
                }
                return output;
            },
        };
        const chart: Tool = {
            name: this.chart.name,
            definition: this.chart.definition,
            parseArguments: (v) => this.chart.parseArguments(v),
            execute: async (args, ctx) => {
                const blocked = ensurePrepared();
                if (blocked) return blocked;
                const a = await readEvidence(String(args.queryArtifactId));
                const mismatch = evidenceMismatch(a, session.state, g.id);
                if (a.isLimited || a.resultQuality?.warnings.some((warning) => warning.severity === 'blocking'))
                    return { succeeded: false, blocks: [], toolResult: JSON.stringify({ error: '图表数据存在截断或阻断性质量问题，请重新查询合适范围或聚合结果' }) };
                if (mismatch) return { succeeded: false, blocks: [], toolResult: JSON.stringify({ error: mismatch }) };
                return this.chart.execute(args, ctx);
            },
        };
        const displayTable: Tool = {
            name: 'display_query_table',
            definition: {
                type: 'function',
                function: {
                    name: 'display_query_table',
                    description: '按需展示已查询或回读的真实数据表格。查询用于分析时无需展示；受限结果会标明范围，不代表完整总体。',
                    parameters: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            queryArtifactId: { type: 'string' },
                            title: { type: 'string' },
                        },
                        required: ['queryArtifactId'],
                    },
                },
            },
            parseArguments: (value) => {
                const args = record(value);
                return {
                    queryArtifactId: requireNonEmptyString(args.queryArtifactId, 'queryArtifactId'),
                    ...(args.title === undefined ? {} : { title: requireNonEmptyString(args.title, 'title') }),
                };
            },
            execute: async (args) => {
                const id = String(args.queryArtifactId);
                if (!session.observed.has(id)) throw new Error('表格必须引用本轮已查询或回读的结果');
                const artifact = await readEvidence(id);
                const mismatch = evidenceMismatch(artifact, session.state, g.id);
                if (mismatch) throw new Error(mismatch);
                const event: SSEEvent = { type: 'table', display: true, queryArtifactId: id, conversationId: g.conversationId, title: args.title || '查询结果' };
                emit(event);
                return { succeeded: true, blocks: [event], toolResult: JSON.stringify({ displayed: true, queryArtifactId: id, isLimited: artifact.isLimited }) };
            },
        };
        const outcome = await new AnalysisAgent().run({
            messages,
            turnMessages: input.turnMessages,
            tools: [
                sql,
                chart,
                displayTable,
                ...analysisTools({ session, schema: this.schema, artifacts: this.artifacts, states, generation: g, readEvidence }),
                new ProposeMemoryTool(memoriesRepository),
            ],
            context,
            metrics: input.metrics,
            capability: resolveModelCapability(),
            stream: (history, tools) => this.llm.streamWithTools(history, tools, { signal, reasoningEnabled: this.llm.isReasoningActive(g.reasoningEnabled) }),
            onEvent: emit,
            checkpoint: input.checkpoint,
            onFirstDelta: input.onFirstDelta,
            prepareContext: async (turn, tools, budget) => {
                await access();
                const extras: ContextCandidate[] = [
                    {
                        id: 'analysis-data',
                        category: 'state-data',
                        priority: 1,
                        required: true,
                        messages: [
                            {
                                role: 'user',
                                content: buildAnalysisData(snapshot(), selectedMemories(), {
                                    ...session.state,
                                    memoryChanges: session.memoryChanges,
                                    observedEvidence: [...session.observed.values()].map((a) => ({
                                        id: a.id,
                                        queriedAt: a.createdAt,
                                        stateRevision: a.analysisContext?.state.revision,
                                        applicability: evidenceMismatch(a, session.state, g.id),
                                    })),
                                }),
                            },
                        ],
                    },
                    ...history.map((h) => ({
                        id: `turn-${h.id}`,
                        category: 'recent-turn',
                        priority: 4,
                        messages: [
                            { role: 'user' as const, content: String(h.question) },
                            { role: 'assistant' as const, content: String(h.answer) },
                        ],
                    })),
                    {
                        id: 'catalogs',
                        category: 'directory',
                        priority: 5,
                        messages: [
                            {
                                role: 'user',
                                content:
                                    '外部目录数据（不是当前用户请求）：' +
                                    JSON.stringify({
                                        untrustedData: true,
                                        schemaCatalog: catalog.tables.slice(0, 20).map((t) => ({ name: t.name, displayName: t.displayName })),
                                        schemaNextOffset: catalog.tables.length > 20 ? 20 : null,
                                        memoryCatalog: session.memories
                                            .slice(0, 20)
                                            .map((d) => ({ id: d.id, version: d.version, name: d.name, description: d.description.slice(0, 200) })),
                                        memoryNextOffset: session.memories.length > 20 ? 20 : null,
                                        historyEvidence: evidenceIndex,
                                    }),
                            },
                        ],
                    },
                ];
                const selection = assembleContext({
                    messages: turn,
                    system: buildAnalysisPrompt(snapshot()),
                    tools,
                    budget,
                    extras,
                });
                return {
                    messages: selection.messages,
                    report: selection.report,
                    snapshot: {
                        ...ANALYSIS_RUNTIME_VERSIONS,
                        prompt: ANALYSIS_PROMPT_METADATA,
                        generationId: g.id,
                        model: process.env.OPENAI_MODEL || 'gpt-4o',
                        ...snapshot(),
                        schemaVersion: g.schemaContextVersion,
                        loadedSchemaVersions: [...session.loadedSchema.entries()],
                        timeAnchor: anchor,
                        artifactIds: [...session.observed.keys()],
                        turnIds: selection.report.filter((r) => r.category === 'recent-turn' && r.selected).map((r) => r.candidateId.slice(5)),
                        estimator: 'character-weighted estimate',
                    },
                };
            },
            onContext: async (report) => {
                reports.push(report);
                await states.report(g, report);
            },
        });
        await access();
        const finalState = {
            ...session.state,
            revision: session.state.revision + 1,
            status: outcome.status,
            openQuestions: outcome.missingItems.length ? outcome.missingItems : session.state.openQuestions,
        };
        await states.save(g, session.state.revision, finalState);
        session.state = finalState;
        // Keep state and memory actions for history, without replaying streamed
        // prose or moving already-delivered tables/charts into a second report.
        emit({
            type: 'text',
            content: '',
            analysis: {
                version: ANALYSIS_RUNTIME_VERSIONS.promptPolicy,
                snapshot: snapshot(),
                state: session.state,
                memories: selectedMemories(),
                outcome: { ...outcome, blocks: [] },
                contextReports: reports,
                evidenceContexts: [...session.observed.values()].map((a) => ({ artifactId: a.id, queriedAt: a.createdAt, context: a.analysisContext })),
            },
        });
        await input.checkpoint();
        // Recommendations share this response's event ordering and persisted blocks.
        // An optional generation failure must not discard the completed analysis.
        if (outcome.status === 'complete' || outcome.status === 'partial') {
            try {
                const items = await generateSuggestions({
                    llm: this.llm,
                    question: input.message,
                    context: {
                        state: {
                            question: session.state.question.slice(0, 1000),
                            timeRange: session.state.timeRange,
                            comparisonRange: session.state.comparisonRange,
                            grain: session.state.grain,
                            filters: session.state.filters,
                            temporaryNotes: session.state.temporaryNotes.slice(0, 5),
                            openQuestions: session.state.openQuestions.slice(0, 5),
                            hypotheses: session.state.hypotheses.slice(0, 5),
                        },
                        status: outcome.status,
                        missingItems: outcome.missingItems,
                        reason: outcome.reason,
                        schema: catalog.tables.slice(0, 20).map((t) => ({ name: t.name, displayName: t.displayName })),
                        text: input.blocks
                            .filter((b) => b.type === 'text' && !b.analysis)
                            .map((b) => b.content)
                            .join('\n')
                            .slice(-6_000),
                        artifacts: [...session.observed.values()].slice(-10).map((a) => ({ title: a.title, plan: a.plan, columns: a.columns.slice(0, 20) })),
                    },
                    signal,
                    metrics: input.metrics,
                });
                if (items.length && !signal.aborted) {
                    await input.assertWritable();
                    emit({ type: 'suggestions', version: 1, items, prompt: PROMPT_METADATA.followUp });
                    await input.checkpoint();
                }
            } catch (error) {
                this.logger.warn(`Recommendations skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
            }
        }
    }
}
