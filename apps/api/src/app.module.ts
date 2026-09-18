import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { LlmModule } from './llm/llm.module';
import { ChatModule } from './chat/chat.module';
import { ConversationModule } from './conversation/conversation.module';
import { DataSourceModule } from './datasource/datasource.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { MemoryModule } from './memory/memory.module';

@Module({
    imports: [DatabaseModule, AuthModule, UserModule, LlmModule, ChatModule, ConversationModule, DataSourceModule, MemoryModule],
    providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
