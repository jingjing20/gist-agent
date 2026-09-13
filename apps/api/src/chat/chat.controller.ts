import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ChatService } from './chat.service';
import { GenerationService } from './generation.service';
import { CurrentUser } from '../auth/user.decorator';
import type { User } from '../auth/auth.service';

@Controller('chat')
export class ChatController {
    constructor(
        private readonly chatService: ChatService,
        private readonly generations: GenerationService
    ) {}

    @Post()
    @HttpCode(202)
    chat(
        @CurrentUser() user: User,
        @Headers('idempotency-key') idempotencyKey: string | undefined,
        @Body() body: { message: string; conversationId: string; datasourceId?: number; reasoningEnabled?: boolean }
    ) {
        if (!body.message?.trim()) throw new Error('消息不能为空');
        if (!body.conversationId?.trim()) throw new Error('conversationId 不能为空');
        return this.chatService.startChat(user.id, body.message.trim(), body.conversationId, body.datasourceId ?? null, idempotencyKey, body.reasoningEnabled === true);
    }

    @Get('sync')
    sync(@CurrentUser() user: User, @Query('known_generation_ids') known?: string) {
        return this.generations.sync(user.id, known ? known.split(',').filter(Boolean).slice(0, 100) : []);
    }

    @Get('events')
    stream(@CurrentUser() user: User, @Query('after') after: string | undefined, @Req() req: Request, @Res() res: Response) {
        return this.generations.stream(user.id, after ?? '0-0', req, res);
    }

    @Get('generations/:id/events')
    history(@CurrentUser() user: User, @Param('id') id: string, @Query('after_sequence') after?: string) {
        return this.generations.history(user.id, id, Math.max(0, Number(after) || 0));
    }

    @Post('generations/:id/cancel')
    cancel(@CurrentUser() user: User, @Param('id') id: string) {
        return this.generations.cancel(user.id, id);
    }

    @Post('generations/:id/retry')
    async retry(@CurrentUser() user: User, @Param('id') id: string) {
        const source = await this.generations.retry(user.id, id);
        return this.chatService.startChat(user.id, source.message, source.conversationId, null, undefined, source.reasoningEnabled);
    }
}
