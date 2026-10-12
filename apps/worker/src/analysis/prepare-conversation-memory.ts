import { MemoryError, MemoryRepository, MemoryReviewRequired, parseMemoryIntent } from '@gist/database';
import type { MemoryNotice } from '@gist/contracts';

export async function prepareConversationMemory(
    repository: MemoryRepository,
    input: { userId: number; datasourceId: number; generationId: string; writerToken: string; requestMessageId: string; message: string }
): Promise<MemoryNotice | null> {
    const intent = parseMemoryIntent(input.message);
    if (!intent) return null;
    const { userId, datasourceId, generationId, writerToken, requestMessageId } = input;
    if (!intent.content) return { status: 'review_required', datasourceId, message: intent.reason };
    try {
        if (intent.mode === 'save') {
            try {
                const memory = await repository.rememberFromConversation(userId, datasourceId, requestMessageId, intent.content);
                return {
                    status: memory.status === 'active' ? 'saved' : 'not_saved',
                    datasourceId,
                    memory,
                    message: memory.status === 'active' ? '记忆已保存。分析失败或取消不会撤销保存；可在记忆页编辑或删除。' : '这条消息对应的记忆已删除，本次未重新保存。',
                };
            } catch (error) {
                if (!(error instanceof MemoryReviewRequired)) throw error;
                intent.reason = error.message;
            }
        }
        await repository.propose(userId, datasourceId, generationId, writerToken, { content: intent.content });
        return { status: 'pending', datasourceId, message: `${intent.reason}尚未保存；本轮成功结束后可编辑候选并确认。` };
    } catch (error) {
        if (!(error instanceof MemoryError)) throw error;
        return { status: 'not_saved', datasourceId, message: `记忆未保存：${error.message}` };
    }
}
