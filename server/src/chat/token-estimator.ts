import type OpenAI from 'openai';

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const CJK_CHARS_PER_TOKEN = 1.2;
const ASCII_CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;

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
