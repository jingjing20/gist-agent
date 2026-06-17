import { Injectable, Logger } from '@nestjs/common';
import { SchemaService } from '../database/schema.service';
import { ConversationService, Message } from '../conversation/conversation.service';
import { estimateMessageTokens, estimateMessagesTokens } from './token-estimator';
import type OpenAI from 'openai';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// --- Token 预算分配常量 ---
// 总容量 = MAX_CONTEXT_TOKENS
//   - RESPONSE_RESERVE: 留给模型生成回复的预算
//   - TOOLS_RESERVE: 工具定义（function calling schema）的预算
//   - 剩余: 历史消息预算，按距离远近分配压缩级别
const MAX_CONTEXT_TOKENS = Number(process.env.MAX_CONTEXT_TOKENS) || 32000;
const RESPONSE_RESERVE = 4000;
const TOOLS_RESERVE = 1500;

// 时间窗口：最近 FULL_WINDOW 条保留完整 tool chain，
// FULL_WINDOW ~ MEDIUM_WINDOW 条保留 SQL+行数+结论，
// 超过 MEDIUM_WINDOW 的只保留纯文字摘要
const FULL_WINDOW = 2;
const MEDIUM_WINDOW = 6;

type CompressionLevel = 'full' | 'medium' | 'compact';

interface HistoryEntry {
    fullMessages: ChatMessage[];
    mediumMessages: ChatMessage[];
    compactMessages: ChatMessage[];
    fullTokens: number;
    mediumTokens: number;
    compactTokens: number;
}

/**
 * 提示词构建器：负责组装 System Prompt 并根据 Token 预算管理上下文窗口。
 * 使用多级压缩策略（Full/Medium/Compact）确保在有限的 Context Window 内保留尽可能多的关键信息。
 */
@Injectable()
export class PromptBuilder {
    private readonly logger = new Logger(PromptBuilder.name);

    constructor(
        private readonly schemaService: SchemaService,
        private readonly conversationService: ConversationService
    ) {}

    /**
     * 构建系统提示词：包含身份定义、实时表结构、业务口径（语义状态）和强制执行规则。
     */
    async buildSystemPrompt(datasourceId: number | null, userId: number, conversationId?: string): Promise<string> {
        const today = new Date().toISOString().split('T')[0];
        const schemaPrompt = await this.schemaService.getDatabaseSchemaPrompt(datasourceId, userId);

        let statePrompt = '';
        if (conversationId) {
            const conv = await this.conversationService.findOne(conversationId, userId);
            if (conv?.semantic_state) {
                const state = conv.semantic_state;
                const defs = Object.entries(state.definitions || {})
                    .map(([k, v]) => `- ${k}: ${v}`)
                    .join('\n');
                if (defs) statePrompt = `\n## 业务口径（用户在对话中给出的术语定义，解释和 SQL 过滤条件都必须遵循）\n${defs}\n`;
            }
        }

        return `你是 Gist Agent，一名严谨的数据分析助手。当前日期：${today}（"最近 N 天 / 上周 / 本月"等相对时间一律以此为锚点）。

## 可用数据库表（只能查询以下表与字段，遇到表中不存在的概念必须先向用户澄清，禁止编造表名或列名）
${schemaPrompt}
${statePrompt}
## 工作方式
你以 ReAct 循环工作：思考 → 输出意图 → 调用工具 → 输出观察 → 决定下一步。

- 与数据无关的问题（打招呼、询问能力、闲聊）直接用文字回答，不要查库。
- 每次调用工具前，**必须**先用一句话说明你打算做什么（如"我来查一下最近30天各平台的日活数据"）。
- 需要数据时调用 execute_sql_query；当一次查询不足以回答（需先看样本、再做聚合、或交叉验证），可多次调用，每次调用前都先说明意图。
- 拿到工具结果后，**必须**用一句话说明你观察到什么或下一步打算做什么（如"数据已拿到63条，接下来分析趋势"）。
- 拿到数据后调用 analyze_result 判断是否需要图表；仅当 needsChart=true 时再调用 generate_chart，其 series/xAxis 必须严格来自 SQL 结果，不得编造。

## 输出要求
- 关键数字加粗；多结论用要点列出，避免长段落。
- SQL 报错或结果为空时，如实说明现象并给出可能原因或下一步建议，绝不编造数据填补。`;
    }

