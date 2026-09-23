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
    const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unexpected.length) throw new Error(`存在不允许的字段：${unexpected.join('、')}；只允许字段：${allowed.join('、')}。请删除多余字段后重试。`);
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
        description:
            '提交本轮结果。按用户要求自由组合有序内容块：默认 markdown；需要原始数据时使用 table 并引用查询证据；已生成图表时使用 chart 并引用图表 ID。不要强制添加标题、摘要、指标卡或局限章节。response 可标记 partial 并填写 reason。需要澄清时用 clarification，无法分析时用 refusal。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                kind: { type: 'string', enum: ['response', 'clarification', 'refusal'] },
                question: { type: 'string', description: '仅 clarification 必填。' },
                explanation: { type: 'string', description: '仅 refusal 必填。' },
                status: { type: 'string', enum: ['complete', 'partial'], description: '仅 response 必填。' },
                reason: { type: 'string', description: 'status=partial 时必填。' },
                blocks: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 20,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            type: { type: 'string', enum: ['markdown', 'table', 'chart'] },
                            content: { type: 'string', description: 'markdown 内容；可用标题、列表、段落，按用户要求组织。' },
                            evidence: { type: 'array', items: { type: 'string' }, description: 'markdown 中数据结论的查询证据 ID。' },
                            artifactId: { type: 'string', description: 'table 对应的查询证据 ID。' },
                            title: { type: 'string', description: 'table 可选标题。' },
                            chartArtifactId: { type: 'string', description: 'chart 对应的图表 ID。' },
                        },
                        required: ['type'],
                    },
                },
            },
            required: ['kind'],
        },
    },
};

