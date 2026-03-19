import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';
import type { Tool, ToolContext, ToolExecutionResult, SSEEvent } from './base-tool';

@Injectable()
export class GenerateChartTool implements Tool {
	readonly name = 'generate_chart';

	readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
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
						description: '图表类型，与 analyze_result 中声明的一致',
					},
					title: {
						type: 'string',
						description: '图表标题，与 analyze_result 中声明的一致',
					},
					xAxis: {
						type: 'array',
						items: { type: 'string' },
						description: '各数据点的标签；bar/line/scatter 为 X 轴分类，饼图为各扇区名称（必填，与 series[0].data 一一对应）',
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
									description: '数值数组，与 xAxis 一一对应',
								},
							},
							required: ['name', 'data'],
						},
					},
				},
				required: ['chartType', 'title', 'series'],
			},
		},
	};

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult> {
		const chartData = {
			chartType: args.chartType,
			title: args.title,
			xAxis: args.xAxis,
			series: args.series,
		};
		const chartEvent: SSEEvent = { type: 'chart', chartData };
		ctx.emitter.send(chartEvent);

		return {
			toolResult: '图表已成功渲染到用户界面。',
			blocks: [chartEvent],
		};
	}
}
