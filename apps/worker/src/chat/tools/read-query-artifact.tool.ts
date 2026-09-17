import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';
import { ArtifactRepository } from '../artifact.repository';
import { GenerationExecutionError } from '../generation-errors';
import { requireNonEmptyString, requireRecord, type Tool, type ToolContext, type ToolExecutionResult } from './base-tool';

@Injectable()
export class ReadQueryArtifactTool implements Tool {
    readonly name = 'read_query_artifact';
    readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
        type: 'function',
        function: {
            name: 'read_query_artifact',
            description: '读取当前对话历史中已授权的查询证据，用于后续追问或基于历史结果生成图表。默认只返回前 100 行。',
            parameters: {
                type: 'object',
                properties: { queryArtifactId: { type: 'string', description: '历史 Query Artifact ID' } },
                required: ['queryArtifactId'],
            },
        },
    };

    constructor(private readonly artifacts: ArtifactRepository) {}

    parseArguments(value: unknown): Record<string, unknown> {
        const args = requireRecord(value);
        return { queryArtifactId: requireNonEmptyString(args.queryArtifactId, 'queryArtifactId') };
    }

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult> {
        await ctx.assertWritable();
        if (process.env.ARTIFACT_CHART_READ_ENABLED === '0') {
            throw new GenerationExecutionError('TOOL_EXECUTION_FAILED', 'Artifact 读取路径已关闭');
        }
        if (!ctx.userId || !ctx.conversationId || !ctx.generationId) throw new GenerationExecutionError('TOOL_EXECUTION_FAILED', '读取查询证据缺少 generation 上下文');
        const result = await this.artifacts.readQueryArtifact(args.queryArtifactId as string, ctx.userId, ctx.conversationId, 100);
        await this.artifacts.assertUsableInGeneration(result.artifact, ctx.generationId);
        return {
            toolResult: JSON.stringify({
                queryArtifactId: result.artifact.id,
                title: result.artifact.title,
                plan: result.artifact.plan,
                columns: result.artifact.columns,
                returnedRowCount: result.artifact.returnedRowCount,
                totalRowCount: result.artifact.totalRowCount,
                isLimited: result.artifact.isLimited,
                rows: result.rows,
            }),
            blocks: [],
            succeeded: true,
        };
    }
}
