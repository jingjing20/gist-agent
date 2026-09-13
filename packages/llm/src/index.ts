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
        if (process.env.LLM_PROVIDER === 'mock') return '{"definitions":{}}';
        const response = await this.client.chat.completions.create({
            model: this.model,
            temperature,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        });
        const content = response.choices[0]?.message?.content?.trim();
        if (!content) throw new Error('LLM returned empty response');
        return content;
    }

    isReasoningActive(requested: boolean): boolean {
        return requested && this.supportsThinkingControl;
    }

    streamWithTools(
        messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: OpenAI.Chat.Completions.ChatCompletionTool[],
        options: { signal?: AbortSignal; reasoningEnabled?: boolean } = {}
    ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
        if (process.env.LLM_PROVIDER === 'mock') {
            return Promise.resolve(
                (async function* () {
                    for (const content of ['这是', '独立 Worker', ' 的流式测试响应。']) {
                        yield { choices: [{ delta: { content } }] } as OpenAI.Chat.Completions.ChatCompletionChunk;
                    }
                })()
            );
        }
        const payload = createStreamRequest({
            model: this.model,
            messages,
            tools,
            reasoningEnabled: options.reasoningEnabled === true,
            supportsThinkingControl: this.supportsThinkingControl,
            reasoningEffort: process.env.LLM_REASONING_EFFORT,
        });
        return this.client.chat.completions.create(
            payload as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
            options.signal ? { signal: options.signal } : undefined
        ) as unknown as Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
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
