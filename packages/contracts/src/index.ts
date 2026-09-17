export const GENERATION_QUEUE_NAME = 'conversation-generations';

/**
 * Agent 行为相关组件的稳定版本。任何会改变模型决策或上下文语义的修改，
 * 都应提升对应版本，并随 generation 一起持久化，便于评测和线上追踪。
 */
export const AGENT_RUNTIME_VERSIONS = {
    promptPolicy: 'prompt-policy-v1',
    toolset: 'toolset-v1',
    contextPolicy: 'context-policy-v2',
    memoryPolicy: 'memory-policy-v1',
    schemaContext: 'schema-context-v1',
} as const;

export const GENERATION_ERROR_CODES = [
    'ANALYSIS_TIMEOUT',
    'CANCELLED',
    'WRITER_OWNERSHIP_LOST',
    'GENERATION_CAPACITY_UNAVAILABLE',
    'MAX_AGENT_ITERATIONS_EXCEEDED',
    'LLM_REQUEST_FAILED',
    'TOOL_EXECUTION_FAILED',
    'WORKER_LOST',
    'INTERNAL_ERROR',
] as const;

export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];

export type GenerationStatus = 'pending' | 'starting' | 'running' | 'completed' | 'failed' | 'cancel_requested' | 'cancelled';

export interface GenerationJob {
    version: 1;
    generationId: string;
}

export interface GenerationTerminalOutboxPayload {
    version: 1;
    kind: 'generation.terminal';
    generationId: string;
    userId: number;
    conversationId: string;
    messageId: string;
    event: ConversationEvent;
}

export function parseGenerationJob(value: unknown): GenerationJob {
    if (!value || typeof value !== 'object') throw new Error('INVALID_GENERATION_JOB');
    const candidate = value as Partial<GenerationJob>;
    if (candidate.version !== 1 || typeof candidate.generationId !== 'string' || !candidate.generationId) {
        throw new Error('INVALID_GENERATION_JOB');
    }
    return { version: 1, generationId: candidate.generationId };
}

export function parseGenerationTerminalOutboxPayload(value: unknown): GenerationTerminalOutboxPayload {
    if (!value || typeof value !== 'object') throw new Error('INVALID_TERMINAL_PAYLOAD');
    const candidate = value as Partial<GenerationTerminalOutboxPayload>;
    if (
        candidate.version !== 1 ||
        candidate.kind !== 'generation.terminal' ||
        typeof candidate.generationId !== 'string' ||
        typeof candidate.userId !== 'number' ||
        typeof candidate.conversationId !== 'string' ||
        typeof candidate.messageId !== 'string' ||
        !candidate.event ||
        typeof candidate.event !== 'object' ||
        typeof candidate.event.type !== 'string'
    )
        throw new Error('INVALID_TERMINAL_PAYLOAD');
    return candidate as GenerationTerminalOutboxPayload;
}

export interface ConversationEvent {
    type: 'sql' | 'sql_chunk' | 'table' | 'text' | 'text_chunk' | 'reasoning_chunk' | 'thinking' | 'error' | 'done' | 'log' | 'chart' | 'chart_loading' | 'log_update';
    [key: string]: unknown;
}

export interface GenerationStreamEvent extends ConversationEvent {
    eventId: string;
    streamId: string;
    generationId: string;
    conversationId: string;
    messageId: string;
    sequence: number;
    occurredAt: string;
}

export interface ConversationEventEmitter {
    send(event: ConversationEvent): void;
}
