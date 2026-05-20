import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { ConversationService } from '../conversation/conversation.service';
import { DataSourceService } from '../datasource/datasource.service';
import { LlmService } from '../llm/llm.service';
import { ToolRegistry } from './tools/tool-registry';
import { PromptBuilder } from './prompt-builder';
import { StreamEmitter } from './stream-emitter';
import { SemanticDistillerService } from './agents/semantic-distiller.service';
import type { SSEEvent } from './tools/base-tool';
import type OpenAI from 'openai';

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
		private readonly datasourceService: DataSourceService,
		private readonly llm: LlmService,
		private readonly toolRegistry: ToolRegistry,
		private readonly promptBuilder: PromptBuilder,
		private readonly distiller: SemanticDistillerService,
	) { }

	/**
	 * 处理单次对话请求：权限校验 -> 消息入库 -> 启动 Agent 循环 -> 触发异步记忆提取。
	 */
	async handleChat(
		res: Response,
		userId: number,
		message: string,
		conversationId: string,
		datasourceId?: number | null,
	): Promise<void> {
		const conv = await this.conversationService.findOne(conversationId, userId);
		if (!conv) throw new ForbiddenException('对话不存在或无权访问');

		if (datasourceId && !(await this.datasourceService.canAccess(datasourceId, userId))) {
			throw new ForbiddenException('无权访问所选数据源');
		}

		await this.conversationService.addMessage(conversationId, 'user', message, []);

		if (conv.title === '新对话') {
			const title = message.slice(0, 30) + (message.length > 30 ? '...' : '');
			await this.conversationService.updateTitle(conversationId, title, datasourceId ?? null);
		}

		const emitter = new StreamEmitter(res);
		const systemPrompt = await this.promptBuilder.buildSystemPrompt(datasourceId ?? null, userId, conversationId);
		const messages = await this.promptBuilder.buildMessages(conversationId, userId, systemPrompt);

		const blocks: SSEEvent[] = [];
		const turnMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

		// Promise.race 实现全局超时：Agent Loop 和定时器竞争，
		// 任何一方先完成即决定结果。这比在循环内部检查时间更可靠，
		// 因为单次 LLM 调用本身就可能耗时很长
		try {
			await Promise.race([
				this.runAgentLoop(emitter, messages, turnMessages, blocks, datasourceId, userId),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('分析超时，请尝试简化问题后重试')), CHAT_TIMEOUT_MS),
				),
			]);
			emitter.done();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			this.logger.error(
				`handleChat failed conversationId=${conversationId} userId=${userId}: ${msg}`,
				stack,
			);
			const errorEvent: SSEEvent = { type: 'error', content: msg };
			emitter.send(errorEvent);
			blocks.push(errorEvent);
		}

		// 持久化：blocks 用于前端历史回放，turnMessages 用于下次对话重建 LLM 上下文
		await this.conversationService.addMessage(conversationId, 'assistant', '', blocks, turnMessages);

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
		emitter: StreamEmitter,
		messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
		turnMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
		blocks: SSEEvent[],
		datasourceId?: number | null,
		userId?: number,
	): Promise<void> {
		const tools = this.toolRegistry.getDefinitions();

		for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
			const stream = await this.llm.client.chat.completions.create({
				model: this.llm.model,
				messages,
				tools,
				stream: true,
			});

			let content = '';           // 累积本次迭代的文本输出
			let reasoningContent = '';  // thinking 模式下的推理链（DeepSeek / Moonshot 等）
			const toolCalls: any[] = []; // 按 index 稀疏存储，流式 delta 逐步拼接 arguments

			for await (const chunk of stream) {
				const delta = chunk.choices[0]?.delta as any;
				if (!delta) continue;

				if (delta.reasoning_content) {
					reasoningContent += delta.reasoning_content;
				}

				if (delta.content) {
					content += delta.content;
					emitter.send({ type: 'text_chunk', content: delta.content });
				}

				if (delta.tool_calls) {
					for (const tc of delta.tool_calls) {
						if (DEBUG_TOOL_CALL_DELTA) {
							const argsLen = tc.function?.arguments?.length ?? 0;
							this.logger.log(
								`[tool_call delta] idx=${tc.index} id=${tc.id ?? 'undef'} name=${tc.function?.name ?? 'undef'} args+=${argsLen}`,
							);
						}
						if (!toolCalls[tc.index]) {
							const name = tc.function?.name || '';
							toolCalls[tc.index] = {
								id: tc.id,
								type: 'function',
								function: { name, arguments: '' },
							};

							const title = name === 'execute_sql_query' ? '[SQL 生成]' : `[工具调用] ${name}`;
							const content = name === 'execute_sql_query' ? '正在构思查询逻辑...' : '正在处理...';
							const callLog: SSEEvent = { type: 'log', title, content };
							emitter.send(callLog);
							blocks.push(callLog);
						}
						if (tc.function?.arguments) {
							toolCalls[tc.index].function.arguments += tc.function.arguments;
						}
					}
				}
			}

			if (content) {
				const lastBlock = blocks[blocks.length - 1];
				if (lastBlock?.type === 'text') {
					lastBlock.content = (lastBlock.content as string) + content;
				} else {
					blocks.push({ type: 'text', content });
				}
			}

			// toolCalls 是稀疏数组（按 delta.tool_calls[].index 填入），
			// filter(Boolean) 去除 undefined 空位
			const validToolCalls = toolCalls.filter(Boolean);

			if (validToolCalls.length === 0) {
				if (content) {
					const msg: any = { role: 'assistant', content };
					if (reasoningContent) msg.reasoning_content = reasoningContent;
					messages.push(msg);
					turnMessages.push(msg);
				}
				break;
			}

			const assistantMsg: any = {
				role: 'assistant',
				tool_calls: validToolCalls.map((tc) => ({ ...tc, type: 'function' })),
			};
			if (content) assistantMsg.content = content;
			if (reasoningContent) assistantMsg.reasoning_content = reasoningContent;
			messages.push(assistantMsg);
			turnMessages.push(assistantMsg);

			for (const tc of validToolCalls) {
				const name = tc.function.name;
				const argsStr = tc.function.arguments;
				let args: Record<string, unknown> = {};
				try { args = JSON.parse(argsStr); } catch { /* malformed args */ }

				const title = name === 'execute_sql_query' ? '[SQL 生成]' : `[工具调用] ${name}`;
				const lastLog = [...blocks].reverse().find(b => b.type === 'log' && b.title === title);
				if (lastLog) {
					lastLog.content = name === 'execute_sql_query' ? 'SQL 生成完毕，具体查询逻辑请查看下方SQL代码块' : (argsStr || '处理完毕');
					emitter.send({ ...lastLog, type: 'log_update' } as any);
				}

				// 如果是 SQL 查询，生成完成后立刻渲染出源码区块
				if (name === 'execute_sql_query' && args.sql) {
					const sqlBlock: SSEEvent = { type: 'sql', content: args.sql as string };
					emitter.send(sqlBlock);
					blocks.push(sqlBlock);
				}

				// 通过 ToolRegistry 按名称查找工具实例（类似策略模式），
				// 新增工具只需实现 Tool 接口并注册到 ChatModule，无需修改此循环
				const tool = this.toolRegistry.get(name);
				let toolResult: string;

				if (tool) {
					const result = await tool.execute(args, { emitter, datasourceId, userId });
					toolResult = result.toolResult;
					blocks.push(...result.blocks);
				} else {
					toolResult = `工具 ${name} 不存在`;
				}

				const toolMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
					role: 'tool',
					tool_call_id: tc.id,
					content: toolResult,
				};
				messages.push(toolMsg);
				turnMessages.push(toolMsg);
			}
		}
	}
}
