import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { ConversationService } from '../../conversation/conversation.service';

@Injectable()
export class SemanticDistillerService {
	private readonly logger = new Logger(SemanticDistillerService.name);

	constructor(
		private readonly llm: LlmService,
		private readonly conversation: ConversationService
	) {}

	async updateStateAsync(conversationId: string, userId: number, userMessage: string, blocks: any[]) {
		this.distillAndUpdate(conversationId, userId, userMessage, blocks).catch(e => {
			this.logger.warn(`Semantic Distillation failed for conv ${conversationId}: ${e.message}`);
		});
	}

	private async distillAndUpdate(conversationId: string, userId: number, userMessage: string, blocks: any[]) {
		const conv = await this.conversation.findOne(conversationId, userId);
		if (!conv) return;

		let currentState = { definitions: {}, facts: {} };
		if (conv.semantic_state) {
			currentState = typeof conv.semantic_state === 'string' ? JSON.parse(conv.semantic_state) : conv.semantic_state;
		}

		const dataPreview = blocks.find(b => b.type === 'table')?.rows?.slice(0, 5) || [];
		const summaryBlock = blocks.slice().reverse().find(b => b.type === 'text')?.content || '';

		const systemPrompt = `你是一个幕后的知识蒸馏 Agent。你的任务是提取最新的一段数据分析对话中的【核心业务事实】和【业务名词口径】。
规则：
1. 若用户在对话中定义了新口径（如“活跃就是登录且消费”），提取加入 definitions。
2. 若本轮查库得出了核心事实（如“全年总营收500万”），提取加入 facts。
3. 如果某些事实已经过时或者被新结论纠正，请在生成的 JSON 中直接覆盖。
4. 返回必须是合法的 JSON 对象，包含 "definitions" 字典和 "facts" 字典（值必是字符串）。不要任何多余的话语或Markdown代码块。格式如：{"definitions":{},"facts":{}}。
5. 若无新信息，直接原样返回旧的状态。`;

		const userPrompt = `旧的状态: ${JSON.stringify(currentState)}
新的一轮对话：
用户问: ${userMessage}
查库部分样本数据(如果是查询): ${JSON.stringify(dataPreview)}
最终回答结论: ${summaryBlock}

请基于新回合信息，决定是否更新旧的状态，并返回更新后的完整纯 JSON 参数。`;

		const response = await this.llm.chat(systemPrompt, userPrompt, 0.1);
		const match = response.match(/\{[\s\S]*\}/);
		if (!match) return;

		try {
			const newState = JSON.parse(match[0]);
			// 只有解析成功才覆盖
			await this.conversation.updateSemanticState(conversationId, newState);
			this.logger.log(`Semantic state updated for conv ${conversationId}`);
		} catch (e) {
			this.logger.error(`Failed to parse/update distilled state: ${e}`);
		}
	}
}
