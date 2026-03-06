import { Injectable } from '@nestjs/common';
import { Response } from 'express';
import { SqlExecutorAgent } from './agents/sql-executor';
import { ConversationService } from '../conversation/conversation.service';
import { LlmService } from '../llm/llm.service';
import { SchemaService } from '../database/schema.service';
import OpenAI from 'openai';

export interface SSEEvent {
	type: 'thinking' | 'sql' | 'sql_chunk' | 'table' | 'text' | 'text_chunk' | 'error' | 'done' | 'need_auth';
	[key: string]: unknown;
}

@Injectable()
export class ChatService {
	constructor(
		private readonly sqlExecutor: SqlExecutorAgent,
		private readonly conversationService: ConversationService,
		private readonly llm: LlmService,
		private readonly schemaService: SchemaService,
	) { }

	private sendSSE(res: Response, data: SSEEvent) {
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	}

	async handleChat(
		res: Response,
		message: string,
		conversationId: string,
	): Promise<void> {
		await this.conversationService.addMessage(conversationId, 'user', message, []);

		const conv = await this.conversationService.findOne(conversationId);
		if (conv && conv.title === '新对话') {
			const title = message.slice(0, 30) + (message.length > 30 ? '...' : '');
			await this.conversationService.updateTitle(conversationId, title);
		}

		const blocks: any[] = [];
		const today = new Date().toISOString().split('T')[0];
		const schemaPrompt = await this.schemaService.getDatabaseSchemaPrompt();

		// Mocked table permissions
		const allowedTables = ['platform_info', 'daily_active_stats'];

		const systemPrompt = `你是一个高级的数据分析智能体。当前日期：${today}
你有以下可用的数据库表：
${schemaPrompt}

你可以通过调用工具来完成用户的数据分析请求。
请严格遵守以下执行步骤：
1. 思考你需要用到哪些表。不要直接写 SQL。
2. 调用 check_table_permission 检查所需表的访问权限。
3. 如果被拒绝权限，必须立即调用 request_table_permissions 终止分析并向用户申请权限，不要进行多余的解释。
4. 如果有权限，编写并调用 execute_sql_query 获取数据。
5. 获取到数据后，直接用自然语言回答并总结分析结论，无需复述工具的调用过程。
6. 如果数据适合可视化展示（趋势、对比、分布、排名等），请调用 generate_chart 生成图表。你只需决定图表类型和传入数据，样式由前端处理。`;

		const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
			{ role: 'system', content: systemPrompt }
		];

		const history = await this.conversationService.getMessages(conversationId);
		for (const msg of history) {
			if (msg.role === 'user') {
				messages.push({ role: 'user', content: msg.content });
			} else if (msg.role === 'assistant') {
				let text = msg.content || '';
				if (!text && Array.isArray(msg.blocks)) {
					const textBlocks = msg.blocks.filter((b: any) => b.type === 'text');
					text = textBlocks.map((b: any) => b.content).join('\n');
				}
				if (text) {
					messages.push({ role: 'assistant', content: text });
				}
			}
		}

