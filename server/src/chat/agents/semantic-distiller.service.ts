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

	async updateStateAsync(conversationId: string, userId: number, userMessage: string) {
		this.distillAndUpdate(conversationId, userId, userMessage).catch(e => {
			this.logger.warn(`Semantic Distillation failed for conv ${conversationId}: ${e.message}`);
		});
	}

	private async distillAndUpdate(conversationId: string, userId: number, userMessage: string) {
		const conv = await this.conversation.findOne(conversationId, userId);
		if (!conv) return;

		let currentState = { definitions: {} };
		if (conv.semantic_state) {
			const raw = typeof conv.semantic_state === 'string' ? JSON.parse(conv.semantic_state) : conv.semantic_state;
			currentState = { definitions: raw.definitions || {} };
		}

		const systemPrompt = `你是一个幕后的知识蒸馏 Agent。你的任务是从数据分析对话中提取【业务名词口径】。
规则：
1. 若用户在对话中定义了业务口径（如"活跃就是登录且消费"），提取加入 definitions。
2. 只提取用户主观定义的口径，不要提取查询结果中的数据事实。
3. 返回必须是合法的 JSON 对象，包含 "definitions" 字典（值必是字符串）。不要任何多余的话语或Markdown代码块。格式如：{"definitions":{}}。
4. 若无新口径，直接原样返回旧的状态。`;

		const userPrompt = `旧的状态: ${JSON.stringify(currentState)}
新的一轮对话：
用户问: ${userMessage}

请基于新回合信息，决定是否更新旧的状态，并返回更新后的完整纯 JSON 参数。`;

		const response = await this.llm.chat(systemPrompt, userPrompt, 0.1);
		const match = response.match(/\{[\s\S]*\}/);
		if (!match) return;

		try {
			const newState = JSON.parse(match[0]);
			await this.conversation.updateSemanticState(conversationId, newState);
			this.logger.log(`Semantic state updated for conv ${conversationId}`);
		} catch (e) {
			this.logger.error(`Failed to parse/update distilled state: ${e}`);
		}
	}
}
