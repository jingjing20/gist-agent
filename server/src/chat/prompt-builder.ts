import { Injectable, Logger } from '@nestjs/common';
import { SchemaService } from '../database/schema.service';
import { ConversationService, Message } from '../conversation/conversation.service';
import { estimateMessageTokens, estimateMessagesTokens } from './token-estimator';
import type OpenAI from 'openai';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MAX_CONTEXT_TOKENS = Number(process.env.MAX_CONTEXT_TOKENS) || 32000;
const RESPONSE_RESERVE = 4000;
const TOOLS_RESERVE = 1500;

interface HistoryEntry {
	fullMessages: ChatMessage[];
	compactMessages: ChatMessage[];
	fullTokens: number;
	compactTokens: number;
}

@Injectable()
export class PromptBuilder {
	private readonly logger = new Logger(PromptBuilder.name);

	constructor(
		private readonly schemaService: SchemaService,
		private readonly conversationService: ConversationService,
	) {}

	async buildSystemPrompt(datasourceId: number | null, userId: number): Promise<string> {
		const today = new Date().toISOString().split('T')[0];
		const schemaPrompt = await this.schemaService.getDatabaseSchemaPrompt(datasourceId, userId);

		return `你是一个名为 Gist Agent 的高级数据分析专家。当前日期：${today}
可用数据库表：
${schemaPrompt}

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
		for (const { index, full } of selected) {
			const entry = entries[index];
			messages.push(...(full ? entry.fullMessages : entry.compactMessages));
		}

		this.logger.debug(
			`Context: ${history.length} msgs, ${selected.length} included, ` +
			`budget ${budgetForHistory} tokens, system ${systemTokens} tokens`,
		);

		return messages;
	}

	private toHistoryEntry(msg: Message): HistoryEntry {
		if (msg.role === 'user') {
			const userMsg: ChatMessage = { role: 'user', content: msg.content };
			const tokens = estimateMessageTokens(userMsg);
			return { fullMessages: [userMsg], compactMessages: [userMsg], fullTokens: tokens, compactTokens: tokens };
		}

		const compactText = this.extractCompactText(msg);
		const compactMsg: ChatMessage = { role: 'assistant', content: compactText || '(无文字回复)' };
		const compactTokens = estimateMessageTokens(compactMsg);

		const hasLlmMessages = Array.isArray(msg.llm_messages) && msg.llm_messages.length > 0;
		const fullMessages = hasLlmMessages ? (msg.llm_messages as ChatMessage[]) : [compactMsg];
		const fullTokens = hasLlmMessages ? estimateMessagesTokens(fullMessages) : compactTokens;

		return { fullMessages, compactMessages: [compactMsg], fullTokens, compactTokens };
	}

	private extractCompactText(msg: Message): string {
		if (msg.content) return msg.content;
		if (!Array.isArray(msg.blocks)) return '';
		return (msg.blocks as any[])
			.filter((b) => b.type === 'text')
			.map((b) => b.content)
			.join('\n');
	}

	private selectEntriesWithinBudget(
		entries: HistoryEntry[],
		budget: number,
	): { index: number; full: boolean }[] {
		let remaining = budget;
		const selected: { index: number; full: boolean }[] = [];

		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.fullTokens <= remaining) {
				selected.unshift({ index: i, full: true });
				remaining -= entry.fullTokens;
			} else if (entry.compactTokens <= remaining) {
				selected.unshift({ index: i, full: false });
				remaining -= entry.compactTokens;
			} else {
				break;
			}
		}

		return selected;
	}
}
