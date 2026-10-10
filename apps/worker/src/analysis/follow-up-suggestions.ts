import { FOLLOW_UP_PROMPT, parseSuggestionTexts } from '@gist/llm';
import type { SuggestionItem } from '@gist/contracts';
import type { LlmService } from '../llm/llm.service';
import type { GenerationExecutionMetrics } from '../chat/generation.service';

export function parseSuggestions(raw: string, question: string): SuggestionItem[] {
    return parseSuggestionTexts(raw, [question]).map((text, i) => ({ id: `suggestion-${i + 1}`, text }));
}

export async function generateSuggestions(input: {
    llm: LlmService;
    question: string;
    context: unknown;
    signal: AbortSignal;
    metrics: GenerationExecutionMetrics;
}): Promise<SuggestionItem[]> {
    const controller = new AbortController();
    const cancel = () => controller.abort(input.signal.reason);
    input.signal.addEventListener('abort', cancel, { once: true });
    if (input.signal.aborted) cancel();
    const timeout = setTimeout(() => controller.abort(new Error('推荐问题生成超时')), 8_000);
    const system = FOLLOW_UP_PROMPT;
    const user = JSON.stringify({ question: input.question.slice(0, 2000), context: input.context });
    if (user.length > 18000) {
        clearTimeout(timeout);
        input.signal.removeEventListener('abort', cancel);
        return [];
    }
    let raw = '';
    try {
        input.metrics.llmCallCount++;
        input.metrics.inputTokensEstimated += Math.ceil((system.length + user.length) / 2);
        const stream = await input.llm.streamWithTools(
            [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            [],
            {
                signal: controller.signal,
                reasoningEnabled: false,
            }
        );
        for await (const chunk of stream) {
            if (controller.signal.aborted) throw controller.signal.reason;
            raw += chunk.choices[0]?.delta.content || '';
            if (raw.length > 4_000) throw new Error('推荐问题响应过长');
        }
        return parseSuggestions(raw, input.question);
    } finally {
        input.metrics.outputTokensEstimated += Math.ceil(raw.length / 2);
        clearTimeout(timeout);
        input.signal.removeEventListener('abort', cancel);
        controller.abort();
    }
}
