import { Injectable, Logger } from '@nestjs/common';
import { SchemaService } from '../database/schema.service';
import { ConversationService, Message } from '../conversation/conversation.service';
import { estimateMessageTokens, estimateMessagesTokens } from './token-estimator';
import type OpenAI from 'openai';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MAX_CONTEXT_TOKENS = Number(process.env.MAX_CONTEXT_TOKENS) || 32000;
const RESPONSE_RESERVE = 4000;
const TOOLS_RESERVE = 1500;

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

@Injectable()
export class PromptBuilder {
	private readonly logger = new Logger(PromptBuilder.name);

	constructor(
		private readonly schemaService: SchemaService,
		private readonly conversationService: ConversationService,
	) {}

	async buildSystemPrompt(datasourceId: number | null, userId: number, conversationId?: string): Promise<string> {
		const today = new Date().toISOString().split('T')[0];
		const schemaPrompt = await this.schemaService.getDatabaseSchemaPrompt(datasourceId, userId);

		let statePrompt = '';
		if (conversationId) {
			const conv = await this.conversationService.findOne(conversationId, userId);
			if (conv?.semantic_state) {
				const state = conv.semantic_state;
				const defs = Object.entries(state.definitions || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
				const facts = Object.entries(state.facts || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
				
				statePrompt = `\n## 历史业务背景与事实库 (Semantic Memory)\n`;
				if (defs) statePrompt += `### 业务定义/口径：\n${defs}\n`;
				if (facts) statePrompt += `### 已确认的数据事实：\n${facts}\n`;
			}
		}

		return `你是一个名为 Gist Agent 的高级数据分析专家。当前日期：${today}
可用数据库表：
${schemaPrompt}
${statePrompt}
## 工作流程（严格按顺序执行，不可跳步）

1. **理解需求** — 分析用户问题，确定所需的表和字段。
2. **查询数据** — 编写 SELECT 语句，调用 execute_sql_query。
3. **可视化判断** — 必须调用 analyze_result 判断查询结果是否需要图表可视化。
4. **生成图表** — 仅当 analyze_result 中 needsChart=true 时，调用 generate_chart 提供完整数据。
5. **文字总结** — 最后用自然语言直接回答用户问题，给出清晰的分析结论。

## 规则
- 查询数据后必须先调 analyze_result，再决定是否调 generate_chart。禁止跳过 analyze_result 直接生成图表。
- 文字总结必须在所有工具调用完成后再输出，不要在工具调用过程中输出。
- generate_chart 的数据必须严格来自 execute_sql_query 的查询结果，不得编造数据。`;
	}

	async buildMessages(
		conversationId: string,
		userId: number,
		systemPrompt: string,
	): Promise<ChatMessage[]> {
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
			`Context: ${history.length} msgs, ${selected.length} included (${selected.map(s => s.level[0]).join('')}), ` +
			`budget ${budgetForHistory} tokens, system ${systemTokens} tokens`,
		);

		return messages;
	}

	private toHistoryEntry(msg: Message): HistoryEntry {
		if (msg.role === 'user') {
			const userMsg: ChatMessage = { role: 'user', content: msg.content };
			const tokens = estimateMessageTokens(userMsg);
			return {
				fullMessages: [userMsg], mediumMessages: [userMsg], compactMessages: [userMsg],
				fullTokens: tokens, mediumTokens: tokens, compactTokens: tokens,
			};
		}

		const compactText = this.extractCompactText(msg);
		const compactMsg: ChatMessage = { role: 'assistant', content: compactText || '(无文字回复)' };
		const compactTokens = estimateMessageTokens(compactMsg);

		const hasLlmMessages = Array.isArray(msg.llm_messages) && msg.llm_messages.length > 0;

		const fullMessages = hasLlmMessages
			? (msg.llm_messages as ChatMessage[]).map((m) => this.dehydrateMessage(m))
			: [compactMsg];
		const fullTokens = hasLlmMessages ? estimateMessagesTokens(fullMessages) : compactTokens;

		const mediumMessages = hasLlmMessages
			? this.buildMediumMessages(msg.llm_messages as ChatMessage[], compactText)
			: [compactMsg];
		const mediumTokens = estimateMessagesTokens(mediumMessages);

		return {
			fullMessages, mediumMessages, compactMessages: [compactMsg],
			fullTokens, mediumTokens, compactTokens,
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

		const content = parts.length > 0 ? parts.join('\n') : (fallbackText || '(无文字回复)');
		return [{ role: 'assistant', content } as ChatMessage];
	}

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
				return { ...call, function: { ...call.function, arguments: JSON.stringify(skeleton) } };
			} catch {}
		}
		return call;
	}

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
	private selectEntriesWithinBudget(
		entries: HistoryEntry[],
		budget: number,
	): { index: number; level: CompressionLevel }[] {
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

	private getTokensForLevel(entry: HistoryEntry, level: CompressionLevel): number {
		switch (level) {
			case 'full': return entry.fullTokens;
			case 'medium': return entry.mediumTokens;
			case 'compact': return entry.compactTokens;
		}
	}

	private getMessagesForLevel(entry: HistoryEntry, level: CompressionLevel): ChatMessage[] {
		switch (level) {
			case 'full': return entry.fullMessages;
			case 'medium': return entry.mediumMessages;
			case 'compact': return entry.compactMessages;
		}
	}
}
