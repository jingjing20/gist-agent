import { Injectable } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import type { QueryResult } from './sql-executor';

const SYSTEM_PROMPT = `你是一个数据分析助手。根据用户的原始问题和 SQL 查询结果，生成清晰、有洞察力的中文分析总结。

规则：
1. 用自然语言总结数据中的关键发现
2. 如果数据有趋势，指出趋势方向
3. 如果有异常值，指出异常
4. 给出简要的数据解读，不需要复述每一行数据
5. 回答要简洁专业`;

@Injectable()
export class SummarizerAgent {
	constructor(private readonly llm: LlmService) { }

	async summarize(
		userMessage: string,
		sql: string,
		result: QueryResult,
		onChunk?: (chunk: string) => void,
	): Promise<string> {
		const dataPreview = JSON.stringify(result.rows.slice(0, 50));

		const userPrompt = `用户问题: ${userMessage}

执行的 SQL: ${sql}

查询结果（共 ${result.rowCount} 行，以下展示前 50 行）:
列名: ${result.columns.join(', ')}
数据: ${dataPreview}

请对以上数据进行分析总结。`;

		if (onChunk) {
			return this.llm.chatStream(SYSTEM_PROMPT, userPrompt, 0.3, onChunk);
		}
		return this.llm.chat(SYSTEM_PROMPT, userPrompt, 0.3);
	}
}
