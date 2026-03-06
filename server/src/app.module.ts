import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { LlmModule } from './llm/llm.module';
import { ChatModule } from './chat/chat.module';
import { ConversationModule } from './conversation/conversation.module';

@Module({
	imports: [DatabaseModule, LlmModule, ChatModule, ConversationModule],
})
export class AppModule { }
