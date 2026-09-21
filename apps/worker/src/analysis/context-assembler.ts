import { createHash } from 'crypto';
import type OpenAI from 'openai';
import { estimateMessagesTokens, estimateTokens } from '../chat/token-estimator';
import { GenerationExecutionError } from '../chat/generation-errors';

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export interface ContextCandidate {
    id: string;
    category: string;
    priority: number;
    messages: Message[];
    required?: boolean;
}
/** Deterministic bounded selection. Tool-call/result batches are indivisible candidates. */
export function assembleContext(input: { messages: Message[]; system: string; tools: OpenAI.Chat.Completions.ChatCompletionTool[]; budget: number; extras: ContextCandidate[] }) {
    const base: Message[] = [{ role: 'system', content: input.system }, input.messages[1]];
    const groups: Message[][] = [];
    for (let i = 2; i < input.messages.length; i++) {
        const m = input.messages[i];
        if (m.role === 'assistant' && m.tool_calls?.length) {
            const group: Message[] = [m];
            const ids = new Set(m.tool_calls.map((c) => c.id));
            while (ids.size) {
                const next = input.messages[++i];
                if (!next || next.role !== 'tool' || !ids.delete(next.tool_call_id)) throw new GenerationExecutionError('ANALYSIS_PROTOCOL_ERROR', '上下文工具消息不完整');
                group.push(next);
            }
            groups.push(group);
        } else if (m.role === 'tool') throw new GenerationExecutionError('ANALYSIS_PROTOCOL_ERROR', '上下文存在孤立工具结果');
        else groups.push([m]);
    }
    const latestToolGroup = groups
        .map((g, i) => (g[0].role === 'assistant' && g[0].tool_calls?.length ? i : -1))
        .filter((i) => i >= 0)
        .pop();
    const candidates: ContextCandidate[] = [
        { id: 'current-task', category: 'rules-and-state', priority: 1, messages: base, required: true },
        ...groups.map((messages, i) => ({ id: `action-${i}`, category: 'tool-interaction', priority: 3, messages, required: i === groups.length - 1 || i === latestToolGroup })),
        ...input.extras,
    ];
    const toolTokens = estimateTokens(JSON.stringify(input.tools));
    let remaining = input.budget - toolTokens;
    const report = candidates.map((c) => ({
        candidateId: c.id,
        category: c.category,
        priority: c.priority,
        estimatedTokens: estimateMessagesTokens(c.messages),
        selected: false,
        omittedReason: 'budget',
        contentHash: createHash('sha256').update(JSON.stringify(c.messages)).digest('hex'),
    }));
    const ordered = candidates
        .map((c, i) => ({ c, i }))
        .sort(
            (a, b) =>
                Number(!!b.c.required) - Number(!!a.c.required) ||
                a.c.priority - b.c.priority ||
                (a.c.category === 'tool-interaction' && b.c.category === 'tool-interaction' ? b.i - a.i : a.i - b.i)
        );
    for (const { c, i } of ordered) {
        const r = report[i];
        if (r.estimatedTokens <= remaining) {
            r.selected = true;
            r.omittedReason = '';
            remaining -= r.estimatedTokens;
        } else if (c.required) throw new GenerationExecutionError('CONTEXT_BUDGET_EXCEEDED', '当前问题、状态、关键口径与最新完整工具链超出预算，请缩小问题');
    }
    const selected = new Set(report.filter((r) => r.selected).map((r) => r.candidateId));
    // History remains before this turn; old tool batches retain their original execution order.
    const keptExtras = input.extras.filter((c) => selected.has(c.id));
    const extraMessages = [...keptExtras.filter((c) => c.category === 'recent-turn').reverse(), ...keptExtras.filter((c) => c.category !== 'recent-turn')].flatMap(
        (c) => c.messages
    );
    const messages: Message[] = [base[0], ...extraMessages, base[1], ...groups.flatMap((g, i) => (selected.has(`action-${i}`) ? g : []))];
    return { messages, report, estimatedTokens: input.budget - remaining, toolTokens };
}
