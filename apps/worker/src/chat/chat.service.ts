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

// Agent 循环上限：防止 LLM 陷入无限 tool_call 循环（如反复查错 SQL 又反复修）
const MAX_AGENT_ITERATIONS = 15;
// 全局超时熔断：无论 Agent 处于哪个阶段，超过此时间强制终止并返回错误
const CHAT_TIMEOUT_MS = 300_000;
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
            await this.generations.finalize(identity, 'cancelled', undefined, { type: 'done', status: 'cancelled' });
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
        if (!permit) throw new Error('GENERATION_CAPACITY_UNAVAILABLE');
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
            const rows = await this.conversationService.getMessages(generation.conversationId, generation.userId);
            const request = [...rows].reverse().find((item) => item.role === 'user');
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
        const cancelPoll = setInterval(() => {
            if (ownershipLost()) controller.abort();
            else void this.generations.isCancelRequested(generation.id).then((cancelled) => cancelled && controller.abort());
        }, 500);
        let terminal: SSEEvent = { type: 'done' };
        let finalStatus: GenerationStatus = 'completed';
        let errorDetail: string | undefined;

        // Promise.race 实现全局超时：Agent Loop 和定时器竞争，
        // 任何一方先完成即决定结果。这比在循环内部检查时间更可靠，
        // 因为单次 LLM 调用本身就可能耗时很长
        try {
            const reasoningActive = this.llm.isReasoningActive(reasoningEnabled);
            const systemPrompt = await this.promptBuilder.buildSystemPrompt(datasourceId, userId, conversationId);
            const messages = await this.promptBuilder.buildMessages(conversationId, userId, systemPrompt, {
                reasoningEnabled: reasoningActive,
                excludeMessageIds: [messageId],
            });
            await Promise.race([
                this.runAgentLoop(emitter, messages, turnMessages, blocks, datasourceId, userId, reasoningActive, signal, () =>
                    this.conversationService.updateMessage(messageId, '', blocks, turnMessages)
                ),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('分析超时，请尝试简化问题后重试')), CHAT_TIMEOUT_MS)),
            ]);
            if (signal.aborted) throw new Error('已取消');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack : undefined;
            this.logger.error(`handleChat failed conversationId=${conversationId} userId=${userId}: ${msg}`, stack);
            const errorEvent: SSEEvent = { type: 'error', content: msg };
            emitter.send(errorEvent);
            blocks.push(errorEvent);
            finalStatus = signal.aborted && !ownershipLost() ? 'cancelled' : 'failed';
            errorDetail = msg;
            terminal = finalStatus === 'cancelled' ? { type: 'done', status: 'cancelled' } : { type: 'done', status: 'failed', error: msg };
        }
        clearInterval(cancelPoll);

        // 持久化：blocks 用于前端历史回放，turnMessages 用于下次对话重建 LLM 上下文
        await this.conversationService.updateMessage(messageId, '', blocks, turnMessages);
        await this.generations.drain(generation);
        await this.generations.finalize(generation, finalStatus, errorDetail, terminal);

        // Fire-and-forget：蒸馏器异步提取业务口径定义，写入 conversation.semantic_state
        // 不 await 是因为蒸馏失败不应影响本次对话的响应
        this.distiller.updateStateAsync(conversationId, userId, message);
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
        checkpoint?: () => Promise<void>
    ): Promise<void> {
        const tools = this.toolRegistry.getDefinitions();
        let lastCheckpointAt = Date.now();

        for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
            if (signal?.aborted) throw new Error('已取消');
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
                    emitter.send({ type: 'reasoning_chunk', content: delta.reasoning_content });
                    const last = blocks[blocks.length - 1];
                    if (last?.type === 'thinking') last.content = String(last.content ?? '') + delta.reasoning_content;
                    else blocks.push({ type: 'thinking', content: delta.reasoning_content });
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
                break;
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

            // 并发执行所有 tool_calls，通过 Promise.all 减少串行等待。
            // 每个任务返回 { toolResult, blocks, toolCallId }，执行完后按原始顺序写回 messages，
            // 保证 OpenAI 要求的 tool result 与 tool_call id 的顺序对应关系。
            const toolResults = await Promise.all(
                validToolCalls.map(async (tc) => {
                    const name = tc.function.name;
                    let args: Record<string, unknown> = {};
                    try {
                        args = JSON.parse(tc.function.arguments);
                    } catch {
                        /* malformed args */
                    }

                    const tool = this.toolRegistry.get(name);
                    if (tool) {
                        const result = await tool.execute(args, {
                            emitter,
                            datasourceId,
                            userId,
                        });
                        return { toolCallId: tc.id, toolResult: result.toolResult, resultBlocks: result.blocks };
                    }
                    return { toolCallId: tc.id, toolResult: `工具 ${name} 不存在`, resultBlocks: [] as SSEEvent[] };
                })
            );

            for (const { toolCallId, toolResult, resultBlocks } of toolResults) {
                blocks.push(...resultBlocks);
                const toolMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
                    role: 'tool',
                    tool_call_id: toolCallId,
                    content: toolResult,
                };
                messages.push(toolMsg);
                turnMessages.push(toolMsg);
            }
        }
    }
}
