import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';
import { DatabaseModule } from './database/database.module';
import { LlmModule } from './llm/llm.module';
import { HealthController } from './health.controller';

@Module({ imports: [DatabaseModule, LlmModule, ChatModule], controllers: [HealthController] })
export class AppModule {}
