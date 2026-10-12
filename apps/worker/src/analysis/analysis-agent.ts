import type OpenAI from 'openai';
import type { AnalysisOutcome } from '@gist/contracts';
import { GenerationExecutionError } from '../chat/generation-errors';
import { estimateMessagesTokens, estimateTokens } from '../chat/token-estimator';
import { completeActivity, startActivity } from './analysis-activity';
import type { AnalysisActivityV1 } from '@gist/contracts';
import type { ModelCapability } from '../chat/model-capabilities';
import type { Tool, ToolContext, SSEEvent } from '../chat/tools/base-tool';
import type { GenerationExecutionMetrics } from '../chat/generation.service';
import { exactKeys, record } from './tool-arguments';
import { FINISH_TOOL, validateFinish } from './finish-analysis';
import { predominantlyEnglish, ResponseTextStream } from './response-text-stream';
import { actionNarrative } from './analysis-narrative';

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Call = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

function expectsChinese(messages: Message[]): boolean {
    const question = messages.find((message) => message.role === 'user')?.content;
    if (typeof question !== 'string') return false;
    return (
        /[\u4e00-\u9fff]/.test(question) &&
        !/(?:用|使用|以|改成|切换到|请)(?:\s*)(?:英文|英语|法语|法文|日语|日文|德语|德文|西班牙语|韩语|韩文)|\b(?:in|use|answer in) (?:English|French|Japanese|German|Spanish|Korean)\b/i.test(
            question
        )
    );
}

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
}

