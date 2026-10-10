import type OpenAI from 'openai';
import type { AnalysisCompletionStatus } from '@gist/contracts';
import { exactKeys, record } from './tool-arguments';
export const FINISH_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: 'function',
    function: {
        name: 'finish_analysis',
        description: '正文和展示工具完成后独立调用，记录真实完成状态。不承载正文，不重复回答；成功后本轮立即结束。非完整状态须说明原因，缺失项列入 missingItems。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                status: { type: 'string', enum: ['complete', 'partial', 'awaiting_clarification', 'unable_to_complete'] },
                reason: { type: ['string', 'null'] },
                missingItems: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } },
            },
            required: ['status', 'reason', 'missingItems'],
        },
    },
};
export function validateFinish(value: unknown): { status: AnalysisCompletionStatus; reason: string | null; missingItems: string[] } {
    const args = record(value);
    exactKeys(args, ['status', 'reason', 'missingItems']);
    if (!['complete', 'partial', 'awaiting_clarification', 'unable_to_complete'].includes(String(args.status))) throw new Error('完成状态不合法');
    if (args.reason !== null && (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 1000)) throw new Error('原因必须为 null 或 1–1000 字符');
    if (args.status !== 'complete' && !args.reason) throw new Error('非完整状态必须说明原因');
    if (!Array.isArray(args.missingItems) || args.missingItems.length > 20 || args.missingItems.some((s) => typeof s !== 'string' || !s.trim() || s.length > 500))
        throw new Error('缺失项格式错误');
    if (args.status === 'complete' && (args.reason !== null || args.missingItems.length)) throw new Error('存在未完成事项时不能标记 complete');
    return { status: args.status as AnalysisCompletionStatus, reason: args.reason as string | null, missingItems: args.missingItems as string[] };
}
