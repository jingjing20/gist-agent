import { traceModel, traceModelStream, modelUsage } from '@gist/telemetry';
import { loadWorkspaceEnv } from '@gist/config';
import OpenAI from 'openai';
import { wrapOpenAI } from 'langsmith/wrappers';

export class LlmClient {
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly supportsThinkingControl: boolean;

    constructor() {
        loadWorkspaceEnv();
        const baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        this.client = wrapOpenAI(
            new OpenAI({
                apiKey: process.env.OPENAI_API_KEY,
                baseURL,
            })
        );
        this.model = process.env.OPENAI_MODEL || 'gpt-4o';
        const thinkingControl = process.env.LLM_THINKING_CONTROL || 'auto';
        this.supportsThinkingControl =
            thinkingControl === 'deepseek' || (thinkingControl !== 'none' && (baseURL.includes('deepseek.com') || this.model.toLowerCase().includes('deepseek')));
    }

    async chat(systemPrompt: string, userPrompt: string, temperature = 0): Promise<string> {
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];
        return traceModel(
            this.model,
            async (span) => {
                const response = await this.client.chat.completions.create({
                    model: this.model,
                    temperature,
                    messages,
                });
                const usage = modelUsage(response.usage);
                if (usage) span?.setUsage(usage);
                if (response.choices[0]?.finish_reason) span?.setModel({ finishReason: response.choices[0].finish_reason });
                const content = response.choices[0]?.message?.content?.trim();
                if (!content) throw new Error('LLM returned empty response');
                span?.setOutput(response.choices[0]?.message);
                if (response.id) span?.setModel({ providerRequestId: response.id });
                return content;
            },
            { messages, temperature },
            messages
        );
    }

    isReasoningActive(requested: boolean): boolean {
        return requested && this.supportsThinkingControl;
    }

    streamWithTools(
        messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: OpenAI.Chat.Completions.ChatCompletionTool[],
        options: { signal?: AbortSignal; reasoningEnabled?: boolean } = {}
    ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
        const payload = createStreamRequest({
            model: this.model,
            messages,
            tools,
            reasoningEnabled: options.reasoningEnabled === true,
            supportsThinkingControl: this.supportsThinkingControl,
            reasoningEffort: process.env.LLM_REASONING_EFFORT,
        });
        return traceModelStream(
            this.model,
            () =>
                this.client.chat.completions.create(
                    payload as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
                    options.signal ? { signal: options.signal } : undefined
                ) as unknown as Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>,
            options.signal,
            { messages, tools },
            messages
        );
    }
}

export function createStreamRequest(input: {
    model: string;
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
    reasoningEnabled: boolean;
    supportsThinkingControl: boolean;
    reasoningEffort?: string;
}): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        model: input.model,
        messages: input.messages,
        tools: input.tools,
        stream: true,
    };
    if (input.supportsThinkingControl) {
        payload.thinking = { type: input.reasoningEnabled ? 'enabled' : 'disabled' };
        if (input.reasoningEnabled && input.reasoningEffort) {
            payload.reasoning_effort = input.reasoningEffort;
        }
    }
    return payload;
}

export type { OpenAI };

export * from './prompts';
