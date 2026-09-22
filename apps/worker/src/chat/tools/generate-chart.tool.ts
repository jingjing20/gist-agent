import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';
import type { ArtifactFilterV1, ArtifactSortV1, ChartFieldV1, ChartType } from '@gist/contracts';
import { ArtifactRepository } from '../artifact.repository';
import { GenerationExecutionError } from '../generation-errors';
import { requireNonEmptyString, requireRecord, type Tool, type ToolContext, type ToolExecutionResult, type SSEEvent } from './base-tool';

const CHART_TYPES = new Set<ChartType>(['line', 'bar', 'pie', 'scatter', 'radar', 'funnel']);
const FILTER_OPERATORS = new Set<ArtifactFilterV1['operator']>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']);

@Injectable()
export class GenerateChartTool implements Tool {
    readonly name = 'generate_chart';

    readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
        type: 'function',
        function: {
            name: 'generate_chart',
            description: '基于已经完成并返回的 Query Artifact 字段生成图表。只提交字段映射，不得提交或复制数值数组。',
            parameters: {
                type: 'object',
                properties: {
                    queryArtifactId: { type: 'string', description: 'execute_sql_query 返回的 queryArtifactId' },
                    chartType: { type: 'string', enum: ['line', 'bar', 'pie', 'scatter', 'radar', 'funnel'] },
                    title: { type: 'string', description: '图表标题' },
                    xField: { type: 'string', description: '标签或 X 轴字段名' },
                    yFields: {
                        type: 'array',
                        minItems: 1,
                        items: {
                            type: 'object',
                            properties: { field: { type: 'string' }, label: { type: 'string' } },
                            required: ['field', 'label'],
                        },
                    },
                    filters: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                field: { type: 'string' },
                                operator: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'] },
                                value: {},
                            },
                            required: ['field', 'operator', 'value'],
                        },
                    },
                    sort: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { field: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } },
                            required: ['field', 'direction'],
                        },
                    },
                },
                required: ['queryArtifactId', 'chartType', 'title', 'xField', 'yFields'],
            },
        },
    };

    constructor(private readonly artifacts: ArtifactRepository) {}

    parseArguments(value: unknown): Record<string, unknown> {
        const args = requireRecord(value);
        const queryArtifactId = requireNonEmptyString(args.queryArtifactId, 'queryArtifactId');
        const chartType = requireNonEmptyString(args.chartType, 'chartType') as ChartType;
        if (!CHART_TYPES.has(chartType)) throw new Error('chartType 不受支持');
        const title = requireNonEmptyString(args.title, 'title');
        const xField = requireNonEmptyString(args.xField, 'xField');
        if (!Array.isArray(args.yFields) || args.yFields.length === 0) throw new Error('yFields 必须是非空数组');
        const yFields = args.yFields.map((item, index) => {
            const field = requireRecord(item);
            return {
                field: requireNonEmptyString(field.field, `yFields[${index}].field`),
                label: requireNonEmptyString(field.label, `yFields[${index}].label`),
            } satisfies ChartFieldV1;
        });
        if (['pie', 'funnel'].includes(chartType) && yFields.length !== 1) throw new Error(`${chartType} 只允许一个数值字段`);
        const filters = this.parseFilters(args.filters);
        const sort = this.parseSort(args.sort);
        return { queryArtifactId, chartType, title, xField, yFields, ...(filters ? { filters } : {}), ...(sort ? { sort } : {}) };
    }

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult> {
        await ctx.assertWritable();
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('已取消');
        if (!ctx.userId || !ctx.conversationId || !ctx.generationId) {
            throw new GenerationExecutionError('TOOL_EXECUTION_FAILED', '图表证据缺少 generation 上下文');
        }
        const queryArtifactId = args.queryArtifactId as string;
        const source = await this.artifacts.readQueryArtifact(queryArtifactId, ctx.userId, ctx.conversationId);
        await this.artifacts.assertUsableInGeneration(source.artifact, ctx.generationId);
        const columns = new Map(source.artifact.columns.map((column) => [column.name, column.type]));
        const xField = args.xField as string;
        const yFields = args.yFields as ChartFieldV1[];
        if (!columns.has(xField)) throw new GenerationExecutionError('ARTIFACT_FIELD_INVALID', `字段 ${xField} 不存在`);
        if (args.chartType === 'scatter' && columns.get(xField) !== 'number') {
            throw new GenerationExecutionError('ARTIFACT_FIELD_INVALID', `scatter 的 X 轴字段 ${xField} 必须是可安全绘图的数值字段`);
        }
        for (const item of yFields) {
            if (columns.get(item.field) !== 'number') {
                throw new GenerationExecutionError('ARTIFACT_FIELD_INVALID', `字段 ${item.field} 不是可安全绘图的数值字段`);
            }
        }
        let rows = this.applyFilters(source.rows, args.filters as ArtifactFilterV1[] | undefined, columns);
        rows = this.applySort(rows, args.sort as ArtifactSortV1[] | undefined, columns);
        const chartData = {
            chartType: args.chartType,
            title: args.title,
            xAxis: rows.map((row) => String(row[xField] ?? '')),
            series: yFields.map((field) => ({ name: field.label, data: rows.map((row) => row[field.field] as number) })),
        };
        const chartArtifact = await this.artifacts.createChartArtifact(
            {
                generationId: ctx.generationId,
                writerToken: ctx.writerToken,
                userId: ctx.userId,
                conversationId: ctx.conversationId,
                queryArtifactId,
                chartType: args.chartType as ChartType,
                title: args.title as string,
                xField,
                yFields,
                filters: args.filters as ArtifactFilterV1[] | undefined,
                sort: args.sort as ArtifactSortV1[] | undefined,
            },
            source.artifact.datasourceId
        );
        await ctx.assertWritable();
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('已取消');
        const chartEvent: SSEEvent = { type: 'chart', chartData, chartArtifactId: chartArtifact.id, queryArtifactId };
        ctx.emitter.send(chartEvent);
        return { toolResult: JSON.stringify({ chartArtifactId: chartArtifact.id, queryArtifactId, status: 'rendered' }), blocks: [chartEvent] };
    }

    private parseFilters(value: unknown): ArtifactFilterV1[] | undefined {
        if (value === undefined) return undefined;
        if (!Array.isArray(value)) throw new Error('filters 必须是数组');
        return value.map((item, index) => {
            const filter = requireRecord(item);
            const operator = requireNonEmptyString(filter.operator, `filters[${index}].operator`) as ArtifactFilterV1['operator'];
            if (!FILTER_OPERATORS.has(operator)) throw new Error(`filters[${index}].operator 不受支持`);
            return { field: requireNonEmptyString(filter.field, `filters[${index}].field`), operator, value: filter.value };
        });
    }

    private parseSort(value: unknown): ArtifactSortV1[] | undefined {
        if (value === undefined) return undefined;
        if (!Array.isArray(value)) throw new Error('sort 必须是数组');
        return value.map((item, index) => {
            const sort = requireRecord(item);
            const direction = requireNonEmptyString(sort.direction, `sort[${index}].direction`);
            if (!['asc', 'desc'].includes(direction)) throw new Error(`sort[${index}].direction 不受支持`);
            return { field: requireNonEmptyString(sort.field, `sort[${index}].field`), direction: direction as 'asc' | 'desc' };
        });
    }

    private applyFilters(rows: Array<Record<string, unknown>>, filters: ArtifactFilterV1[] | undefined, columns: Map<string, string>) {
        if (!filters?.length) return [...rows];
        for (const filter of filters) if (!columns.has(filter.field)) throw new GenerationExecutionError('ARTIFACT_FIELD_INVALID', `筛选字段 ${filter.field} 不存在`);
        return rows.filter((row) => filters.every((filter) => compare(row[filter.field], filter.operator, filter.value)));
    }

    private applySort(rows: Array<Record<string, unknown>>, sort: ArtifactSortV1[] | undefined, columns: Map<string, string>) {
        if (!sort?.length) return rows;
        for (const item of sort) if (!columns.has(item.field)) throw new GenerationExecutionError('ARTIFACT_FIELD_INVALID', `排序字段 ${item.field} 不存在`);
        return [...rows].sort((left, right) => {
            for (const item of sort) {
                const comparison = compareValues(left[item.field], right[item.field]);
                if (comparison !== 0) return item.direction === 'asc' ? comparison : -comparison;
            }
            return 0;
        });
    }
}

function compare(left: unknown, operator: ArtifactFilterV1['operator'], right: unknown): boolean {
    if (operator === 'in') return Array.isArray(right) && right.includes(left);
    const comparison = compareValues(left, right);
    if (operator === 'eq') return comparison === 0;
    if (operator === 'neq') return comparison !== 0;
    if (operator === 'gt') return comparison > 0;
    if (operator === 'gte') return comparison >= 0;
    if (operator === 'lt') return comparison < 0;
    return comparison <= 0;
}

function compareValues(left: unknown, right: unknown): number {
    if (left === right) return 0;
    if (left == null) return -1;
    if (right == null) return 1;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
}
