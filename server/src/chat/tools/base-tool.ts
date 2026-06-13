import type OpenAI from "openai";

export const TOOL_INSTANCES = "TOOL_INSTANCES";

export interface SSEEvent {
  type:
    | "sql"
    | "sql_chunk"
    | "table"
    | "text"
    | "text_chunk"
    | "error"
    | "done"
    | "log"
    | "chart"
    | "chart_loading"
    | "log_update";
  [key: string]: unknown;
}

export interface SSEEmitter {
  send(event: SSEEvent): void;
}

export interface ToolContext {
  emitter: SSEEmitter;
  datasourceId?: number | null;
  userId?: number;
}

export interface ToolExecutionResult {
  toolResult: string;
  blocks: SSEEvent[];
}

export interface Tool {
  readonly name: string;
  readonly definition: OpenAI.Chat.Completions.ChatCompletionTool;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult>;
}
