import { AsyncLocalStorage } from 'node:async_hooks';
import { AgentScope, type SpanHandle, type GenerationHandle } from '@agentscope/sdk';
import { loadWorkspaceEnv } from '@gist/config';

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
            captureContent: false, // Explicit integration boundary: never collect bodies.
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
export async function traceAgent<T>(generationId: string | undefined, callback: (span?: SpanHandle) => Promise<T>): Promise<T> {
    const client = sdk();
    if (!client) return callback();
    return client.trace('gist.analysis', { attributes: generationId ? { generation_id: generationId } : {} }, (span) => context.run(span, () => callback(span)));
}
export async function traceTool<T extends { succeeded?: boolean }>(name: string, callback: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const root = context.getStore();
    if (!root) return callback();
    return root.span(`tool.${name}`, { kind: 'tool' }, async (span) => {
        try {
            const result = await callback();
            if (result.succeeded === false) span.end({ status: 'error' });
            return result;
        } catch (error) {
            if (signal?.aborted) span.end({ status: 'canceled' });
            throw error;
        }
    });
}
export async function traceModel<T>(model: string, callback: (span?: GenerationHandle) => Promise<T>): Promise<T> {
    const run = (root: SpanHandle) => root.generation('llm.chat', { model: { provider: 'openai-compatible', model } }, callback);
    const root = context.getStore();
    if (root) return run(root);
    const client = sdk();
    if (!client) return callback();
    return client.trace('gist.llm.request', run);
}
// Structural types avoid coupling telemetry to a particular OpenAI SDK version.
interface Chunk {
    choices: { delta: { content?: string | null }; finish_reason?: string | null }[];
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
export async function traceModelStream<T extends Chunk>(model: string, create: () => Promise<AsyncIterable<T>>, signal?: AbortSignal): Promise<AsyncIterable<T>> {
    const root = context.getStore();
    const client = sdk();
    if (!root || !client) return create();
    const span = root.startSpan('llm.stream', { kind: 'llm' });
    span.setModel({ provider: 'openai-compatible', model });
    try {
        const stream = await create();
        return client.observeStream(span, stream, {
            signal,
            text: (chunk) => {
                const reason = chunk.choices[0]?.finish_reason;
                if (reason) span.setModel({ finishReason: reason });
                return chunk.choices[0]?.delta.content ?? undefined;
            },
            usage: (chunk) => modelUsage(chunk.usage),
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
