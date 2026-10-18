import { FOLLOW_UP_PROMPT, parseSuggestionTexts } from '@gist/llm';
import type { AnalysisState, AnalysisOutcome, SchemaDetailV1, SuggestionItem } from '@gist/contracts';
import type { LlmService } from '../llm/llm.service';
import type { GenerationExecutionMetrics } from '../chat/generation.service';

export interface SuggestionDiagnostic {
    status: 'generated' | 'empty' | 'filtered' | 'context_too_large';
    reason: string | null;
    candidateCount: number;
    filteredCount: number;
    itemCount: number;
    inputCharacters: number;
}

/** Source fields matter more than result aliases; never include sample rows or SQL. */
export function buildFollowUpContext(input: {
    state: AnalysisState;
    outcome: Pick<AnalysisOutcome, 'status' | 'reason' | 'missingItems'>;
    schema: SchemaDetailV1[];
    blocks: Array<{ type: string; content?: string; analysis?: unknown }>;
}) {
    const s = input.state;
    const context = {
        conditions: {
            timeRange: s.timeRange,
            comparisonRange: s.comparisonRange,
            grain: s.grain,
            filters: s.filters.slice(0, 5).map((f) => ({
                ...f,
                field: f.field.slice(0, 100),
                value: Array.isArray(f.value)
                    ? f.value.slice(0, 10).map((v) => (typeof v === 'string' ? v.slice(0, 100) : v))
                    : typeof f.value === 'string'
                      ? f.value.slice(0, 100)
                      : f.value,
            })),
            definitions: s.temporaryNotes.slice(0, 5).map((n) => ({ name: n.name.slice(0, 100), description: n.description.slice(0, 300) })),
            openQuestions: s.openQuestions.slice(0, 5).map((q) => q.slice(0, 300)),
            hypotheses: s.hypotheses.slice(0, 5).map((h) => ({ statement: h.statement.slice(0, 300), status: h.status })),
        },
        status: input.outcome.status,
        missingItems: input.outcome.missingItems.slice(0, 5).map((s) => s.slice(0, 300)),
        limitation: input.outcome.reason?.slice(0, 500) ?? null,
        // The last prose block is the answer; earlier blocks narrate tool execution.
        answer:
            input.blocks
                .filter((b) => b.type === 'text' && !b.analysis && b.content?.trim())
                .at(-1)
                ?.content?.slice(-6000) ?? '',
        schema: input.schema.slice(0, 6).map((t) => ({
            table: t.table,
            columnsTruncated: t.columns.length > 40,
            columns: t.columns.slice(0, 40).map((c) => ({ name: c.name, type: c.type, description: c.description?.slice(0, 120) })),
        })),
    };
    // Keep valid structured data within the prompt budget instead of skipping the call.
    while (JSON.stringify(context).length > 16000 && context.schema.some((t) => t.columns.length > 1)) {
        const largest = [...context.schema].sort((a, b) => b.columns.length - a.columns.length)[0];
        largest.columns.pop();
        largest.columnsTruncated = true;
    }
    const excess = JSON.stringify(context).length - 16000;
    if (excess > 0) context.answer = excess >= context.answer.length ? '' : context.answer.slice(excess);
    return context;
}

function parseResponse(raw: string, question: string) {
    const parsed: unknown = JSON.parse(
        raw
            .trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/, '')
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('推荐响应必须是 JSON 对象');
    const { questions, emptyReason } = parsed as Record<string, unknown>;
    if (!Array.isArray(questions)) throw new Error('推荐响应缺少 questions 数组');
    if (!questions.length && (typeof emptyReason !== 'string' || !emptyReason.trim())) throw new Error('空推荐必须说明原因');
    if (emptyReason != null && typeof emptyReason !== 'string') throw new Error('推荐原因必须为字符串或 null');
    const items = parseSuggestionTexts(JSON.stringify(questions), [question]).map((text, i) => ({ id: `suggestion-${i + 1}`, text }));
    return { items, candidateCount: questions.length, reason: typeof emptyReason === 'string' ? emptyReason.trim().slice(0, 300) : null };
}

export function parseSuggestions(raw: string, question: string): SuggestionItem[] {
    return parseResponse(raw, question).items;
}

export async function generateSuggestions(input: {
    llm: LlmService;
    question: string;
    context: unknown;
    signal: AbortSignal;
    metrics: GenerationExecutionMetrics;
    onDiagnostic?: (diagnostic: SuggestionDiagnostic) => void;
}): Promise<SuggestionItem[]> {
    if (input.signal.aborted) throw input.signal.reason ?? new Error('推荐生成已取消');
    const controller = new AbortController();
    const cancel = () => controller.abort(input.signal.reason);
    input.signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('推荐问题生成超时')), 8_000);
    const system = FOLLOW_UP_PROMPT;
    let raw = '';
    try {
        const user = JSON.stringify({ question: input.question.slice(0, 2000), context: input.context });
        if (user.length > 18000) {
            input.onDiagnostic?.({
                status: 'context_too_large',
                reason: '推荐上下文超过字符预算',
                candidateCount: 0,
                filteredCount: 0,
                itemCount: 0,
                inputCharacters: user.length,
            });
            return [];
        }
        input.metrics.llmCallCount++;
        input.metrics.inputTokensEstimated += Math.ceil((system.length + user.length) / 2);
        const stream = await input.llm.streamWithTools(
            [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            [],
            { signal: controller.signal, reasoningEnabled: false }
        );
        for await (const chunk of stream) {
            if (controller.signal.aborted) throw controller.signal.reason;
            raw += chunk.choices[0]?.delta.content || '';
            if (raw.length > 4_000) throw new Error('推荐问题响应过长');
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        const result = parseResponse(raw, input.question);
        input.onDiagnostic?.({
            status: result.items.length ? 'generated' : result.candidateCount ? 'filtered' : 'empty',
            reason: result.reason,
            candidateCount: result.candidateCount,
            filteredCount: result.candidateCount - result.items.length,
            itemCount: result.items.length,
            inputCharacters: user.length,
        });
        return result.items;
    } finally {
        input.metrics.outputTokensEstimated += Math.ceil(raw.length / 2);
        clearTimeout(timeout);
        input.signal.removeEventListener('abort', cancel);
        controller.abort();
    }
}
