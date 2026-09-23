import { MemoryRepository, MemoryError, validateMemory } from '@gist/database';
import type OpenAI from 'openai';
import { requireRecord, type Tool, type ToolContext } from '../chat/tools/base-tool';

/** Deliberately has no confirm, update or delete capability. */
export class ProposeMemoryTool implements Tool {
    readonly name = 'propose_memory';
    readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
        type: 'function',
        function: {
            name: this.name,
            description: '从用户对话中提炼可复用的长期记忆候选。此工具不会直接保存；成功任务后由用户查看完整文本并确认。不得将查询结果或未经验证的推断当作业务事实。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    content: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { name: { type: 'string' }, description: { type: 'string' } },
                        required: ['name', 'description'],
                    },
                    memoryId: { type: 'string' },
                    expectedVersion: { type: 'integer' },
                },
                required: ['content'],
            },
        },
    };
    constructor(private readonly repository: MemoryRepository) {}
    parseArguments(value: unknown) {
        const v = requireRecord(value);
        if (Object.keys(v).some((k) => !['content', 'memoryId', 'expectedVersion'].includes(k))) throw new Error('候选字段错误');
        validateMemory(v.content);
        return v;
    }
    async execute(args: Record<string, unknown>, ctx: ToolContext) {
        await ctx.assertWritable();
        if (!ctx.userId || !ctx.datasourceId || !ctx.generationId || !ctx.writerToken) throw new Error('缺少候选运行上下文');
        try {
            const result = await this.repository.propose(ctx.userId, ctx.datasourceId, ctx.generationId, ctx.writerToken, {
                content: args.content,
                memoryId: args.memoryId as string | undefined,
                expectedVersion: args.expectedVersion as number | undefined,
            });
            return { succeeded: true, blocks: [], toolResult: JSON.stringify(result) };
        } catch (e) {
            if (e instanceof MemoryError) return { succeeded: false, blocks: [], toolResult: JSON.stringify({ error: e.message, status: e.status }) };
            throw e;
        }
    }
}
