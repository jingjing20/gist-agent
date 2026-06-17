import { Controller, Post, Body, Res, HttpCode } from '@nestjs/common';
import { Response } from 'express';
import { ChatService } from './chat.service';
import { CurrentUser } from '../auth/user.decorator';
import type { User } from '../auth/auth.service';

@Controller('chat')
export class ChatController {
    constructor(private readonly chatService: ChatService) {}

    @Post()
    @HttpCode(200)
    async chat(
        @CurrentUser() user: User,
        @Body()
        body: { message: string; conversationId: string; datasourceId?: number },
        @Res() res: Response
    ) {
        const { message, conversationId, datasourceId } = body;

        if (!message?.trim()) {
            res.status(400).json({ error: '消息不能为空' });
            return;
        }

        if (!conversationId?.trim()) {
            res.status(400).json({ error: 'conversationId 不能为空' });
            return;
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        await this.chatService.handleChat(res, user.id, message, conversationId, datasourceId ?? null);
        res.end();
    }
}
