import { AsyncLocalStorage } from 'node:async_hooks';
import { AgentScope, type SpanHandle, type GenerationHandle } from '@agentscope/sdk';
import { loadWorkspaceEnv } from '@gist/config';
import { StreamOutput } from './stream-output';
import { redactText } from './redaction';

const context = new AsyncLocalStorage<SpanHandle>();
let scope: AgentScope | undefined;
let warned = false;
function sdk(): AgentScope | undefined {
    loadWorkspaceEnv();
    if (process.env.AGENTSCOPE_ENABLED !== 'true') return undefined;
    if (scope) return scope;
    try {
        scope = new AgentScope({
            endpoint: process.env.AGENTSCOPE_ENDPOINT,
            apiKey: process.env.AGENTSCOPE_API_KEY,
            captureContent: process.env.AGENTSCOPE_CAPTURE_CONTENT === 'true',
            redactor: redactText,
            environment: process.env.AGENTSCOPE_ENVIRONMENT || 'gist-development',
        });
    } catch {
        if (!warned) {
            console.warn('AgentScope disabled: invalid telemetry configuration');
            warned = true;
        }
    }
    return scope;
}
export interface AgentContext {
    conversationId?: string;
    requestMessageId?: string;
    input?: unknown;
}
export async function traceAgent<T>(generationId: string | undefined, callback: (span?: SpanHandle) => Promise<T>, details: AgentContext = {}): Promise<T> {
    const client = sdk();
    if (!client) return callback();
    return client.trace(
        'gist.analysis',
        {
            input: details.input,
            attributes: {
                ...(generationId ? { generation_id: generationId } : {}),
                ...(details.conversationId ? { conversation_id: details.conversationId } : {}),
                ...(details.requestMessageId ? { request_message_id: details.requestMessageId } : {}),
            },
        },
        (span) => context.run(span, () => callback(span))
    );
}
export async function traceTool<T extends { succeeded?: boolean }>(name: string, callback: () => Promise<T>, signal?: AbortSignal, input?: unknown): Promise<T> {
    const root = context.getStore();
    if (!root) return callback();
    return root.span(`tool.${name}`, { kind: 'tool', input }, async (span) => {
        try {
            const result = await callback();
            span.setOutput(result);
            if (result.succeeded === false) {
                span.recordError({ type: 'ToolResultError', message: 'Tool returned succeeded=false' });
                span.end({ status: 'error' });
            }
            return result;
        } catch (error) {
            if (signal?.aborted) span.end({ status: 'canceled' });
            throw error;
        }
    });
}
export async function traceModel<T>(model: string, callback: (span?: GenerationHandle) => Promise<T>, input?: unknown, messages?: unknown): Promise<T> {
    const run = (root: SpanHandle) => root.generation('llm.chat', { input, model: { provider: 'openai-compatible', model, messages } }, callback);
    const root = context.getStore();
    if (root) return run(root);
    const client = sdk();
    if (!client) return callback();
    return client.trace('gist.llm.request', run);
}
// Structural types avoid coupling telemetry to a particular OpenAI SDK version.
interface Chunk {
    id?: string;
    choices: {
        delta: { content?: string | null; tool_calls?: { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[] };
        finish_reason?: string | null;
    }[];
    usage?: Usage | null;
}
export interface Usage {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    completion_tokens_details?: { reasoning_tokens?: number } | null;
}
export function modelUsage(usage?: Usage | null) {
    return usage
        ? {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
              cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
              reasoningOutputTokens: usage.completion_tokens_details?.reasoning_tokens,
          }
        : undefined;
}
export async function traceModelStream<T extends Chunk>(
    model: string,
    create: () => Promise<AsyncIterable<T>>,
    signal?: AbortSignal,
    input?: unknown,
    messages?: unknown
): Promise<AsyncIterable<T>> {
    const root = context.getStore();
    const client = sdk();
    if (!root || !client) return create();
    const span = root.startSpan('llm.stream', { kind: 'llm', input });
    span.setModel({ provider: 'openai-compatible', model, messages });
    const output = new StreamOutput();
    const capture = process.env.AGENTSCOPE_CAPTURE_CONTENT === 'true';
    try {
        const stream = await create();
        return client.observeStream(span, stream, {
            signal,
            text: (chunk) => {
                if (capture) output.add(chunk.choices[0]?.delta);
                if (chunk.id) span.setModel({ providerRequestId: chunk.id });
                const reason = chunk.choices[0]?.finish_reason;
                if (reason) span.setModel({ finishReason: reason });
                return chunk.choices[0]?.delta.content ?? undefined;
            },
            usage: (chunk) => modelUsage(chunk.usage),
            output: () => output.result(),
        });
    } catch (error) {
        if (signal?.aborted) span.end({ status: 'canceled' });
        else {
            span.recordError(error);
            span.end({ status: 'error' });
        }
        throw error;
    }
}
export async function flushTelemetry() {
    return scope?.flush({ timeoutMs: 5000 });
}
export async function shutdownTelemetry() {
    return scope?.shutdown({ timeoutMs: 5000 });
}
export function telemetryDiagnostics() {
    return scope?.getDiagnostics();
}

export function currentSpan(): SpanHandle | undefined {
    return context.getStore();
}

export function startTool(name: string, input?: unknown): SpanHandle | undefined {
    return context.getStore()?.startSpan(`tool.${name}`, { kind: 'tool', input });
}
