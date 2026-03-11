import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { SqlExecutorAgent } from './agents/sql-executor';
import { SummarizerAgent } from './agents/summarizer';
import { ConversationModule } from '../conversation/conversation.module';
import { DataSourceModule } from '../datasource/datasource.module';

@Module({
	imports: [ConversationModule, DataSourceModule],
	controllers: [ChatController],
	providers: [ChatService, SqlExecutorAgent, SummarizerAgent],
})
export class ChatModule { }
