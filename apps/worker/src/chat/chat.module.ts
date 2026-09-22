import { AnalysisRuntimeAdapter } from '../analysis/analysis-runtime-adapter';
import { Module } from '@nestjs/common';
import { ConversationModule } from '../conversation/conversation.module';
import { ChatService } from './chat.service';
import { GenerationService } from './generation.service';
import { GenerationWorkerService } from './generation-worker.service';
import { GenerationReliabilityService } from './generation-reliability.service';
import { ZombieGenerationMonitorService } from './zombie-generation-monitor.service';
import { SqlExecutorAgent } from './agents/sql-executor';
import { GenerateChartTool } from './tools/generate-chart.tool';
import { SqlQueryTool } from './tools/sql-query.tool';
import { ArtifactRepository } from './artifact.repository';

@Module({
    imports: [ConversationModule],
    providers: [
        ChatService,
        AnalysisRuntimeAdapter,
        GenerationService,
        GenerationWorkerService,
        GenerationReliabilityService,
        ZombieGenerationMonitorService,
        SqlExecutorAgent,
        ArtifactRepository,
        SqlQueryTool,
        GenerateChartTool,
    ],
})
export class ChatModule {}
