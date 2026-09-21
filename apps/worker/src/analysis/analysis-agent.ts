import type OpenAI from 'openai';
import type { AnalysisOutcome } from '@gist/contracts';
import { GenerationExecutionError } from '../chat/generation-errors';
import { estimateMessagesTokens, estimateTokens } from '../chat/token-estimator';
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
    onContext(report: { estimatedTokens: number; budget: number; call: number; closing: boolean }): void;
    limits?: { modelCalls?: number; sqlCalls?: number; toolCalls?: number };
    validateEvidence?(ids: string[]): Promise<void>;
}

/** One decision loop. No queue, transport lifetime, background extraction or model-in-tool logic. */
export class AnalysisAgent {
    async run(options: AnalysisRunOptions): Promise<AnalysisOutcome> {
        const { messages, turnMessages, context, metrics } = options;
        const maxModel = options.limits?.modelCalls ?? 12;
        const maxSql = options.limits?.sqlCalls ?? 8;
        const maxTools = options.limits?.toolCalls ?? 24;
        if (![maxModel, maxSql, maxTools].every(Number.isInteger) || maxModel < 2 || maxSql < 1 || maxTools < 1) throw new Error('Invalid analysis budgets');
        const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
        const observed = new Map<string, ObservedEvidence>();
        const failedQueries = new Map<string, number>();
        const blockedQueries = new Set<string>();
        const callIds = new Set<string>();
        let modelCalls = 0;
        let sqlCalls = 0;
        let toolCalls = 0;
        let firstDelta = false;
        const check = async () => {
            if (context.signal.aborted) throw context.signal.reason ?? new GenerationExecutionError('CANCELLED', '已取消');
            await context.assertWritable();
            if (context.signal.aborted) throw context.signal.reason ?? new GenerationExecutionError('CANCELLED', '已取消');
        };
        const append = (message: Message) => {
            messages.push(message);
            turnMessages.push(message);
        };
        while (modelCalls < maxModel) {
            await check();
            const closing = modelCalls === maxModel - 1 || sqlCalls >= maxSql || toolCalls >= maxTools;
            const definitions = closing ? [SUBMIT_TOOL] : [...options.tools.map((t) => t.definition), SUBMIT_TOOL];
            const input: Message[] = closing
                ? [
                      ...messages,
                      {
                          role: 'system',
                          content: '本轮执行预算已耗尽。只允许调用 submit_analysis，kind 必须是 partial，说明已知事实、局限与待验证问题。不得新增查询或假装分析完成。',
                      },
                  ]
                : [...messages];
            const estimatedTokens = estimateMessagesTokens(input) + estimateTokens(JSON.stringify(definitions));
            const budget = options.capability.contextWindow - options.capability.responseReserve - Math.ceil(options.capability.contextWindow * 0.1);
            options.onContext({ estimatedTokens, budget, call: modelCalls + 1, closing });
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
                throw new GenerationExecutionError('LLM_REQUEST_FAILED', '模型请求或响应流失败');
            }
            await check();
            options.onEvent({ type: 'log_remove', title: progressTitle });
            const batch = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
            if (!batch.length) {
                if (!content.trim()) throw new GenerationExecutionError('EMPTY_LLM_RESPONSE', '模型未返回正式结果或工具调用');
                // Unstructured text is not a final answer; do not publish unsupported conclusions.
                append({ role: 'assistant', content });
                messages.push({ role: 'system', content: '请通过 submit_analysis 提交正式结果，不能只输出自由文本。' });
                continue;
            }
            for (const call of batch) {
                if (!call.id || !call.function.name || callIds.has(call.id)) throw new GenerationExecutionError('ANALYSIS_PROTOCOL_ERROR', '工具调用 ID 缺失或重复');
                callIds.add(call.id);
            }
            const assistant: Message = { role: 'assistant', content: content || null, tool_calls: batch };
            // Provider continuity only. Raw reasoning never becomes a UI event.
            if (reasoning) Object.assign(assistant, { reasoning_content: reasoning });
            append(assistant);
            const mixedSubmit = batch.length > 1 && batch.some((call) => call.function.name === 'submit_analysis');
            const previouslyObserved = new Set(observed.keys());
            let final: AnalysisOutcome | undefined;
            for (const call of batch) {
                await check();
                let result: string;
                try {
                    if (mixedSubmit) throw new Error('提交结果必须独立调用，不允许与其他工具混用');
                    const args = record(JSON.parse(call.function.arguments));
                    if (call.function.name === 'submit_analysis') {
                        final = validateSubmission(args, observed, closing);
                        const ids = final.kind === 'answer' || final.kind === 'partial' ? final.answer.findings.flatMap((f) => f.evidence.map((e) => e.artifactId)) : [];
                        await options.validateEvidence?.([...new Set(ids)]);
                        await check();
                        result = JSON.stringify({ accepted: true, kind: final.kind });
                    } else {
                        if (closing || toolCalls >= maxTools) throw new Error('普通工具预算已耗尽，请提交部分结果');
                        toolCalls++;
                        metrics.toolCallCount++;
                        const tool = tools.get(call.function.name);
                        if (!tool) throw new Error('未知或不可用工具');
                        exactKeys(args, Object.keys((tool.definition.function.parameters as { properties?: Record<string, unknown> })?.properties ?? {}));
                        if (args.plan) exactKeys(record(args.plan), ['purpose', 'expectedGrain', 'expectedShape']);
                        const parsed = tool.parseArguments(args);
                        if (tool.name === 'generate_chart' && !previouslyObserved.has(String(parsed.queryArtifactId))) throw new Error('图表必须引用本轮已观察到的证据');
                        let sqlKey = '';
                        if (tool.name === 'execute_sql_query') {
                            if (sqlCalls >= maxSql) throw new Error('SQL 预算已耗尽');
                            sqlKey = String(parsed.sql).trim();
                            if (blockedQueries.has(sqlKey)) throw new Error('同一查询已重复失败，请修改查询或提交部分结果');
                            sqlCalls++;
                            metrics.sqlCallCount++;
                        }
                        let output;
                        try {
                            output = await tool.execute(parsed, context);
                        } catch (error) {
                            await check();
                            if (error instanceof GenerationExecutionError) throw error;
                            throw new GenerationExecutionError('TOOL_EXECUTION_FAILED', '工具执行失败，未生成有效结果');
                        }
                        await check();
                        result = output.toolResult;
                        const data = JSON.parse(result);
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
                    await check();
                    if (error instanceof GenerationExecutionError) {
                        if (error.code === 'SQL_SECURITY_REJECTED' || error.code === 'DATASOURCE_ACCESS_CHANGED') {
                            result = JSON.stringify({ errorCode: error.code, retryable: false });
                            append({ role: 'tool', tool_call_id: call.id, content: result });
                            for (const skipped of batch.slice(batch.indexOf(call) + 1)) {
                                append({ role: 'tool', tool_call_id: skipped.id, content: JSON.stringify({ skipped: true, reason: 'SECURITY_STOP' }) });
                            }
                            return { kind: 'refusal', explanation: '当前请求无法在授权的数据与安全查询范围内完成。' };
                        }
                        throw error;
                    }
                    final = undefined;
                    result = JSON.stringify({ errorCode: 'INVALID_TOOL_ARGUMENTS', message: error instanceof Error ? error.message : '工具参数不合法', retryable: true });
                }
                append({ role: 'tool', tool_call_id: call.id, content: result });
            }
            await options.checkpoint();
            await check();
            if (final) return final;
        }
        throw new GenerationExecutionError('MAX_AGENT_ITERATIONS_EXCEEDED', '分析预算已耗尽，模型未能提交有效的部分结果');
    }
}
