import { Injectable, ForbiddenException } from '@nestjs/common';
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

@Injectable()
export class ChatService {
	constructor(
		private readonly conversationService: ConversationService,
		private readonly datasourceService: DataSourceService,
		private readonly llm: LlmService,
		private readonly toolRegistry: ToolRegistry,
		private readonly promptBuilder: PromptBuilder,
		private readonly distiller: SemanticDistillerService,
	) { }

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

		try {
			await this.runAgentLoop(emitter, messages, turnMessages, blocks, datasourceId, userId);
			emitter.done();
		} catch (err: any) {
			const errorEvent: SSEEvent = { type: 'error', content: err.message };
			emitter.send(errorEvent);
			blocks.push(errorEvent);
		}

		await this.conversationService.addMessage(conversationId, 'assistant', '', blocks, turnMessages);

		// 异步触发语义摘要蒸馏，完成“中期记忆”提取
		this.distiller.updateStateAsync(conversationId, userId, message, blocks);
	}

	private async runAgentLoop(
		emitter: StreamEmitter,
		messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
		turnMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
		blocks: SSEEvent[],
		datasourceId?: number | null,
		userId?: number,
	): Promise<void> {
		const tools = this.toolRegistry.getDefinitions();

		while (true) {
			const stream = await this.llm.client.chat.completions.create({
				model: this.llm.model,
				messages,
				tools,
				stream: true,
			});

			let content = '';
			const toolCalls: any[] = [];

			for await (const chunk of stream) {
				const delta = chunk.choices[0]?.delta;
				if (!delta) continue;

				if (delta.content) {
					content += delta.content;
					emitter.send({ type: 'text_chunk', content: delta.content });
				}

				if (delta.tool_calls) {
					for (const tc of delta.tool_calls) {
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

							if (name === 'generate_chart') {
								emitter.send({ type: 'chart_loading' });
							}
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

			const validToolCalls = toolCalls.filter(Boolean);

			if (validToolCalls.length === 0) {
				if (content) {
					const msg: OpenAI.Chat.Completions.ChatCompletionMessageParam = { role: 'assistant', content };
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
					lastLog.content = name === 'execute_sql_query' ? 'SQL 生成完毕' : (argsStr || '处理完毕');
					emitter.send({ ...lastLog, type: 'log_update' } as any);
				}

				// 如果是 SQL 查询，生成完成后立刻渲染出源码区块
				if (name === 'execute_sql_query' && args.sql) {
					const sqlBlock: SSEEvent = { type: 'sql', content: args.sql as string };
					emitter.send(sqlBlock);
					blocks.push(sqlBlock);
				}

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
