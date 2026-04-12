import { Controller, Get, Post, Delete, Param, Body, Query, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { ConversationService } from './conversation.service';

import { CurrentUser } from '../auth/user.decorator';
import type { User } from '../auth/auth.service';

@Controller('conversations')
export class ConversationController {
	constructor(
		private readonly service: ConversationService,
	) { }

	@Get()
	findAll(@CurrentUser() user: User) {
		return this.service.findAll(user.id);
	}

	@Post()
	create(@CurrentUser() user: User, @Body() body: { title?: string }) {
		return this.service.create(user.id, body.title);
	}

	@Delete(':id')
	remove(@CurrentUser() user: User, @Param('id') id: string) {
		return this.service.remove(id, user.id);
	}

	@Get(':id/messages')
	getMessages(@CurrentUser() user: User, @Param('id') id: string) {
		return this.service.getMessages(id, user.id);
	}


}