    /**
     * 构建完整的消息列表：计算预算 -> 加载历史 -> 择优压缩并填充。
     */
    async buildMessages(conversationId: string, userId: number, systemPrompt: string): Promise<ChatMessage[]> {
        const systemMsg: ChatMessage = { role: 'system', content: systemPrompt };
        const systemTokens = estimateMessageTokens(systemMsg);
        const budgetForHistory = MAX_CONTEXT_TOKENS - systemTokens - RESPONSE_RESERVE - TOOLS_RESERVE;

        const history = await this.conversationService.getMessages(conversationId, userId);
        if (history.length === 0) return [systemMsg];

        const entries = history.map((msg) => this.toHistoryEntry(msg));
        const selected = this.selectEntriesWithinBudget(entries, budgetForHistory);

        const messages: ChatMessage[] = [systemMsg];
        for (const { index, level } of selected) {
            messages.push(...this.getMessagesForLevel(entries[index], level));
        }

        this.logger.debug(
            `Context: ${history.length} msgs, ${selected.length} included (${selected.map((s) => s.level[0]).join('')}), ` +
                `budget ${budgetForHistory} tokens, system ${systemTokens} tokens`
        );

        return messages;
    }

    /**
     * 将数据库消息转为带有三种压缩级别的 HistoryEntry。
     */
    private toHistoryEntry(msg: Message): HistoryEntry {
        if (msg.role === 'user') {
            const userMsg: ChatMessage = { role: 'user', content: msg.content };
            const tokens = estimateMessageTokens(userMsg);
            return {
                fullMessages: [userMsg],
                mediumMessages: [userMsg],
                compactMessages: [userMsg],
                fullTokens: tokens,
                mediumTokens: tokens,
                compactTokens: tokens,
            };
        }

        const compactText = this.extractCompactText(msg);
        const compactMsg: ChatMessage = {
            role: 'assistant',
            content: compactText || '(无文字回复)',
        };
        const compactTokens = estimateMessageTokens(compactMsg);

        const hasLlmMessages = Array.isArray(msg.llm_messages) && msg.llm_messages.length > 0;

        const fullMessages = hasLlmMessages ? (msg.llm_messages as ChatMessage[]).map((m) => this.dehydrateMessage(m)) : [compactMsg];
        const fullTokens = hasLlmMessages ? estimateMessagesTokens(fullMessages) : compactTokens;

        const mediumMessages = hasLlmMessages ? this.buildMediumMessages(msg.llm_messages as ChatMessage[], compactText) : [compactMsg];
        const mediumTokens = estimateMessagesTokens(mediumMessages);

        return {
            fullMessages,
            mediumMessages,
            compactMessages: [compactMsg],
            fullTokens,
            mediumTokens,
            compactTokens,
        };
    }

    /**
     * medium 级别：将一整轮 tool chain 坍缩为一条 assistant 消息。
     * 保留: SQL 文本 + 结果行数 + 最终文字结论。
     * 丢弃: 原始数据、图表参数、中间 analyze_result。
     */
    private buildMediumMessages(llmMessages: ChatMessage[], fallbackText: string): ChatMessage[] {
        const parts: string[] = [];

        for (const msg of llmMessages) {
            if (msg.role === 'assistant' && (msg as any).tool_calls) {
                for (const call of (msg as any).tool_calls) {
                    if (call.function?.name === 'execute_sql_query') {
                        try {
                            const args = JSON.parse(call.function.arguments);
                            if (args.sql) parts.push(`[SQL] ${args.sql}`);
                        } catch {}
                    }
                }
            }

            if (msg.role === 'tool' && typeof msg.content === 'string') {
                const rowCount = this.extractRowCount(msg.content);
                if (rowCount !== null) parts.push(`[结果: ${rowCount} 行]`);
            }

            if (msg.role === 'assistant' && !(msg as any).tool_calls && typeof msg.content === 'string' && msg.content.trim()) {
                parts.push(msg.content);
            }
        }

        const content = parts.length > 0 ? parts.join('\n') : fallbackText || '(无文字回复)';
        return [{ role: 'assistant', content } as ChatMessage];
    }

    /**
     * 从 JSON 结果字符串中安全提取行数。
     */
    private extractRowCount(content: string): number | null {
        try {
            const raw = JSON.parse(content);
            if (Array.isArray(raw)) return raw.length;
            if (raw && typeof raw === 'object' && Array.isArray(raw.data)) return raw.data.length;
        } catch {}
        return null;
    }

