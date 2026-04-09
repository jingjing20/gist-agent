/**
 * 粗略估算 Token 消耗，用于成本控制和上下文长度规避。
 * 并非精确的 BPE 分词，通过字符权重实现平衡。
 */
import type OpenAI from 'openai';

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const CJK_CHARS_PER_TOKEN = 1.2; // 中文字符平均 Token 消耗
const ASCII_CHARS_PER_TOKEN = 4; // 英文字符/符号平均 Token 消耗
const MESSAGE_OVERHEAD = 4;      // 每条消息的基础 Overhead (role, name 等)

// 覆盖常用中日韩 Unicode 字符范围
const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}]/u;

export function estimateTokens(text: string): number {
	let cjkChars = 0;
	let asciiChars = 0;
	for (const ch of text) {
		if (CJK_RANGE.test(ch)) cjkChars++;
		else asciiChars++;
	}
	return Math.ceil(cjkChars / CJK_CHARS_PER_TOKEN + asciiChars / ASCII_CHARS_PER_TOKEN);
}

export function estimateMessageTokens(msg: Message): number {
	if (typeof msg.content === 'string') {
		return MESSAGE_OVERHEAD + estimateTokens(msg.content);
	}
	return MESSAGE_OVERHEAD + estimateTokens(JSON.stringify(msg));
}

export function estimateMessagesTokens(msgs: Message[]): number {
	return msgs.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