export function validateSubmission(value: unknown, observed: Map<string, ObservedEvidence>, charts = new Map<string, string>()): AnalysisOutcome {
    const args = record(value);
    if (args.kind === 'response') {
        exactKeys(args, ['kind', 'status', 'reason', 'blocks']);
        if (args.status !== 'complete' && args.status !== 'partial') throw new Error('结果状态不合法');
        if (args.status === 'partial' && args.reason === undefined) throw new Error('部分结果必须说明 reason');
        if (args.status === 'complete' && args.reason !== undefined) throw new Error('完整结果不应包含 reason');
        if (!Array.isArray(args.blocks) || !args.blocks.length || args.blocks.length > 20) throw new Error('内容块数量必须为 1 至 20');
        const blocks = args.blocks.map((value: unknown) => {
            const block = record(value);
            if (block.type === 'markdown') {
                exactKeys(block, ['type', 'content', 'evidence']);
                if (!Array.isArray(block.evidence) || block.evidence.length > 20) throw new Error('文字块证据无效');
                const evidence = block.evidence.map((value: unknown) => {
                    const id = text(value);
                    const source = observed.get(id);
                    if (!source) throw new Error(`证据 ${id} 不是本轮已观察的查询结果`);
                    if (source.blocked) throw new Error('质量受限证据不能支持确定结论');
                    return id;
                });
                return { type: 'markdown' as const, content: text(block.content), evidence: [...new Set(evidence)] };
            }
            if (block.type === 'table') {
                exactKeys(block, ['type', 'artifactId', 'title']);
                const artifactId = text(block.artifactId);
                const source = observed.get(artifactId);
                if (!source) throw new Error(`表格证据 ${artifactId} 不是本轮已观察的查询结果`);
                if (source.blocked) throw new Error('质量受限的查询结果不能作为完整表格交付');
                const title = block.title === undefined ? undefined : text(block.title);
                return { type: 'table' as const, artifactId, ...(title === undefined ? {} : { title }) };
            }
            if (block.type === 'chart') {
                exactKeys(block, ['type', 'chartArtifactId']);
                const chartArtifactId = text(block.chartArtifactId);
                const queryId = charts.get(chartArtifactId);
                if (!queryId) throw new Error(`图表 ${chartArtifactId} 不是本轮已生成的图表`);
                if (observed.get(queryId)?.blocked) throw new Error('质量受限证据不能支持图表结论');
                return { type: 'chart' as const, chartArtifactId };
            }
            throw new Error('内容块类型不合法');
        });
        if (observed.size && !blocks.some((block) => block.type !== 'markdown' || block.evidence.length))
            throw new Error('数据回答至少需要引用一项本轮查询证据');
        return { kind: 'response', status: args.status, blocks, ...(args.reason === undefined ? {} : { reason: text(args.reason) }) };
    }
    if (args.kind === 'clarification') {
        exactKeys(args, ['kind', 'question']);
        return { kind: 'clarification', question: text(args.question) };
    }
    if (args.kind === 'refusal') {
        exactKeys(args, ['kind', 'explanation']);
        return { kind: 'refusal', explanation: text(args.explanation) };
    }
    if (args.kind === 'table') {
        exactKeys(args, ['kind', 'tables', 'note']);
        if (!Array.isArray(args.tables) || args.tables.length < 1 || args.tables.length > 4) throw new Error('表格结果需要 1 至 4 个查询证据');
        const seen = new Set<string>();
        const tables = args.tables.map((value: unknown) => {
            const table = record(value);
            exactKeys(table, ['artifactId', 'title']);
            const artifactId = text(table.artifactId);
            if (seen.has(artifactId)) throw new Error('表格证据重复');
            seen.add(artifactId);
            const source = observed.get(artifactId);
            if (!source) throw new Error(`表格证据 ${artifactId} 不是本轮已观察的查询结果`);
            if (source.blocked) throw new Error('质量受限的查询结果不能作为完整表格交付，请修改查询或说明范围');
            const title = table.title === undefined ? undefined : text(table.title);
            if (title && title.length > 80) throw new Error('表格标题过长');
            return { artifactId, ...(title === undefined ? {} : { title }) };
        });
        const note = args.note === undefined ? undefined : text(args.note);
        if (note && note.length > 240) throw new Error('表格说明过长');
        return { kind: 'table', tables, ...(note === undefined ? {} : { note }) };
    }
    if (args.kind === 'direct') {
        exactKeys(args, ['kind', 'content', 'evidence']);
        const content = text(args.content);
        if (content.length > 2000) throw new Error('简短回答过长');
        if (!Array.isArray(args.evidence) || !args.evidence.length || args.evidence.length > 10) throw new Error('简短数据回答需要查询证据');
        const evidence = args.evidence.map((id: unknown) => {
            const artifactId = text(id);
            const source = observed.get(artifactId);
            if (!source) throw new Error(`证据 ${artifactId} 不是本轮已观察的查询结果`);
            if (source.blocked) throw new Error('质量受限证据不能支持确定回答');
            return artifactId;
        });
        return { kind: 'direct', content, evidence: [...new Set(evidence)] };
    }
    if (args.kind !== 'answer' && args.kind !== 'partial') throw new Error('kind 不合法');
    exactKeys(args, ['kind', 'answer', 'reason']);
    const a = record(args.answer);
    exactKeys(a, ['summary', 'keyPoints', 'metrics', 'findings', 'limitations', 'unresolvedQuestions']);
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
            exactKeys(e, ['artifactId', 'role', 'comparisonLabel']);
            const artifactId = text(e.artifactId);
            const source = observed.get(artifactId);
            if (!source) throw new Error(`证据 ${artifactId} 不是本轮已观察的查询证据；图表 ID 不能作为分析证据，请改用生成图表时的 queryArtifactId。`);
            if (source.blocked && f.kind !== 'hypothesis') throw new Error('质量受限证据不能支持确定结论，请追加聚合或验证');
            if (!['observation', 'verification', 'comparison'].includes(String(e.role))) throw new Error('证据角色无效');
            return {
                artifactId,
                role: e.role as 'observation' | 'verification' | 'comparison',
                ...(e.comparisonLabel === undefined ? {} : { comparisonLabel: text(e.comparisonLabel) }),
            };
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
    const keyPoints = a.keyPoints === undefined ? [] : texts(a.keyPoints);
    if (keyPoints.length > 3) throw new Error('关键判断最多三条');
    if (keyPoints.some((point) => point.length > 160) || new Set(keyPoints).size !== keyPoints.length) throw new Error('关键判断需简短且不能重复');
    if (a.metrics !== undefined && (!Array.isArray(a.metrics) || a.metrics.length > 4)) throw new Error('关键指标最多四项');
    const metrics = (a.metrics ?? []).map((value: unknown) => {
        const metric = record(value);
        exactKeys(metric, ['label', 'value', 'detail', 'findingId']);
        const findingId = text(metric.findingId);
        const finding = findings.find((item) => item.id === findingId);
        if (!finding || finding.kind === 'hypothesis') throw new Error(`关键指标 ${findingId} 必须关联已证实的发现`);
        const label = text(metric.label);
        const displayValue = text(metric.value);
        const detail = metric.detail === undefined ? undefined : text(metric.detail);
        if (label.length > 40 || displayValue.length > 80 || (detail && detail.length > 120)) throw new Error('关键指标文字过长');
        return { label, value: displayValue, ...(detail === undefined ? {} : { detail }), findingId };
    });
    const summary = text(a.summary);
    if (summary.length > 320) throw new Error('核心结论过长，请用一句话直接回答问题');
    const answer: AnalysisAnswer = { summary, keyPoints, metrics, findings, limitations: texts(a.limitations), unresolvedQuestions: texts(a.unresolvedQuestions) };
    if (args.kind === 'partial') {
        if (!answer.limitations.length) throw new Error('部分结果必须说明局限');
        return { kind: 'partial', answer, reason: text(args.reason) };
    }
    return { kind: 'answer', answer };
}

