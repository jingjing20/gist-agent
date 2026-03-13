import { Injectable, ForbiddenException } from '@nestjs/common';
import { Response } from 'express';
import { SqlExecutorAgent } from './agents/sql-executor';
import { ConversationService } from '../conversation/conversation.service';
import { DataSourceService } from '../datasource/datasource.service';
import { LlmService } from '../llm/llm.service';
import { SchemaService } from '../database/schema.service';
import OpenAI from 'openai';

export interface SSEEvent {
	type: 'thinking' | 'sql' | 'sql_chunk' | 'table' | 'text' | 'text_chunk' | 'error' | 'done' | 'log' | 'chart' | 'chart_loading';
	[key: string]: unknown;
}

@Injectable()
export class ChatService {
	constructor(
		private readonly sqlExecutor: SqlExecutorAgent,
		private readonly conversationService: ConversationService,
		private readonly datasourceService: DataSourceService,
		private readonly llm: LlmService,
		private readonly schemaService: SchemaService,
	) { }

	private sendSSE(res: Response, data: SSEEvent) {
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	}

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
			await this.conversationService.updateTitle(conversationId, title);
		}

		const blocks: any[] = [];
		const today = new Date().toISOString().split('T')[0];
		const schemaPrompt = await this.schemaService.getDatabaseSchemaPrompt(datasourceId ?? null, userId);

		const systemPrompt = `你是一个高级数据分析智能体。当前日期：${today}
可用数据库表：
${schemaPrompt}

## 工作流程（严格按顺序执行，不可跳步）

1. **理解需求** — 分析用户问题，确定所需的表和字段。
2. **查询数据** — 编写 SELECT 语句，调用 execute_sql_query。
3. **可视化判断** — 必须调用 analyze_result 判断查询结果是否需要图表可视化。
4. **生成图表** — 仅当 analyze_result 中 needsChart=true 时，调用 generate_chart 提供完整数据。
5. **文字总结** — 最后用自然语言直接回答用户问题，给出清晰的分析结论。

## 规则
- 查询数据后必须先调 analyze_result，再决定是否调 generate_chart。禁止跳过 analyze_result 直接生成图表。
- 文字总结必须在所有工具调用完成后再输出，不要在工具调用过程中输出。
- generate_chart 的数据必须严格来自 execute_sql_query 的查询结果，不得编造数据。`;

		const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
			{ role: 'system', content: systemPrompt }
		];

		const history = await this.conversationService.getMessages(conversationId, userId);
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
					name: 'execute_sql_query',
					description: '执行 SELECT 语句读取数据。',
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
					name: 'analyze_result',
					description: '查询数据后必须调用此工具，判断是否需要图表可视化。必须在 execute_sql_query 之后、generate_chart 之前调用。不要在此工具中放分析结论，结论在所有工具调用完成后以文字形式输出。',
					parameters: {
						type: 'object',
						properties: {
							needsChart: {
								type: 'boolean',
								description: '数据是否适合可视化。趋势/时序/对比/排名/分布 → true；简单数值/是否判断 → false'
							},
							chartType: {
								type: 'string',
								enum: ['line', 'bar', 'pie', 'scatter'],
								description: '图表类型（needsChart=true 时必填）：line 趋势时序 / bar 对比排名 / pie 占比分布 / scatter 相关性'
							},
							chartTitle: {
								type: 'string',
								description: '图表标题（needsChart=true 时必填）'
							}
						},
						required: ['needsChart']
					}
				}
			},
			{
				type: 'function',
				function: {
					name: 'generate_chart',
					description: '仅在 analyze_result 返回 needsChart=true 后调用。提供完整的图表数据，样式由前端统一处理。',
					parameters: {
						type: 'object',
						properties: {
							chartType: {
								type: 'string',
								enum: ['line', 'bar', 'pie', 'scatter'],
								description: '图表类型，与 analyze_result 中声明的一致'
							},
							title: {
								type: 'string',
								description: '图表标题，与 analyze_result 中声明的一致'
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

						if (name === 'execute_sql_query') {
							const sqlEvent = { type: 'sql', content: args.sql };
							this.sendSSE(res, sqlEvent as SSEEvent);
							blocks.push(sqlEvent);

							try {
								const r = await this.sqlExecutor.execute(args.sql, datasourceId);

								if (r.finalSql !== args.sql) {
									const fixLogEvent = { type: 'log', title: '[防腐层自动修复]', content: `检测到语法错误已由内部子模型修复。\n修复前：${args.sql}\n\n修复后：${r.finalSql}` };
									this.sendSSE(res, fixLogEvent as SSEEvent);
									blocks.push(fixLogEvent);
								}

								const tableEvent = { type: 'table', columns: r.columns, rows: r.rows, rowCount: r.rowCount };
								this.sendSSE(res, tableEvent as SSEEvent);
								blocks.push(tableEvent);

								if (r.finalSql !== args.sql) {
									toolResult = JSON.stringify({
										SystemMessage: `注意：由于你写的原始 SQL 存在特定语法错误，已被系统防腐代理自动拦截修复！最终成功执行的 SQL 为: ${r.finalSql}。请在最终结论中以此为准。`,
										data: r.rows.slice(0, 50)
									});
								} else {
									toolResult = JSON.stringify(r.rows.slice(0, 50));
								}
							} catch (e: any) {
								toolResult = `SQL 执行出错: ${e.message}`;
							}
						} else if (name === 'analyze_result') {
							if (args.needsChart) {
								this.sendSSE(res, { type: 'chart_loading' } as SSEEvent);
								toolResult = `图表区域已就绪，请立即调用 generate_chart 提供完整数据（chartType: "${args.chartType}", title: "${args.chartTitle}"）。图表生成完成后再输出文字总结。`;
							} else {
								toolResult = '无需图表。请直接输出文字分析总结。';
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
