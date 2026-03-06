import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { SqlExecutorAgent } from './agents/sql-executor';
import { SummarizerAgent } from './agents/summarizer';
import { ConversationModule } from '../conversation/conversation.module';

@Module({
	imports: [ConversationModule],
	controllers: [ChatController],
	providers: [ChatService, SqlExecutorAgent, SummarizerAgent],
})
export class ChatModule { }
