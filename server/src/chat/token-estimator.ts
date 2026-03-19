import type OpenAI from 'openai';

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const CHARS_PER_TOKEN = 2.5;
const MESSAGE_OVERHEAD = 4;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
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
