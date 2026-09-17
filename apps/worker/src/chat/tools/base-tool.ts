import type OpenAI from 'openai';

export const TOOL_INSTANCES = 'TOOL_INSTANCES';

export interface SSEEvent {
    type:
        | 'sql'
        | 'sql_chunk'
        | 'table'
        | 'text'
        | 'text_chunk'
        | 'reasoning_chunk'
        | 'thinking'
        | 'error'
        | 'done'
        | 'log'
        | 'chart'
        | 'chart_loading'
        | 'log_update'
        | 'log_remove';
    [key: string]: unknown;
}

export interface SSEEmitter {
    send(event: SSEEvent): void;
}

export interface ToolContext {
    emitter: SSEEmitter;
    datasourceId?: number | null;
    userId?: number;
    signal: AbortSignal;
    assertWritable(): Promise<void>;
}

export interface ToolExecutionResult {
    toolResult: string;
    blocks: SSEEvent[];
    succeeded?: boolean;
}

export interface Tool {
    readonly name: string;
    readonly definition: OpenAI.Chat.Completions.ChatCompletionTool;
    parseArguments(value: unknown): Record<string, unknown>;
    execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult>;
}

export function requireRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是 JSON 对象');
    return value as Record<string, unknown>;
}

export function requireNonEmptyString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
    return value.trim();
}
