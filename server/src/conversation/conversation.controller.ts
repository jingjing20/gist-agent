import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { ConversationService } from './conversation.service';

@Controller('conversations')
export class ConversationController {
	constructor(private readonly service: ConversationService) { }

	@Get()
	findAll() {
		return this.service.findAll();
	}

	@Post()
	create(@Body() body: { title?: string }) {
		return this.service.create(body.title);
	}

	@Delete(':id')
	remove(@Param('id') id: string) {
		return this.service.remove(id);
	}

	@Get(':id/messages')
	getMessages(@Param('id') id: string) {
		return this.service.getMessages(id);
	}
}