		const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
			{
				type: 'function',
				function: {
					name: 'check_table_permission',
					description: '检查是否拥有所需表的数据访问权限。在执行任何查询之前这是必须的步骤。',
					parameters: {
						type: 'object',
						properties: {
							tables: {
								type: 'array',
								items: { type: 'string' },
								description: '需要访问的数据库表名（如 user_behavior_log）'
							}
						},
						required: ['tables']
					}
				}
			},
			{
				type: 'function',
				function: {
					name: 'request_table_permissions',
					description: '如果在 check 环节发现某个表暂无权限，请调用此工具向用户端发起权限申请，并在当前回复中停止工作流。',
					parameters: {
						type: 'object',
						properties: {
							tables: { type: 'array', items: { type: 'string' } },
							reason: { type: 'string', description: '为完成你的任务，为什么需要用到这些表的权限' }
						},
						required: ['tables', 'reason']
					}
				}
			},
			{
				type: 'function',
				function: {
					name: 'execute_sql_query',
					description: '执行 SELECT 语句读取数据，必须确保其中涉及的所有表都已通过权限检查。',
					parameters: {
						type: 'object',
						properties: {
							sql: { type: 'string', description: '安全的只读 MySQL 查询语句' }
						},
						required: ['sql']
					}
				}
			},
			{
				type: 'function',
				function: {
					name: 'generate_chart',
					description: '当查询结果适合可视化时，调用此工具生成图表。你只需提供图表类型、标题和数据，样式由前端统一处理。',
					parameters: {
						type: 'object',
						properties: {
							chartType: {
								type: 'string',
								enum: ['line', 'bar', 'pie', 'scatter'],
								description: '图表类型：line 折线图 / bar 柱状图 / pie 饼图 / scatter 散点图'
							},
							title: {
								type: 'string',
								description: '图表标题'
							},
							xAxis: {
								type: 'array',
								items: { type: 'string' },
								description: 'X 轴分类标签（饼图不需要）'
							},
							series: {
								type: 'array',
								description: '数据系列',
								items: {
									type: 'object',
									properties: {
										name: { type: 'string', description: '系列名称' },
										data: {
											type: 'array',
											items: { type: 'number' },
											description: '数值数组，与 xAxis 一一对应；饼图时每项对应一个扇区的值'
										}
									},
									required: ['name', 'data']
								}
							}
						},
						required: ['chartType', 'title', 'series']
					}
				}
			}
		];

		try {
			let isDone = false;
			this.sendSSE(res, { type: 'thinking', content: '正在分析需求并规划可用工具...' });

			while (!isDone) {
				const stream = await this.llm.client.chat.completions.create({
					model: this.llm.model,
					messages,
					tools,
					stream: true
				});

				let content = '';
				const toolCalls: any[] = [];

				for await (const chunk of stream) {
					const delta = chunk.choices[0]?.delta;
					if (!delta) continue;

					if (delta.content) {
						content += delta.content;
						this.sendSSE(res, { type: 'text_chunk', content: delta.content });
					}

					if (delta.tool_calls) {
						for (const toolCall of delta.tool_calls) {
							if (!toolCalls[toolCall.index]) {
								toolCalls[toolCall.index] = {
									id: toolCall.id,
									type: 'function',
									function: { name: toolCall.function?.name || '', arguments: '' }
								};
							}
							if (toolCall.function?.arguments) {
								toolCalls[toolCall.index].function.arguments += toolCall.function.arguments;
							}
						}
					}
				}

				if (content) {
					const lastBlock = blocks[blocks.length - 1];
					if (lastBlock?.type === 'text') {
						lastBlock.content += content;
					} else {
						blocks.push({ type: 'text', content });
					}
				}

				if (toolCalls.length > 0) {
					// 过滤掉未初始化的空槽
					const validToolCalls = toolCalls.filter(Boolean);
					const assistantMsg: any = {
						role: 'assistant',
						tool_calls: validToolCalls.map(tc => ({ ...tc, type: 'function' }))
					};
					if (content) assistantMsg.content = content;
					messages.push(assistantMsg);

					for (const tc of validToolCalls) {
						const name = tc.function.name;
						const argsStr = tc.function.arguments;
						let args: any = {};
						try { args = JSON.parse(argsStr); } catch { }
						let toolResult = '';

						const callLogEvent = { type: 'log', title: `[工具调用] ${name}`, content: argsStr };
						this.sendSSE(res, callLogEvent as SSEEvent);
						blocks.push(callLogEvent);

						if (name === 'check_table_permission') {
							const result: Record<string, boolean> = {};
							for (const table of args.tables || []) {
								result[table] = allowedTables.includes(table.toLowerCase());
							}
							toolResult = JSON.stringify(result);
						} else if (name === 'request_table_permissions') {
							const needAuthEvent = { type: 'need_auth', tables: args.tables, reason: args.reason };
							this.sendSSE(res, needAuthEvent as SSEEvent);
							blocks.push(needAuthEvent);
							toolResult = "系统提示：权限申请页面已弹出。请你此时结束回复，不要再继续执行任何操作。";
							isDone = true;
						} else if (name === 'execute_sql_query') {
							const sqlEvent = { type: 'sql', content: args.sql };
							this.sendSSE(res, sqlEvent as SSEEvent);
							blocks.push(sqlEvent);

							try {
								const r = await this.sqlExecutor.execute(args.sql);
								const tableEvent = { type: 'table', columns: r.columns, rows: r.rows, rowCount: r.rowCount };
								this.sendSSE(res, tableEvent as SSEEvent);
								blocks.push(tableEvent);
								toolResult = JSON.stringify(r.rows.slice(0, 50));
							} catch (e: any) {
								toolResult = `SQL 执行出错: ${e.message}`;
							}
						} else if (name === 'generate_chart') {
							const chartData = {
								chartType: args.chartType,
								title: args.title,
								xAxis: args.xAxis,
								series: args.series,
							};
							const chartEvent = { type: 'chart', chartData };
							this.sendSSE(res, chartEvent as SSEEvent);
							blocks.push(chartEvent);
							toolResult = '图表已成功渲染到用户界面。';
						} else {
							toolResult = `工具 ${name} 不存在`;
						}

						const resultLogEvent = { type: 'log', title: `[工具返回] ${name}`, content: toolResult };
						this.sendSSE(res, resultLogEvent as SSEEvent);
						blocks.push(resultLogEvent);

						messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
					}
				} else {
					if (content) {
						messages.push({ role: 'assistant', content });
					}
					isDone = true;
				}
			}

			this.sendSSE(res, { type: 'done' });
		} catch (err: any) {
			const errorEvent: SSEEvent = { type: 'error', content: err.message };
			this.sendSSE(res, errorEvent);
			blocks.push(errorEvent);
		}

		await this.conversationService.addMessage(conversationId, 'assistant', '', blocks);
	}
}
