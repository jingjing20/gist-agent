import { Module } from '@nestjs/common';
import { ConversationModule } from '../conversation/conversation.module';
import { ChatService } from './chat.service';
import { GenerationService } from './generation.service';
import { GenerationWorkerService } from './generation-worker.service';
import { GenerationReliabilityService } from './generation-reliability.service';
import { ZombieGenerationMonitorService } from './zombie-generation-monitor.service';
import { SqlExecutorAgent } from './agents/sql-executor';
import { SemanticDistillerService } from './agents/semantic-distiller.service';
import { PromptBuilder } from './prompt-builder';
import { GenerateChartTool } from './tools/generate-chart.tool';
import { SqlQueryTool } from './tools/sql-query.tool';
import { TOOL_INSTANCES, type Tool } from './tools/base-tool';
import { ToolRegistry } from './tools/tool-registry';
import { ArtifactRepository } from './artifact.repository';
import { ReadQueryArtifactTool } from './tools/read-query-artifact.tool';
import { MemoryModule } from '../memory/memory.module';

@Module({
    imports: [ConversationModule, MemoryModule],
    providers: [
        ChatService,
        GenerationService,
        GenerationWorkerService,
        GenerationReliabilityService,
        ZombieGenerationMonitorService,
        SqlExecutorAgent,
        SemanticDistillerService,
        PromptBuilder,
        ArtifactRepository,
        SqlQueryTool,
        GenerateChartTool,
        ReadQueryArtifactTool,
        { provide: TOOL_INSTANCES, useFactory: (...tools: Tool[]) => tools, inject: [SqlQueryTool, GenerateChartTool, ReadQueryArtifactTool] },
        ToolRegistry,
    ],
})
export class ChatModule {}
