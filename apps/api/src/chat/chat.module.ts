import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ConversationModule } from '../conversation/conversation.module';
import { DataSourceModule } from '../datasource/datasource.module';
import { GenerationService } from './generation.service';
import { OutboxRelayService } from './outbox-relay.service';

@Module({
    imports: [ConversationModule, DataSourceModule],
    controllers: [ChatController],
    providers: [
        ChatService,
        GenerationService,
        OutboxRelayService,
    ],
})
export class ChatModule {}