export function renderOutcome(outcome: AnalysisOutcome): string {
    if (outcome.kind === 'response')
        return outcome.blocks.map((block) => (block.type === 'markdown' ? block.content : block.type === 'table' ? `表格：${block.title || '查询结果'}` : '图表')).join('\n\n');
    if (outcome.kind === 'clarification') return `需要确认：${outcome.question}`;
    if (outcome.kind === 'refusal') return outcome.explanation;
    if (outcome.kind === 'table')
        return `表格结果：${outcome.tables.map((table, index) => table.title || `表格 ${index + 1}`).join('、')}${outcome.note ? `。${outcome.note}` : ''}`;
    if (outcome.kind === 'direct') return outcome.content;
    const parts = [outcome.kind === 'partial' ? `部分分析结果：${outcome.reason}` : '', outcome.answer.summary];
    if (outcome.answer.keyPoints?.length) parts.push(outcome.answer.keyPoints.map((s) => `- ${s}`).join('\n'));
    if (outcome.answer.metrics?.length) parts.push(outcome.answer.metrics.map((m) => `${m.label}：${m.value}${m.detail ? `（${m.detail}）` : ''}`).join('；'));
    for (const f of outcome.answer.findings) {
        parts.push(
            `${f.kind === 'hypothesis' ? '待验证：' : ''}${f.text}${f.evidence.length ? `\n证据：${f.evidence.map((e) => e.artifactId + (e.comparisonLabel ? `（${e.comparisonLabel}）` : '')).join('、')}` : ''}`
        );
    }
    if (outcome.answer.limitations.length) parts.push(`限制：\n${outcome.answer.limitations.map((s) => `- ${s}`).join('\n')}`);
    if (outcome.answer.unresolvedQuestions.length) parts.push(`尚待确认：\n${outcome.answer.unresolvedQuestions.map((s) => `- ${s}`).join('\n')}`);
    return parts.filter(Boolean).join('\n\n');
}
