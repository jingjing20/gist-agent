import { Injectable, Logger } from '@nestjs/common';
import { ConversationService } from '../conversation/conversation.service';
import { LlmService } from '../llm/llm.service';
import { ToolRegistry } from './tools/tool-registry';
import { PromptBuilder } from './prompt-builder';
import { GenerationService, type GenerationIdentity } from './generation.service';
import { SemanticDistillerService } from './agents/semantic-distiller.service';
import type { SSEEvent, SSEEmitter } from './tools/base-tool';
import type OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { GenerationReliabilityService, type GenerationPermit } from './generation-reliability.service';
import { workerConfig } from '@gist/config';
import type { GenerationStatus } from '@gist/contracts';
import type { GenerationErrorCode } from '@gist/contracts';
import { GenerationExecutionError, normalizeGenerationError } from './generation-errors';
import { AgentOrchestrator, type AgentOutcome } from './agent-orchestrator';

// Agent 循环上限：防止 LLM 陷入无限 tool_call 循环（如反复查错 SQL 又反复修）
const MAX_AGENT_ITERATIONS = 15;
// 全局超时熔断：无论 Agent 处于哪个阶段，超过此时间强制终止并返回错误
const CHAT_TIMEOUT_MS = Math.max(100, Number(process.env.CHAT_TIMEOUT_MS) || 300_000);
// 排查厂商流式 tool_call 协议差异时打开（DEBUG_TOOL_CALL_DELTA=1），生产环境关闭
const DEBUG_TOOL_CALL_DELTA = process.env.DEBUG_TOOL_CALL_DELTA === '1';

/**
 * 对话核心服务：编排 LLM 思考流程、管理上下文、触发工具执行并实时推送结果。
 */
@Injectable()
export class ChatService {
    private readonly logger = new Logger(ChatService.name);

    constructor(
        private readonly conversationService: ConversationService,
        private readonly llm: LlmService,
        private readonly toolRegistry: ToolRegistry,
        private readonly promptBuilder: PromptBuilder,
        private readonly distiller: SemanticDistillerService,
        private readonly generations: GenerationService,
        private readonly reliability: GenerationReliabilityService
    ) {}

    async executeGeneration(generationId: string): Promise<void> {
        const candidate = await this.generations.candidate(generationId);
        if (!candidate || ['completed', 'failed', 'cancelled'].includes(candidate.status)) return;
        if (candidate.status === 'cancel_requested') {
            const identity = { ...candidate, writerToken: '' };
            await this.generations.finalize(identity, 'cancelled', undefined, 'CANCELLED', { type: 'done', status: 'cancelled', errorCode: 'CANCELLED' });
            return;
        }
        if (candidate.status !== 'pending') return;

        const writerToken = randomUUID();
        let permit: GenerationPermit | null = await this.reliability.acquire({
            generationId,
            userId: candidate.userId,
            provider: process.env.LLM_PROVIDER || 'openai-compatible',
            token: writerToken,
        });
        if (!permit) throw new GenerationExecutionError('GENERATION_CAPACITY_UNAVAILABLE', '生成容量暂时不可用');
        const generation = await this.generations.claim(generationId, writerToken);
        if (!generation) {
            await this.reliability.release(permit);
            return;
        }

        const environment = workerConfig();
        let ownershipLost = false;
        const heartbeat = setInterval(
            () =>
                void Promise.all([this.generations.heartbeat(generationId, writerToken), this.reliability.renew(permit!)]).then(([databaseOwned, redisOwned]) => {
                    ownershipLost = !databaseOwned || !redisOwned;
                }),
            environment.heartbeatIntervalMs
        );
        heartbeat.unref();
        try {
            const request = await this.conversationService.getMessage(generation.requestMessageId, generation.conversationId, generation.userId);
            if (ownershipLost) throw new Error('WRITER_OWNERSHIP_LOST');
            await this.runGeneration(generation, request?.content ?? '', generation.datasourceId, () => ownershipLost);
        } finally {
            clearInterval(heartbeat);
            await this.reliability.release(permit);
            permit = null;
        }
    }

