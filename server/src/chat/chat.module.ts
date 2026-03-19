import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { SqlExecutorAgent } from './agents/sql-executor';
import { SummarizerAgent } from './agents/summarizer';
import { ToolRegistry } from './tools/tool-registry';
import { TOOL_INSTANCES, type Tool } from './tools/base-tool';
import { SqlQueryTool } from './tools/sql-query.tool';
import { AnalyzeResultTool } from './tools/analyze-result.tool';
import { GenerateChartTool } from './tools/generate-chart.tool';
import { PromptBuilder } from './prompt-builder';
import { ConversationModule } from '../conversation/conversation.module';
import { DataSourceModule } from '../datasource/datasource.module';

@Module({
	imports: [ConversationModule, DataSourceModule],
	controllers: [ChatController],
	providers: [
		ChatService,
		SqlExecutorAgent,
		SummarizerAgent,
		PromptBuilder,
		SqlQueryTool,
		AnalyzeResultTool,
		GenerateChartTool,
		{
			provide: TOOL_INSTANCES,
			useFactory: (...tools: Tool[]) => tools,
			inject: [SqlQueryTool, AnalyzeResultTool, GenerateChartTool],
		},
		ToolRegistry,
	],
})
export class ChatModule {}
