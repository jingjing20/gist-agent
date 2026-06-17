import { Injectable, Inject } from '@nestjs/common';
import type OpenAI from 'openai';
import { type Tool, TOOL_INSTANCES } from './base-tool';

@Injectable()
export class ToolRegistry {
    private readonly tools = new Map<string, Tool>();

    constructor(@Inject(TOOL_INSTANCES) tools: Tool[]) {
        for (const tool of tools) {
            this.tools.set(tool.name, tool);
        }
    }

    get(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    getDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
        return Array.from(this.tools.values()).map((t) => t.definition);
    }
}
