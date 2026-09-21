import { BusinessDefinitionRepository, DefinitionError, validateDefinition } from '@gist/database';
import type OpenAI from 'openai';
import { requireRecord, type Tool, type ToolContext } from '../chat/tools/base-tool';

/** Deliberately has no confirm, update or delete capability. */
export class ProposeDefinitionTool implements Tool {
    readonly name = 'propose_business_definition';
    readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
        type: 'function',
        function: {
            name: this.name,
            description: '根据用户本轮明确的业务语义提出长期定义候选。不会自动确认；成功任务后用户须在业务定义页面查看并点击保存。不得将查询结果或模型推断保存为定义。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    content: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            type: { type: 'string', enum: ['metric', 'term', 'relationship'] },
                            name: { type: 'string' },
                            description: { type: 'string' },
                            aliases: { type: 'array', items: { type: 'string' } },
                            relatedFields: { type: 'array', items: { type: 'string', description: 'table.column' } },
                            metric: {
                                type: 'object',
                                properties: Object.fromEntries(
                                    ['numerator', 'denominator', 'entityGrain', 'timeWindow', 'timezone', 'unit', 'conditions'].map((k) => [k, { type: 'string' }])
                                ),
                                additionalProperties: false,
                            },
                            relationship: {
                                type: 'object',
                                properties: {
                                    leftField: { type: 'string' },
                                    rightField: { type: 'string' },
                                    cardinality: { type: 'string', enum: ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'] },
                                    explanation: { type: 'string' },
                                },
                                required: ['leftField', 'rightField', 'cardinality', 'explanation'],
                                additionalProperties: false,
                            },
                        },
                        required: ['type', 'name', 'description'],
                    },
                    definitionId: { type: 'string' },
                    expectedVersion: { type: 'integer' },
                },
                required: ['content'],
            },
        },
    };
    constructor(private readonly repository: BusinessDefinitionRepository) {}
    parseArguments(value: unknown) {
        const v = requireRecord(value);
        if (Object.keys(v).some((k) => !['content', 'definitionId', 'expectedVersion'].includes(k))) throw new Error('候选字段错误');
        validateDefinition(v.content);
        return v;
    }
    async execute(args: Record<string, unknown>, ctx: ToolContext) {
        await ctx.assertWritable();
        if (!ctx.userId || !ctx.datasourceId || !ctx.generationId || !ctx.writerToken) throw new Error('缺少候选运行上下文');
        try {
            const result = await this.repository.propose(ctx.userId, ctx.datasourceId, ctx.generationId, ctx.writerToken, {
                content: args.content,
                definitionId: args.definitionId as string | undefined,
                expectedVersion: args.expectedVersion as number | undefined,
            });
            return { succeeded: true, blocks: [], toolResult: JSON.stringify(result) };
        } catch (e) {
            if (e instanceof DefinitionError) return { succeeded: false, blocks: [], toolResult: JSON.stringify({ error: e.message, status: e.status }) };
            throw e;
        }
    }
}
