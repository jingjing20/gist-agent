import type OpenAI from 'openai';
import type { AnalysisOutcome } from '@gist/contracts';
import { GenerationExecutionError } from '../chat/generation-errors';
import { estimateMessagesTokens, estimateTokens } from '../chat/token-estimator';
import { completeActivity, startActivity } from './analysis-activity';
import type { AnalysisActivityV1 } from '@gist/contracts';
import type { ModelCapability } from '../chat/model-capabilities';
import type { Tool, ToolContext, SSEEvent } from '../chat/tools/base-tool';
import type { GenerationExecutionMetrics } from '../chat/generation.service';
import { exactKeys, record, SUBMIT_TOOL, validateSubmission, type ObservedEvidence } from './submission';

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Call = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

export interface AnalysisRunOptions {
    messages: Message[];
    turnMessages: Message[];
    tools: Tool[];
    context: ToolContext;
    capability: ModelCapability;
    metrics: GenerationExecutionMetrics;
    stream(messages: Message[], tools: OpenAI.Chat.Completions.ChatCompletionTool[]): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
    onEvent(event: SSEEvent): void;
    checkpoint(): Promise<void>;
    onFirstDelta(): Promise<void>;
    onContext(report: { estimatedTokens: number; budget: number; call: number; closing: boolean; selection?: unknown; snapshot?: unknown }): void | Promise<void>;
    prepareContext?(messages: Message[], tools: OpenAI.Chat.Completions.ChatCompletionTool[], budget: number): Promise<{ messages: Message[]; report: unknown; snapshot: unknown }>;
    observeEvidence?(id: string): Promise<ObservedEvidence>;
    validateOutcome?(outcome: AnalysisOutcome): Promise<void>;
    validateEvidence?(ids: string[]): Promise<void>;
}

