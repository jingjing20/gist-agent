import { Controller, Post, Body, Res, HttpCode } from '@nestjs/common';
import { Response } from 'express';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
	constructor(private readonly chatService: ChatService) { }

	@Post()
	@HttpCode(200)
	async chat(
		@Body() body: { message: string; conversationId: string },
		@Res() res: Response,
	) {
		const { message, conversationId } = body;

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

		await this.chatService.handleChat(res, message, conversationId);
		res.end();
	}
}