    private async runGeneration(generation: GenerationIdentity, message: string, datasourceId: number | null, ownershipLost: () => boolean): Promise<void> {
        const { conversationId, userId, messageId, reasoningEnabled } = generation;
        const controller = new AbortController();
        const signal = controller.signal;
        const emitter = this.generations.emitter(generation);
        const blocks: SSEEvent[] = [];
        const turnMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
        let timedOut = false;
        const cancelPoll = setInterval(() => {
            if (ownershipLost()) controller.abort(new GenerationExecutionError('WRITER_OWNERSHIP_LOST', '生成任务写入权已丢失'));
            else void this.generations.isCancelRequested(generation.id).then((cancelled) => cancelled && controller.abort(new GenerationExecutionError('CANCELLED', '已取消')));
        }, 500);
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort(new GenerationExecutionError('ANALYSIS_TIMEOUT', '分析超时，请尝试简化问题后重试'));
        }, CHAT_TIMEOUT_MS);
        timeout.unref();
        let terminal: SSEEvent = { type: 'done' };
        let finalStatus: GenerationStatus = 'completed';
        let errorDetail: string | undefined;
        let errorCode: GenerationErrorCode | undefined;

        // 全局定时器与用户取消共用同一 AbortController。
        // 超时时先 abort LLM/工具/SQL，等执行栈退出后再写终态。
        try {
            const reasoningActive = this.llm.isReasoningActive(reasoningEnabled);
            const systemPrompt = await this.promptBuilder.buildSystemPrompt(datasourceId, userId, conversationId);
            const messages = await this.promptBuilder.buildMessages(conversationId, userId, systemPrompt, {
                reasoningEnabled: reasoningActive,
                excludeMessageIds: [messageId],
                generationSnapshot: {
                    contextUpperBound: generation.contextUpperBound,
                    requestMessageId: generation.requestMessageId,
                },
            });
            await this.runAgentLoop(
                emitter,
                messages,
                turnMessages,
                blocks,
                datasourceId,
                userId,
                reasoningActive,
                signal,
                () => this.generations.checkpointMessage(generation, blocks, turnMessages),
                () => this.generations.markFirstDelta(generation),
                () => this.generations.assertWritable(generation)
            );
            if (signal.aborted) throw new GenerationExecutionError('CANCELLED', '已取消');
        } catch (err: unknown) {
            const cause = signal.aborted && signal.reason instanceof Error ? signal.reason : err;
            const normalized = normalizeGenerationError(cause, { ownershipLost: ownershipLost(), aborted: signal.aborted && !timedOut });
            this.logger.error(`handleChat failed conversationId=${conversationId} userId=${userId} code=${normalized.code}: ${normalized.message}`, normalized.stack);
            blocks.push({ type: 'error', content: normalized.message, errorCode: normalized.code });
            finalStatus = normalized.code === 'CANCELLED' ? 'cancelled' : 'failed';
            errorDetail = normalized.message;
            errorCode = normalized.code;
            terminal =
                finalStatus === 'cancelled'
                    ? { type: 'done', status: 'cancelled', errorCode: normalized.code }
                    : { type: 'done', status: 'failed', error: normalized.message, errorCode: normalized.code };
        }
        clearInterval(cancelPoll);
        clearTimeout(timeout);

        try {
            await this.generations.drain(generation);
        } catch (drainError) {
            if (finalStatus === 'completed') throw drainError;
        }
        const finalized = await this.generations.finalize(generation, finalStatus, errorDetail, errorCode, terminal, { blocks, llmMessages: turnMessages });

        // Fire-and-forget：蒸馏器异步提取业务口径定义，写入 conversation.semantic_state
        // 不 await 是因为蒸馏失败不应影响本次对话的响应
        if (finalized && finalStatus === 'completed') this.distiller.updateStateAsync(conversationId, userId, message);
    }

    /**
     * Agent 核心循环 (ReAct 模式):
     * 1. 推理 (Reasoning): LLM 根据提示词决定是直接输出文本，还是生成 tool_calls。
     * 2. 行动 (Acting): 解析 tool_calls 并反射执行本地工具。
     * 3. 观察 (Observation): 获取工具运行结果（tool_result），追加到上下文重新喂给 LLM。
     */
    private async runAgentLoop(
        emitter: SSEEmitter,
        messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        turnMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        blocks: SSEEvent[],
        datasourceId?: number | null,
        userId?: number,
        reasoningEnabled = false,
        signal?: AbortSignal,
        checkpoint?: () => Promise<void>,
        onFirstDelta?: () => Promise<void>,
        assertWritable?: () => Promise<void>
    ): Promise<AgentOutcome> {
        const tools = this.toolRegistry.getDefinitions();
        const orchestrator = new AgentOrchestrator();
        let lastCheckpointAt = Date.now();
        let firstDeltaRecorded = false;

        for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
            if (signal?.aborted) throw new Error('已取消');
            await assertWritable?.();
            const stream = await this.llm.streamWithTools(messages, tools, { signal, reasoningEnabled });

            let content = ''; // 累积本次迭代的文本输出
            let reasoningContent = ''; // thinking 模式下的推理链（DeepSeek / Moonshot 等）
            const toolCalls: any[] = []; // 按 index 稀疏存储，流式 delta 逐步拼接 arguments

            for await (const chunk of stream) {
                if (signal?.aborted) throw new Error('已取消');
                const delta = chunk.choices[0]?.delta as any;
                if (!delta) continue;

                if (delta.reasoning_content) {
                    reasoningContent += delta.reasoning_content;
                }

                if (delta.content) {
                    content += delta.content;
                    emitter.send({ type: 'text_chunk', content: delta.content });
                    const last = blocks[blocks.length - 1];
                    if (last?.type === 'text') last.content = String(last.content ?? '') + delta.content;
                    else blocks.push({ type: 'text', content: delta.content });
                }

                if (checkpoint && Date.now() - lastCheckpointAt >= 2_000) {
                    await checkpoint();
                    lastCheckpointAt = Date.now();
                }

                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        if (DEBUG_TOOL_CALL_DELTA) {
                            const argsLen = tc.function?.arguments?.length ?? 0;
                            this.logger.log(`[tool_call delta] idx=${tc.index} id=${tc.id ?? 'undef'} name=${tc.function?.name ?? 'undef'} args+=${argsLen}`);
                        }
                        if (!toolCalls[tc.index]) {
                            const name = tc.function?.name || '';
                            toolCalls[tc.index] = {
                                id: tc.id,
                                type: 'function',
                                function: { name, arguments: '' },
                            };

                            if (name !== 'execute_sql_query') {
                                const callLog: SSEEvent = { type: 'log', title: `[工具调用] ${name}`, content: '正在处理...' };
                                emitter.send(callLog);
                                blocks.push(callLog);
                            }
                        }
                        if (tc.function?.arguments) {
                            toolCalls[tc.index].function.arguments += tc.function.arguments;
                        }
                    }
                }

                if (!firstDeltaRecorded && (delta.content || delta.reasoning_content || delta.tool_calls?.length)) {
                    firstDeltaRecorded = true;
                    try {
                        await onFirstDelta?.();
                    } catch (error) {
                        this.logger.warn(`Failed to persist first delta metric: ${error instanceof Error ? error.message : error}`);
                    }
                }
            }

            // toolCalls 是稀疏数组（按 delta.tool_calls[].index 填入），
            // filter(Boolean) 去除 undefined 空位
            const validToolCalls = toolCalls.filter(Boolean);

            if (validToolCalls.length === 0) {
                if (content || reasoningContent) {
                    const msg: any = { role: 'assistant', content };
                    if (reasoningContent) msg.reasoning_content = reasoningContent;
                    messages.push(msg);
                    turnMessages.push(msg);
                }
                return orchestrator.complete();
            }

            const assistantMsg: any = {
                role: 'assistant',
                content,
                tool_calls: validToolCalls.map((tc) => ({ ...tc, type: 'function' })),
            };
            if (reasoningContent) assistantMsg.reasoning_content = reasoningContent;
            messages.push(assistantMsg);
            turnMessages.push(assistantMsg);

            for (const tc of validToolCalls) {
                const name = tc.function.name;
                const argsStr = tc.function.arguments;
                if (name === 'execute_sql_query') continue;

                const title = `[工具调用] ${name}`;
                const lastLog = [...blocks].reverse().find((b) => b.type === 'log' && b.title === title && String(b.content || '').startsWith('正在'));
                if (lastLog) {
                    lastLog.content = argsStr || '处理完毕';
                    emitter.send({ ...lastLog, type: 'log_update' } as any);
                }
            }

            const parsedCalls = orchestrator.parseBatch(validToolCalls, this.toolRegistry);
            // Tool calls are intentionally serialized. Their order can carry state dependencies,
            // and no current tool is declared safe for parallel execution.
            for (const { call: tc, args } of parsedCalls) {
                const name = tc.function.name;
                const tool = this.toolRegistry.get(name)!;
                orchestrator.beforeTool(name);
                await assertWritable?.();
                const result = await tool.execute(args, {
                    emitter,
                    datasourceId,
                    userId,
                    signal: signal ?? new AbortController().signal,
                    assertWritable: assertWritable ?? (async () => undefined),
                });
                orchestrator.afterTool(name, result.succeeded !== false);
                const { toolResult, blocks: resultBlocks } = result;
                const toolCallId = tc.id;
                blocks.push(...resultBlocks);
                const toolMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
                    role: 'tool',
                    tool_call_id: toolCallId!,
                    content: toolResult,
                };
                messages.push(toolMsg);
                turnMessages.push(toolMsg);
            }
        }
        return orchestrator.exhausted();
    }
}
