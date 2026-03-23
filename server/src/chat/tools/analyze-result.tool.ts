import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';
import type { Tool, ToolContext, ToolExecutionResult } from './base-tool';

@Injectable()
export class AnalyzeResultTool implements Tool {
	readonly name = 'analyze_result';

	readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
		type: 'function',
		function: {
			name: 'analyze_result',
			description: '查询数据后必须调用此工具，判断是否需要图表可视化。必须在 execute_sql_query 之后、generate_chart 之前调用。不要在此工具中放分析结论，结论在所有工具调用完成后以文字形式输出。',
			parameters: {
				type: 'object',
				properties: {
					needsChart: {
						type: 'boolean',
						description: '数据是否适合可视化。趋势/时序/对比/排名/分布 -> true；简单数值/是否判断 -> false',
					},
					chartType: {
						type: 'string',
						enum: ['line', 'bar', 'pie', 'scatter'],
						description: '图表类型（needsChart=true 时必填）：line 趋势时序 / bar 对比排名 / pie 占比分布 / scatter 相关性',
					},
					chartTitle: {
						type: 'string',
						description: '图表标题（needsChart=true 时必填）',
					},
				},
				required: ['needsChart'],
			},
		},
	};

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult> {
		if (args.needsChart) {
			return {
				toolResult: `图表区域已就绪，请立即调用 generate_chart 提供完整数据（chartType: "${args.chartType}", title: "${args.chartTitle}"）。图表生成完成后再输出文字总结。`,
				blocks: [],
			};
		}
		return {
			toolResult: '无需图表。请直接输出文字分析总结。',
			blocks: [],
		};
	}
}
