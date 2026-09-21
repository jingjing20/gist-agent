import type OpenAI from 'openai';
import type { AnalysisAnswer, AnalysisFinding, AnalysisOutcome } from '@gist/contracts';

export interface ObservedEvidence {
    blocked: boolean;
    sql: string;
}

export function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('必须提供对象');
    return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
    if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('存在不允许的字段');
}

function text(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 8000) throw new Error('文字不能为空或超过 8000 字符');
    return value.trim();
}

function texts(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 20) throw new Error('必须提供不超过 20 项的数组');
    return value.map(text);
}

export const SUBMIT_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: 'function',
    function: {
        name: 'submit_analysis',
        description: '提交本轮正式结果并停止。answer 为完整回答，partial 为部分结果，clarification 为澄清，refusal 为拒绝。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                kind: { type: 'string', enum: ['answer', 'partial', 'clarification', 'refusal'] },
                question: { type: 'string' },
                explanation: { type: 'string' },
                reason: { type: 'string' },
                answer: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        summary: { type: 'string' },
                        findings: {
                            type: 'array',
                            maxItems: 20,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    id: { type: 'string' },
                                    text: { type: 'string' },
                                    kind: { type: 'string', enum: ['observation', 'supported_explanation', 'hypothesis'] },
                                    evidence: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            additionalProperties: false,
                                            properties: { artifactId: { type: 'string' }, role: { type: 'string', enum: ['observation', 'verification', 'comparison'] } },
                                            required: ['artifactId', 'role'],
                                        },
                                    },
                                },
                                required: ['id', 'text', 'kind', 'evidence'],
                            },
                        },
                        limitations: { type: 'array', items: { type: 'string' } },
                        unresolvedQuestions: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['summary', 'findings', 'limitations', 'unresolvedQuestions'],
                },
            },
            required: ['kind'],
        },
    },
};

export function validateSubmission(value: unknown, observed: Map<string, ObservedEvidence>, closing: boolean): AnalysisOutcome {
    const args = record(value);
    if (closing && args.kind !== 'partial') throw new Error('预算已耗尽，只能提交 partial');
    if (args.kind === 'clarification') {
        exactKeys(args, ['kind', 'question']);
        return { kind: 'clarification', question: text(args.question) };
    }
    if (args.kind === 'refusal') {
        exactKeys(args, ['kind', 'explanation']);
        return { kind: 'refusal', explanation: text(args.explanation) };
    }
    if (args.kind !== 'answer' && args.kind !== 'partial') throw new Error('kind 不合法');
    exactKeys(args, ['kind', 'answer', 'reason']);
    const a = record(args.answer);
    exactKeys(a, ['summary', 'findings', 'limitations', 'unresolvedQuestions']);
    if (!Array.isArray(a.findings) || a.findings.length > 20) throw new Error('findings 必须是不超过 20 项的数组');
    const ids = new Set<string>();
    const findings: AnalysisFinding[] = a.findings.map((value: unknown) => {
        const f = record(value);
        exactKeys(f, ['id', 'text', 'kind', 'evidence']);
        const id = text(f.id);
        if (ids.has(id)) throw new Error('发现 ID 重复');
        ids.add(id);
        if (!['observation', 'supported_explanation', 'hypothesis'].includes(String(f.kind))) throw new Error('发现类型不合法');
        if (!Array.isArray(f.evidence) || f.evidence.length > 20) throw new Error('证据引用无效');
        const evidence = f.evidence.map((value: unknown) => {
            const e = record(value);
            exactKeys(e, ['artifactId', 'role']);
            const artifactId = text(e.artifactId);
            const source = observed.get(artifactId);
            if (!source) throw new Error('只能引用本轮成功观察到的查询证据');
            if (source.blocked && f.kind !== 'hypothesis') throw new Error('质量受限证据不能支持确定结论，请追加聚合或验证');
            if (!['observation', 'verification', 'comparison'].includes(String(e.role))) throw new Error('证据角色无效');
            return { artifactId, role: e.role as 'observation' | 'verification' | 'comparison' };
        });
        if (f.kind !== 'hypothesis' && evidence.length === 0) throw new Error('数据发现需要证据');
        if (f.kind === 'supported_explanation') {
            const verified = evidence.filter((e) => e.role === 'verification');
            const observations = evidence.filter((e) => e.role !== 'verification');
            if (!verified.length || !observations.length || !verified.some((v) => observations.some((o) => observed.get(v.artifactId)!.sql !== observed.get(o.artifactId)!.sql))) {
                throw new Error('主要解释需要观察证据及不同查询的验证证据；这只是结构检查，不代表因果证明');
            }
        }
        return { id, text: text(f.text), kind: f.kind as AnalysisFinding['kind'], evidence };
    });
    const answer: AnalysisAnswer = { summary: text(a.summary), findings, limitations: texts(a.limitations), unresolvedQuestions: texts(a.unresolvedQuestions) };
    if (args.kind === 'partial') {
        if (!answer.limitations.length) throw new Error('部分结果必须说明局限');
        return { kind: 'partial', answer, reason: text(args.reason) };
    }
    return { kind: 'answer', answer };
}

export function renderOutcome(outcome: AnalysisOutcome): string {
    if (outcome.kind === 'clarification') return `需要确认：${outcome.question}`;
    if (outcome.kind === 'refusal') return outcome.explanation;
    const parts = [outcome.kind === 'partial' ? `部分分析结果：${outcome.reason}` : '', outcome.answer.summary];
    for (const f of outcome.answer.findings) {
        parts.push(`${f.kind === 'hypothesis' ? '待验证：' : ''}${f.text}${f.evidence.length ? `\n证据：${f.evidence.map((e) => e.artifactId).join('、')}` : ''}`);
    }
    if (outcome.answer.limitations.length) parts.push(`限制：\n${outcome.answer.limitations.map((s) => `- ${s}`).join('\n')}`);
    if (outcome.answer.unresolvedQuestions.length) parts.push(`尚待确认：\n${outcome.answer.unresolvedQuestions.map((s) => `- ${s}`).join('\n')}`);
    return parts.filter(Boolean).join('\n\n');
}