/** One decision loop. No queue, transport lifetime, background extraction or model-in-tool logic. */
export class AnalysisAgent {
    async run(options: AnalysisRunOptions): Promise<AnalysisOutcome> {
        const { messages, turnMessages, context, metrics } = options;
        const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
        const observed = new Set<string>();
        const failedQueries = new Map<string, number>();
        const blockedQueries = new Set<string>();
        const callIds = new Set<string>();
        let modelCalls = 0;
        let repeatedAction = '';
        let repeatedActionCount = 0;
        let delivered = false;
        let answered = false;
        let awaitingConclusion = false;
        const question = messages.find((message) => message.role === 'user')?.content;
        const visualOnly =
            typeof question === 'string' &&
            /(?:只|仅)(?:需要|需|要|输出|展示|显示)?\s*(?:图表|表格|图|表)|\b(?:only|just)\s+(?:a\s+|the\s+)?(?:chart|table)\b/i.test(question) &&
            !/(?:最后|最终|并|同时)[^。！？]{0,15}(?:总结|结论|解释)|\b(?:summary|summarize|explain)\b/i.test(question);
        let finishReminders = 0;
        let closingOnly = false;
        let responseText = '';
        let hasVisibleText = false;
        const chineseResponse = expectsChinese(messages);
        let languageRetries = 0;
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
            // The finish tool records status only; narrative remains streamed.
            const definitions = closingOnly || awaitingConclusion ? [FINISH_TOOL] : [...options.tools.map((t) => t.definition), FINISH_TOOL];
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
            let roundTextStarted = false;
            const publishText = (text: string) => {
                if (!text || closingOnly) return;
                options.onEvent({ type: 'text_chunk', content: `${!roundTextStarted && hasVisibleText ? '\n\n' : ''}${text}` });
                roundTextStarted = true;
                hasVisibleText = true;
            };
            const textStream = new ResponseTextStream(chineseResponse);
            let reasoning = '';
            let outputChars = 0;
            try {
                const stream = await options.stream(input, definitions);
                for await (const chunk of stream) {
                    // Publishing and tool boundaries independently fence writer ownership.
                    // Do not round-trip to the database for every model token.
                    if (context.signal.aborted) throw context.signal.reason ?? new GenerationExecutionError('CANCELLED', '已取消');
                    const delta = chunk.choices[0]?.delta as (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string }) | undefined;
                    if (!delta) continue;
                    const fragment = delta.content ?? '';
                    const thoughts = delta.reasoning_content ?? '';
                    content += fragment;
                    const visibleText = textStream.push(fragment);
                    publishText(visibleText);
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
            if (!closingOnly && chineseResponse && !textStream.published && predominantlyEnglish(content)) {
                if (batch.some((call) => call.function.name !== 'finish_analysis')) {
                    // Optional prose must not discard valid work or add a model round.
                    // A Chinese action description will replace the withheld preamble.
                    content = '';
                } else {
                    if (languageRetries++ >= 1) throw new GenerationExecutionError('RESPONSE_LANGUAGE_MISMATCH', '模型未按要求使用中文回答，请重试。');
                    messages.push({ role: 'assistant', content });
                    messages.push({
                        role: 'system',
                        content: '用户使用中文提问。请用中文重新回答，保留字段名、SQL 和技术标识符；不要重复已经完成的工具。回答后独立调用 finish_analysis。',
                    });
                    continue;
                }
            }
            const remainingText = textStream.finish(content);
            publishText(remainingText);
            if (content.trim() && !closingOnly) responseText += (responseText ? '\n\n' : '') + content;
            if (content.trim() && !closingOnly && batch.every((call) => call.function.name === 'finish_analysis')) answered = true;
            if (!batch.length) {
                if (content.trim()) {
                    const answer: Message = { role: 'assistant', content };
                    if (reasoning) Object.assign(answer, { reasoning_content: reasoning });
                    append(answer);
                }
                await options.checkpoint();
                closingOnly = true;
                if (finishReminders++) throw new GenerationExecutionError('ANALYSIS_PROTOCOL_ERROR', '回答已保留，但模型未确认完成状态，请重试。');
                messages.push({
                    role: 'system',
                    content: '请勿重复正文或工具。现在仅调用 finish_analysis 记录真实完成状态；缺少结果时标记 partial，需要用户补充时标记 awaiting_clarification。',
                });
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
            const mixedFinish = batch.length > 1 && batch.some((call) => call.function.name === 'finish_analysis');
            const mixedState = batch.length > 1 && batch.some((call) => call.function.name === 'update_analysis_state');
            const previouslyObserved = new Set(observed);
            let final: AnalysisOutcome | undefined;
            let needsCorrection = false;
            const narratedActions = new Set<string>();
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
                finish_analysis: '确认完成状态',
                propose_memory: '提出记忆',
            };
            const actions = [...new Set(batch.map((c) => actionLabels[c.function.name] ?? '执行分析工具'))].join('、');
            for (const call of batch) {
                await check();
                let result: string;
                let activity: AnalysisActivityV1 | undefined;
                let activityRemoved = false;
                const reportFailure = (message: string, sql?: string) => {
                    const failed = activity ?? startActivity(call.id, call.function.name, {}, new Date(), `analysis-round-${modelCalls}`);
                    if (failed)
                        options.onEvent({
                            type: 'analysis_activity',
                            activity: {
                                ...failed,
                                status: 'warning',
                                completedAt: new Date().toISOString(),
                                warning: message,
                                details: [...failed.details, { label: '错误详情', value: message }, ...(sql ? [{ label: '提交 SQL', value: sql }] : [])],
                            },
                        });
                    if (!content.trim() && call.function.name === 'execute_sql_query') publishText(`${roundTextStarted ? '\n\n' : ''}本次查询未成功，我会根据反馈调整后重新核对。`);
                };
                const removeActivity = () => {
                    if (!activity || activityRemoved) return;
                    options.onEvent({ type: 'analysis_activity_remove', activityId: activity.id });
                    activityRemoved = true;
                };
                try {
                    if (mixedState) throw new Error('状态更新必须独立调用，收到成功结果后才能执行其他工具');
                    if (mixedFinish) throw new Error('finish_analysis 必须独立调用，展示工具完成后再收尾');
                    const args = record(JSON.parse(call.function.arguments));
                    if (call.function.name === 'finish_analysis') {
                        // Repair status arguments without restarting delivered analysis.
                        if (!answered && !(delivered && visualOnly)) {
                            if (delivered) {
                                awaitingConclusion = true;
                                throw new Error('图表或表格已展示，但还缺少最终结论。请先用本轮提问语言简短总结已有结果，不再查询或绘图，然后调用 finish_analysis。');
                            }
                            throw new Error('尚未向用户交付内容，请先回答、提问或解释无法完成的原因');
                        }
                        closingOnly = true;
                        const finish = validateFinish(args);
                        final = { kind: 'response', ...finish, blocks: responseText ? [{ type: 'markdown', content: responseText }] : [] };
                        result = JSON.stringify({ accepted: true, status: finish.status });
                    } else {
                        if (closingOnly || awaitingConclusion) throw new Error('分析工具已经结束，请只补充所需结论并调用 finish_analysis，不再查询或绘图');
                        metrics.toolCallCount++;
                        const tool = tools.get(call.function.name);
                        if (!tool) throw new Error('未知或不可用工具');
                        exactKeys(args, Object.keys((tool.definition.function.parameters as { properties?: Record<string, unknown> })?.properties ?? {}));
                        if (args.plan) exactKeys(record(args.plan), ['purpose', 'expectedGrain', 'expectedShape']);
                        const parsed = tool.parseArguments(args);
                        activity = startActivity(call.id, tool.name, parsed, new Date(), `analysis-round-${modelCalls}`);
                        if (tool.name === 'generate_chart' && !previouslyObserved.has(String(parsed.queryArtifactId))) throw new Error('图表必须引用本轮已观察到的证据');
                        let sqlKey = '';
                        if (tool.name === 'execute_sql_query') {
                            sqlKey = String(parsed.sql).trim();
                            if (blockedQueries.has(sqlKey)) throw new Error('同一查询已重复失败，请修改查询或提交部分结果');
                            metrics.sqlCallCount++;
                        }
                        // A silent model round still describes actual validated actions.
                        // Do not count fallback prose as delivery of an answer.
                        if (!content.trim() && !narratedActions.has(tool.name)) {
                            const narrative = actionNarrative(tool.name, parsed, chineseResponse);
                            if (narrative) {
                                publishText(`${roundTextStarted ? '\n\n' : ''}${narrative}`);
                                assistant.content = `${assistant.content ? `${assistant.content}\n\n` : ''}${narrative}`;
                                narratedActions.add(tool.name);
                            }
                        }
                        if (activity) options.onEvent({ type: 'analysis_activity', activity });
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
                        if (output.succeeded !== false && ['display_query_table', 'generate_chart'].includes(tool.name)) delivered = true;
                        if (output.succeeded === false) needsCorrection = true;
                        const data = JSON.parse(result);
                        if (activity) {
                            if (output.succeeded === false)
                                reportFailure(String(data.message || data.error || data.errorCode || '工具未成功完成'), typeof parsed.sql === 'string' ? parsed.sql : undefined);
                            else options.onEvent({ type: 'analysis_activity', activity: completeActivity(activity, tool.name, parsed, data, output.activityData) });
                        }
                        if (tool.name === 'read_query_artifact' && output.succeeded !== false) observed.add(data.queryArtifactId);
                        if (tool.name === 'execute_sql_query') {
                            if (output.succeeded !== false) {
                                if (typeof data.queryArtifactId !== 'string') throw new GenerationExecutionError('TOOL_EXECUTION_FAILED', '查询成功但缺少持久化证据');
                                observed.add(data.queryArtifactId);
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
                        removeActivity();
                        if (error.code === 'SQL_SECURITY_REJECTED' || error.code === 'DATASOURCE_ACCESS_CHANGED') {
                            result = JSON.stringify({ errorCode: error.code, retryable: false });
                            append({ role: 'tool', tool_call_id: call.id, content: result });
                            for (const skipped of batch.slice(batch.indexOf(call) + 1)) {
                                append({ role: 'tool', tool_call_id: skipped.id, content: JSON.stringify({ skipped: true, reason: 'SECURITY_STOP' }) });
                            }
                            options.onEvent({ type: 'log_update', title: progressTitle, content: `未完成：${actions}；查询被访问或安全规则阻止。` });
                            const explanation = error.code === 'DATASOURCE_ACCESS_CHANGED' ? '当前数据源访问权限已变化，分析已停止。' : '查询被访问或安全规则阻止，本次无法完成。';
                            options.onEvent({ type: 'text_chunk', content: explanation });
                            await options.checkpoint();
                            return { kind: 'response', status: 'unable_to_complete', reason: explanation, missingItems: [], blocks: [] };
                        }
                        throw error;
                    }
                    reportFailure(error instanceof Error ? error.message : '工具参数不合法');
                    needsCorrection = true;
                    final = undefined;
                    result = JSON.stringify({
                        errorCode: 'INVALID_TOOL_ARGUMENTS',
                        message: error instanceof Error ? error.message : '工具参数不合法',
                        retryable: true,
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
