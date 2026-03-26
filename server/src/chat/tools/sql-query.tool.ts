import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';
import type { Tool, ToolContext, ToolExecutionResult, SSEEvent } from './base-tool';
import { SqlExecutorAgent } from '../agents/sql-executor';

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

			const toolResult = r.wasFixed
				? JSON.stringify({
					SystemMessage: `注意：由于你写的原始 SQL 存在特定语法错误，已被系统防腐代理自动拦截修复！最终成功执行的 SQL 为: ${r.finalSql}。请在最终结论中以此为准。`,
					data: r.rows.slice(0, 50),
				})
				: JSON.stringify(r.rows.slice(0, 50));

			return { toolResult, blocks };
		} catch (e: any) {
			execLog.content = `查询失败: ${e.message}`;
			ctx.emitter.send({ ...execLog, type: 'log_update' } as any);
			return { toolResult: `SQL 执行出错: ${e.message}`, blocks };
		}
	}
}
