import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';
import { requireNonEmptyString, requireRecord, type Tool, type ToolContext, type ToolExecutionResult, type SSEEvent } from './base-tool';
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
                    title: {
                        type: 'string',
                        description: '本次查询的简短动作标题，使用明确的中文动宾短语（建议 6-15 个字），例如“查询所有平台类型”；不要包含“SQL”“查询结果”等后缀',
                    },
                    sql: { type: 'string', description: '安全的只读 PostgreSQL 查询语句' },
                },
                required: ['title', 'sql'],
            },
        },
    };

    constructor(private readonly sqlExecutor: SqlExecutorAgent) {}

    parseArguments(value: unknown): Record<string, unknown> {
        const args = requireRecord(value);
        return {
            title: requireNonEmptyString(args.title, 'title'),
            sql: requireNonEmptyString(args.sql, 'sql'),
        };
    }

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult> {
        await ctx.assertWritable();
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('已取消');
        const sql = args.sql as string;
        const queryTitle =
            String(args.title || '执行数据查询')
                .trim()
                .slice(0, 30) || '执行数据查询';
        const blocks: SSEEvent[] = [];

        const execLog: SSEEvent = {
            type: 'log',
            title: queryTitle,
            content: '正在从数据库读取结果...',
        };
        ctx.emitter.send(execLog);
        blocks.push(execLog);

        const sqlBlock: SSEEvent = {
            type: 'sql',
            title: `${queryTitle} · SQL 语句`,
            content: sql,
        };
        ctx.emitter.send(sqlBlock);
        blocks.push(sqlBlock);

        try {
            const r = await this.sqlExecutor.execute(sql, ctx.datasourceId, ctx.userId, ctx.signal);
            await ctx.assertWritable();

            if (r.wasFixed) {
                const fixLog: SSEEvent = {
                    type: 'log',
                    title: `${queryTitle} · SQL 自动修复`,
                    content: `检测到语法错误已由内部子模型修复。\n修复前：${sql}\n\n修复后：${r.finalSql}`,
                };
                ctx.emitter.send(fixLog);
                blocks.push(fixLog);
            }

            ctx.emitter.send({ type: 'log_remove', title: queryTitle });
            const execLogIndex = blocks.indexOf(execLog);
            if (execLogIndex >= 0) blocks.splice(execLogIndex, 1);

            const tableEvent: SSEEvent = {
                type: 'table',
                title: `${queryTitle} · 查询结果`,
                columns: r.columns,
                rows: r.rows,
                rowCount: r.rowCount,
            };
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
                  ? JSON.stringify({
                        systemMessage: truncationNote.trim(),
                        data: resultRows,
                    })
                  : JSON.stringify(resultRows);

            return { toolResult, blocks, succeeded: true };
        } catch (e: any) {
            if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
            execLog.content = `查询失败: ${e.message}`;
            ctx.emitter.send({ ...execLog, type: 'log_update' } as any);
            return { toolResult: `SQL 执行出错: ${e.message}`, blocks, succeeded: false };
        }
    }
}