    /**
     * full 级别的逐条脱水：tool 结果只留元信息，图表 tool_call 剥离数据。
     */
    private dehydrateMessage(msg: ChatMessage): ChatMessage {
        if (msg.role === 'tool' && typeof msg.content === 'string') {
            return { ...msg, content: this.dehydrateToolResult(msg.content) };
        }

        if (msg.role === 'assistant' && (msg as any).tool_calls) {
            const calls = (msg as any).tool_calls.map((c: any) => this.dehydrateToolCall(c));
            return { ...msg, tool_calls: calls } as ChatMessage;
        }

        return msg;
    }

    /**
     * 数据脱水：将庞大的查询结果集（Array/Object）转化为结构摘要，保留元数据，丢弃具体行数据。
     */
    private dehydrateToolResult(content: string): string {
        try {
            const raw = JSON.parse(content);

            if (Array.isArray(raw)) {
                if (raw.length === 0) return '[查询结果: 0 行]';
                const columns = Object.keys(raw[0]);
                return `[查询结果: ${raw.length} 行, 列: ${columns.join(', ')}]`;
            }

            if (raw && typeof raw === 'object' && Array.isArray(raw.data)) {
                const totalRows = raw.data.length;
                const columns = totalRows > 0 ? Object.keys(raw.data[0]) : [];
                const meta = `[查询结果: ${totalRows} 行, 列: ${columns.join(', ')}]`;
                return raw.systemMessage ? `${meta}\n${raw.systemMessage}` : meta;
            }

            const str = JSON.stringify(raw);
            return str.length > 500 ? str.slice(0, 500) + '...[已截断]' : content;
        } catch {
            return content.length > 500 ? content.slice(0, 500) + '...[已截断]' : content;
        }
    }

    /**
     * 移除工具调用参数中的重负载内容（如 generate_chart 中的 data 数组）。
     */
    private dehydrateToolCall(call: any): any {
        if (call.function?.name === 'generate_chart' && call.function.arguments) {
            try {
                const args = JSON.parse(call.function.arguments);
                const skeleton = {
                    chartType: args.chartType,
                    title: args.title,
                    xAxisName: args.xAxisName,
                    _note: '[图表数据已省略]',
                };
                return {
                    ...call,
                    function: { ...call.function, arguments: JSON.stringify(skeleton) },
                };
            } catch {}
        }
        return call;
    }

    /**
     * 提取消息的纯文本部分作为“紧凑级”回复。
     */
    private extractCompactText(msg: Message): string {
        if (msg.content) return msg.content;
        if (!Array.isArray(msg.blocks)) return '';
        return (msg.blocks as any[])
            .filter((b) => b.type === 'text')
            .map((b) => b.content)
            .join('\n');
    }

    /**
     * 从最新往旧选历史条目，按距离分配压缩级别。
     * 最近 FULL_WINDOW 条: full -> medium -> compact
     * 中距 MEDIUM_WINDOW 条: medium -> compact
     * 远距: compact only
     * 任何级别都放不下时 skip（不 break），继续尝试更早的条目。
     */
    private selectEntriesWithinBudget(entries: HistoryEntry[], budget: number): { index: number; level: CompressionLevel }[] {
        let remaining = budget;
        const selected: { index: number; level: CompressionLevel }[] = [];
        const total = entries.length;

        for (let i = total - 1; i >= 0; i--) {
            const entry = entries[i];
            const distance = total - 1 - i;

            let levels: CompressionLevel[];
            if (distance < FULL_WINDOW) levels = ['full', 'medium', 'compact'];
            else if (distance < MEDIUM_WINDOW) levels = ['medium', 'compact'];
            else levels = ['compact'];

            for (const level of levels) {
                const tokens = this.getTokensForLevel(entry, level);
                if (tokens <= remaining) {
                    selected.unshift({ index: i, level });
                    remaining -= tokens;
                    break;
                }
            }
        }

        return selected;
    }

    /**
     * 状态映射：获取指定级别的 Token 计数。
     */
    private getTokensForLevel(entry: HistoryEntry, level: CompressionLevel): number {
        switch (level) {
            case 'full':
                return entry.fullTokens;
            case 'medium':
                return entry.mediumTokens;
            case 'compact':
                return entry.compactTokens;
        }
    }

    /**
     * 状态映射：获取指定级别的消息数组。
     */
    private getMessagesForLevel(entry: HistoryEntry, level: CompressionLevel): ChatMessage[] {
        switch (level) {
            case 'full':
                return entry.fullMessages;
            case 'medium':
                return entry.mediumMessages;
            case 'compact':
                return entry.compactMessages;
        }
    }
}
