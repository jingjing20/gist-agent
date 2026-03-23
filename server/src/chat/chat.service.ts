import { Injectable, ForbiddenException } from '@nestjs/common';
import { Response } from 'express';
import { ConversationService } from '../conversation/conversation.service';
import { DataSourceService } from '../datasource/datasource.service';
import { LlmService } from '../llm/llm.service';
import { ToolRegistry } from './tools/tool-registry';
import { PromptBuilder } from './prompt-builder';
import { StreamEmitter } from './stream-emitter';
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
	) {}

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
		const systemPrompt = await this.promptBuilder.buildSystemPrompt(datasourceId ?? null, userId);
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
							const title = `[工具调用] ${name}`;
							const callLog: SSEEvent = { type: 'log', title, content: '正在生成调用参数...' };
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

				const title = `[工具调用] ${name}`;
				emitter.send({ type: 'log_update', title, content: argsStr } as any);
				const lastLog = [...blocks].reverse().find(b => b.type === 'log' && b.title === title && b.content === '正在生成调用参数...');
				if (lastLog) {
					lastLog.content = argsStr;
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
