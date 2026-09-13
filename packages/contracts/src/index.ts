export const GENERATION_QUEUE_NAME = 'conversation-generations';

export type GenerationStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled';

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
    candidate.version !== 1 || candidate.kind !== 'generation.terminal' ||
    typeof candidate.generationId !== 'string' || typeof candidate.userId !== 'number' ||
    typeof candidate.conversationId !== 'string' || typeof candidate.messageId !== 'string' ||
    !candidate.event || typeof candidate.event !== 'object' || typeof candidate.event.type !== 'string'
  ) throw new Error('INVALID_TERMINAL_PAYLOAD');
  return candidate as GenerationTerminalOutboxPayload;
}

export interface ConversationEvent {
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
    | 'log_update';
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
