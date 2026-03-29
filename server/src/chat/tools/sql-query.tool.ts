import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';
import type { Tool, ToolContext, ToolExecutionResult, SSEEvent } from './base-tool';
import { SqlExecutorAgent } from '../agents/sql-executor';

const MAX_TOOL_RESULT_CHARS = 60000;

@Injectable()
export class SqlQueryTool implements Tool {
	readonly name = 'execute_sql_query';

	readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
		type: 'function',
		function: {
			name: 'execute_sql_query',
			description: '执行 SELECT 语句读取数据。',
			parameters: {
				type: 'object',
				properties: {
					sql: { type: 'string', description: '安全的只读 MySQL 查询语句' },
				},
				required: ['sql'],
			},
		},
	};

	constructor(private readonly sqlExecutor: SqlExecutorAgent) { }

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult> {
		const sql = args.sql as string;
		const blocks: SSEEvent[] = [];

		const execLog: SSEEvent = { type: 'log', title: '[数据查询]', content: '正在从数据库提取并处理结果...' };
		ctx.emitter.send(execLog);
		blocks.push(execLog);

		// Add a slight delay to enhance the perception of "thinking/processing"
		await new Promise(resolve => setTimeout(resolve, 600));

		try {
			const r = await this.sqlExecutor.execute(sql, ctx.datasourceId, ctx.userId);

			if (r.wasFixed) {
				const fixLog: SSEEvent = {
					type: 'log',
					title: '[防腐层自动修复]',
					content: `检测到语法错误已由内部子模型修复。\n修复前：${sql}\n\n修复后：${r.finalSql}`,
				};
				ctx.emitter.send(fixLog);
				blocks.push(fixLog);
			}

			execLog.content = `查询成功，共读取 ${r.rowCount} 条数据`;
			ctx.emitter.send({ ...execLog, type: 'log_update' } as any);

			const tableEvent: SSEEvent = { type: 'table', columns: r.columns, rows: r.rows, rowCount: r.rowCount };
			ctx.emitter.send(tableEvent);
			blocks.push(tableEvent);

			let resultRows = r.rows;
			let truncationNote = '';

			const serialized = JSON.stringify(resultRows);
			if (serialized.length > MAX_TOOL_RESULT_CHARS && resultRows.length > 1) {
				const avgSize = serialized.length / resultRows.length;
				const fitCount = Math.max(1, Math.floor(MAX_TOOL_RESULT_CHARS / avgSize));
				resultRows = r.rows.slice(0, fitCount);
				truncationNote = `\n[注意：完整查询共 ${r.rowCount} 条，因数据体积超限仅提供前 ${fitCount} 条用于分析，请在结论中注明数据未完整展示。]`;
			}

			const toolResult = r.wasFixed
				? JSON.stringify({
					systemMessage: `注意：由于你写的原始 SQL 存在特定语法错误，已被系统防腐代理自动拦截修复！最终成功执行的 SQL 为: ${r.finalSql}。请在最终结论中以此为准。${truncationNote}`,
					data: resultRows,
				})
				: truncationNote
					? JSON.stringify({ systemMessage: truncationNote.trim(), data: resultRows })
					: JSON.stringify(resultRows);

			return { toolResult, blocks };
		} catch (e: any) {
			execLog.content = `查询失败: ${e.message}`;
			ctx.emitter.send({ ...execLog, type: 'log_update' } as any);
			return { toolResult: `SQL 执行出错: ${e.message}`, blocks };
		}
	}
}
