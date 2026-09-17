import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';
import { requireNonEmptyString, requireRecord, type Tool, type ToolContext, type ToolExecutionResult, type SSEEvent } from './base-tool';

const CHART_TYPES = new Set(['line', 'bar', 'pie', 'scatter', 'radar', 'funnel']);

@Injectable()
export class GenerateChartTool implements Tool {
    readonly name = 'generate_chart';

    readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
        type: 'function',
        function: {
            name: 'generate_chart',
            description: '仅在已完成数据查询后调用。图表数据必须严格来自已返回的查询结果，样式由前端统一处理。',
            parameters: {
                type: 'object',
                properties: {
                    chartType: {
                        type: 'string',
                        enum: ['line', 'bar', 'pie', 'scatter', 'radar', 'funnel'],
                        description: '图表类型',
                    },
                    title: {
                        type: 'string',
                        description: '图表标题',
                    },
                    xAxis: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '各数据点的标签；bar/line/scatter 为 X 轴分类，pie/funnel 为各扇区名称，radar 为多维指标名称（必填，长度需对应数据）',
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
                required: ['chartType', 'title', 'xAxis', 'series'],
            },
        },
    };

    parseArguments(value: unknown): Record<string, unknown> {
        const args = requireRecord(value);
        const chartType = requireNonEmptyString(args.chartType, 'chartType');
        if (!CHART_TYPES.has(chartType)) throw new Error('chartType 不受支持');
        const title = requireNonEmptyString(args.title, 'title');
        if (!Array.isArray(args.xAxis) || args.xAxis.length === 0 || args.xAxis.some((item) => typeof item !== 'string')) {
            throw new Error('xAxis 必须是非空字符串数组');
        }
        const xAxis = args.xAxis as string[];
        if (!Array.isArray(args.series) || args.series.length === 0) throw new Error('series 必须是非空数组');
        const series = args.series.map((item, index) => {
            const candidate = requireRecord(item);
            const name = requireNonEmptyString(candidate.name, `series[${index}].name`);
            if (!Array.isArray(candidate.data) || candidate.data.some((point) => typeof point !== 'number' || !Number.isFinite(point))) {
                throw new Error(`series[${index}].data 必须是有限数值数组`);
            }
            if (candidate.data.length !== xAxis.length) throw new Error(`series[${index}].data 与 xAxis 长度不一致`);
            return { name, data: candidate.data };
        });
        return { chartType, title, xAxis, series };
    }

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult> {
        await ctx.assertWritable();
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('已取消');
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