/** One decision loop. No queue, transport lifetime, background extraction or model-in-tool logic. */
export class AnalysisAgent {
    async run(options: AnalysisRunOptions): Promise<AnalysisOutcome> {
        const { messages, turnMessages, context, metrics } = options;
        const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
        const observed = new Map<string, ObservedEvidence>();
        const generatedCharts = new Map<string, string>();
        const failedQueries = new Map<string, number>();
        const blockedQueries = new Set<string>();
        const callIds = new Set<string>();
        let modelCalls = 0;
        let repeatedAction = '';
        let repeatedActionCount = 0;
        let textOnlyCount = 0;
        let firstDelta = false;
        let contextRetried = false;
        const check = async () => {
            if (context.signal.aborted) throw context.signal.reason ?? new GenerationExecutionError('CANCELLED', '已取消');
            await context.assertWritable();
            if (context.signal.aborted) throw context.signal.reason ?? new GenerationExecutionError('CANCELLED', '已取消');
        };
        const append = (message: Message) => {
            messages.push(message);
            turnMessages.push(message);
        };
        while (true) {
            await check();
            const definitions = [...options.tools.map((t) => t.definition), SUBMIT_TOOL];
            let input: Message[] = [...messages];
            const budget = Math.floor(
                (options.capability.contextWindow - options.capability.responseReserve - Math.ceil(options.capability.contextWindow * 0.1)) * (contextRetried ? 0.75 : 1)
            );
            const prepared = await options.prepareContext?.(input, definitions, budget);
            if (prepared) input = prepared.messages;
            const estimatedTokens = estimateMessagesTokens(input) + estimateTokens(JSON.stringify(definitions));
            await options.onContext({
                estimatedTokens,
                budget,
                call: modelCalls + 1,
                closing: false,
                ...(prepared ? { selection: prepared.report, snapshot: prepared.snapshot } : {}),
            });
            if (estimatedTokens > budget) throw new GenerationExecutionError('CONTEXT_BUDGET_EXCEEDED', '当前问题、Schema 与工具证据超过上下文预算，请缩小问题范围');
            modelCalls++;
            metrics.llmCallCount++;
            metrics.inputTokensEstimated += estimatedTokens;
            const progressTitle = `分析步骤 ${modelCalls}`;
            options.onEvent({ type: 'log', title: progressTitle, content: '正在评估下一步行动...' });
            const calls = new Map<number, Call>();
            let content = '';
            let reasoning = '';
            let outputChars = 0;
            try {
                const stream = await options.stream(input, definitions);
                for await (const chunk of stream) {
                    await check();
                    const delta = chunk.choices[0]?.delta as (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string }) | undefined;
                    if (!delta) continue;
                    const fragment = delta.content ?? '';
                    const thoughts = delta.reasoning_content ?? '';
                    content += fragment;
                    reasoning += thoughts;
                    outputChars += fragment.length + thoughts.length;
                    metrics.outputTokensEstimated += estimateTokens(fragment + thoughts);
                    if (!firstDelta && (fragment || thoughts || delta.tool_calls?.length)) {
                        firstDelta = true;
                        await options.onFirstDelta();
                    }
                    for (const part of delta.tool_calls ?? []) {
                        if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 24) throw new GenerationExecutionError('ANALYSIS_PROTOCOL_ERROR', '工具索引不合法');
                        const call = calls.get(part.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
                        if (part.id) call.id = part.id;
                        if (part.function?.name) call.function.name += part.function.name;
                        if (part.function?.arguments) {
                            call.function.arguments += part.function.arguments;
                            outputChars += part.function.arguments.length;
                            metrics.outputTokensEstimated += estimateTokens(part.function.arguments);
                        }
                        calls.set(part.index, call);
                    }
                    if (outputChars > 128_000) throw new GenerationExecutionError('ANALYSIS_PROTOCOL_ERROR', '模型响应超过大小上限');
                }
            } catch (error) {
                await check();
                if (error instanceof GenerationExecutionError) throw error;
                if (!contextRetried && outputChars === 0 && ['context_length_exceeded', 'max_context_length'].includes(String((error as { code?: string }).code))) {
                    contextRetried = true;
                    options.onEvent({ type: 'log_update', title: progressTitle, content: '需要调整：上下文过长，将缩减后重试。' });
                    continue;
                }
                throw new GenerationExecutionError('LLM_REQUEST_FAILED', '模型请求或响应流失败');
            }
            await check();
            const batch = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
            if (!batch.length) {
                if (!content.trim()) throw new GenerationExecutionError('EMPTY_LLM_RESPONSE', '模型未返回正式结果或工具调用');
                if (++textOnlyCount >= 3) throw new GenerationExecutionError('ANALYSIS_NO_PROGRESS', '模型连续返回未提交的文字，分析未取得进展；请重试。');
                options.onEvent({ type: 'log_update', title: progressTitle, content: '需要调整：已收到模型回复，继续整理为正式结果。' });
                // Unstructured text is not a final answer; do not publish unsupported conclusions.
                append({ role: 'assistant', content });
                messages.push({ role: 'system', content: '请通过 submit_analysis 提交正式结果，不能只输出自由文本。' });
                continue;
            }
            textOnlyCount = 0;
            for (const call of batch) {
                if (!call.id || !call.function.name || callIds.has(call.id)) throw new GenerationExecutionError('ANALYSIS_PROTOCOL_ERROR', '工具调用 ID 缺失或重复');
                callIds.add(call.id);
            }
            const assistant: Message = { role: 'assistant', content: content || null, tool_calls: batch };
            // Provider continuity only. Raw reasoning never becomes a UI event.
            if (reasoning) Object.assign(assistant, { reasoning_content: reasoning });
            append(assistant);
            const mixedSubmit = batch.length > 1 && batch.some((call) => call.function.name === 'submit_analysis');
            const mixedState = batch.length > 1 && batch.some((call) => call.function.name === 'update_analysis_state');
            const previouslyObserved = new Set(observed.keys());
            let final: AnalysisOutcome | undefined;
            let needsCorrection = false;
            const actionLabels: Record<string, string> = {
                update_analysis_state: '确认分析条件',
                get_analysis_state: '读取分析状态',
                list_schema: '查看数据目录',
                get_schema: '读取表结构',
                list_memories: '查看记忆',
                read_memory: '读取记忆',
                execute_sql_query: '查询数据',
                read_query_artifact: '读取查询证据',
                generate_chart: '生成图表',
                submit_analysis: '提交分析结果',
                propose_memory: '提出记忆',
            };
            const actions = [...new Set(batch.map((c) => actionLabels[c.function.name] ?? '执行分析工具'))].join('、');
            for (const call of batch) {
                await check();
                let result: string;
                let activity: AnalysisActivityV1 | undefined;
                let activityRemoved = false;
                const removeActivity = () => {
                    if (!activity || activityRemoved) return;
                    options.onEvent({ type: 'analysis_activity_remove', activityId: activity.id });
                    activityRemoved = true;
                };
                try {
                    if (mixedState) throw new Error('状态更新必须独立调用，收到成功结果后才能执行其他工具');
                    if (mixedSubmit) throw new Error('提交结果必须独立调用，不允许与其他工具混用');
                    const args = record(JSON.parse(call.function.arguments));
                    if (call.function.name === 'submit_analysis') {
                        const candidate = validateSubmission(args, observed, generatedCharts);
                        await options.validateOutcome?.(candidate);
                        const ids =
                            candidate.kind === 'response'
                                ? candidate.blocks.flatMap((block) =>
                                      block.type === 'table' ? [block.artifactId] : block.type === 'chart' ? [generatedCharts.get(block.chartArtifactId)!] : []
                                  )
                                : candidate.kind === 'table'
                                  ? candidate.tables.map((table) => table.artifactId)
                                  : candidate.kind === 'direct'
                                    ? candidate.evidence
                                    : candidate.kind === 'answer' || candidate.kind === 'partial'
                                      ? candidate.answer.findings.flatMap((f) => f.evidence.map((e) => e.artifactId))
                                      : [];
                        await options.validateEvidence?.([...new Set(ids)]);
                        await check();
                        final = candidate;
                        result = JSON.stringify({ accepted: true, kind: final.kind });
                    } else {
                        metrics.toolCallCount++;
                        const tool = tools.get(call.function.name);
                        if (!tool) throw new Error('未知或不可用工具');
                        exactKeys(args, Object.keys((tool.definition.function.parameters as { properties?: Record<string, unknown> })?.properties ?? {}));
                        if (args.plan) exactKeys(record(args.plan), ['purpose', 'expectedGrain', 'expectedShape']);
                        const parsed = tool.parseArguments(args);
                        activity = startActivity(call.id, tool.name, parsed, new Date(), `analysis-round-${modelCalls}`);
                        if (activity) options.onEvent({ type: 'analysis_activity', activity });
                        if (tool.name === 'generate_chart' && !previouslyObserved.has(String(parsed.queryArtifactId))) throw new Error('图表必须引用本轮已观察到的证据');
                        let sqlKey = '';
                        if (tool.name === 'execute_sql_query') {
                            sqlKey = String(parsed.sql).trim();
                            if (blockedQueries.has(sqlKey)) throw new Error('同一查询已重复失败，请修改查询或提交部分结果');
                            metrics.sqlCallCount++;
                        }
                        let output;
                        try {
                            output = await tool.execute(parsed, context);
                        } catch (error) {
                            removeActivity();
                            await check();
                            if (error instanceof GenerationExecutionError) throw error;
                            throw new GenerationExecutionError('TOOL_EXECUTION_FAILED', '工具执行失败，未生成有效结果');
                        }
                        await check();
                        result = output.toolResult;
                        if (output.succeeded === false) needsCorrection = true;
                        const data = JSON.parse(result);
                        if (activity) {
                            if (output.succeeded === false) removeActivity();
                            else options.onEvent({ type: 'analysis_activity', activity: completeActivity(activity, tool.name, parsed, data, output.activityData) });
                        }
                        if (tool.name === 'read_query_artifact' && output.succeeded !== false && options.observeEvidence)
                            observed.set(data.queryArtifactId, await options.observeEvidence(data.queryArtifactId));
                        if (tool.name === 'generate_chart' && output.succeeded !== false && typeof data.chartArtifactId === 'string')
                            generatedCharts.set(data.chartArtifactId, String(data.queryArtifactId));
                        if (tool.name === 'execute_sql_query') {
                            if (output.succeeded !== false) {
                                if (typeof data.queryArtifactId !== 'string') throw new GenerationExecutionError('TOOL_EXECUTION_FAILED', '查询成功但缺少持久化证据');
                                observed.set(data.queryArtifactId, {
                                    sql: sqlKey,
                                    blocked: data.isLimited === true || data.resultQuality?.warnings?.some((w: { severity: string }) => w.severity === 'blocking') === true,
                                });
                            } else {
                                const key = JSON.stringify([sqlKey, data.errorCode]);
                                const count = (failedQueries.get(key) ?? 0) + 1;
                                failedQueries.set(key, count);
                                if (count >= 2) blockedQueries.add(sqlKey);
                            }
                        }
                    }
                } catch (error) {
                    removeActivity();
                    await check();
                    if (error instanceof GenerationExecutionError) {
                        if (error.code === 'SQL_SECURITY_REJECTED' || error.code === 'DATASOURCE_ACCESS_CHANGED') {
                            result = JSON.stringify({ errorCode: error.code, retryable: false });
                            append({ role: 'tool', tool_call_id: call.id, content: result });
                            for (const skipped of batch.slice(batch.indexOf(call) + 1)) {
                                append({ role: 'tool', tool_call_id: skipped.id, content: JSON.stringify({ skipped: true, reason: 'SECURITY_STOP' }) });
                            }
                            options.onEvent({ type: 'log_update', title: progressTitle, content: `未完成：${actions}；查询被访问或安全规则阻止。` });
                            return {
                                kind: 'refusal',
                                explanation:
                                    error.code === 'DATASOURCE_ACCESS_CHANGED'
                                        ? '当前数据源访问权限已变化，分析已停止。请确认数据源权限后重试。'
                                        : '本次生成的 SQL 未通过安全校验，查询已停止。请重试；若持续出现，请检查查询语法与允许访问的表或字段。',
                            };
                        }
                        throw error;
                    }
                    needsCorrection = true;
                    final = undefined;
                    result = JSON.stringify({
                        errorCode: 'INVALID_TOOL_ARGUMENTS',
                        message: error instanceof Error ? error.message : '工具参数不合法',
                        retryable: true,
                        ...(call.function.name === 'submit_analysis' ? { submissionGuide: SUBMIT_TOOL.function.description } : {}),
                    });
                }
                append({ role: 'tool', tool_call_id: call.id, content: result });
                const action = `${call.function.name}:${call.function.arguments}`;
                repeatedActionCount = action === repeatedAction ? repeatedActionCount + 1 : 1;
                repeatedAction = action;
                if (repeatedActionCount >= 3) throw new GenerationExecutionError('ANALYSIS_NO_PROGRESS', '模型连续重复相同操作，分析未取得进展；请调整问题后重试。');
            }
            options.onEvent({
                type: 'log_update',
                title: progressTitle,
                content: `${needsCorrection ? '需要调整' : '已完成'}：${actions}${needsCorrection ? '；已将错误反馈给模型修正。' : '。'}`,
            });
            await options.checkpoint();
            await check();
            if (final) return final;
        }
    }
}
