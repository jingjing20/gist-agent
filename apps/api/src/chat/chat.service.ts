import { ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { ConversationService } from '../conversation/conversation.service';
import { DataSourceService } from '../datasource/datasource.service';
import { GenerationService } from './generation.service';

/** API 侧只创建消息与 generation；模型执行严格留在独立 Worker。 */
@Injectable()
export class ChatService {
    constructor(
        private readonly conversations: ConversationService,
        private readonly datasources: DataSourceService,
        private readonly generations: GenerationService
    ) {}

    async startChat(userId: number, message: string, conversationId: string, datasourceId?: number | null, idempotencyKey: string = randomUUID(), reasoningEnabled = false) {
        const conversation = await this.conversations.findOne(conversationId, userId);
        if (!conversation) throw new ForbiddenException('对话不存在或无权访问');
        if (datasourceId && !(await this.datasources.canAccess(datasourceId, userId))) throw new ForbiddenException('无权访问所选数据源');
        const requestHash = createHash('sha256')
            .update(JSON.stringify({ conversationId, message, datasourceId: datasourceId ?? null, reasoningEnabled }))
            .digest('hex');
        return this.generations.createTurn(userId, conversationId, message, datasourceId ?? null, idempotencyKey, requestHash, reasoningEnabled);
    }
}
