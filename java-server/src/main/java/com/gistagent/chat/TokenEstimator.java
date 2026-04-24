package com.gistagent.chat;

import java.util.List;

/**
 * 对齐 Nest 版 token-estimator.ts 的粗略估算。
 *
 * 不追求精确 BPE，而是按字符宽度近似，中日韩字符权重更高、
 * 每条消息额外留出一份固定 overhead，用于上下文预算控制。
 */
public final class TokenEstimator {

	private static final double CJK_CHARS_PER_TOKEN = 1.2;
	private static final double ASCII_CHARS_PER_TOKEN = 4.0;
	private static final int MESSAGE_OVERHEAD = 4;

	private TokenEstimator() {}

	public static int estimateTokens(String text) {
		if (text == null || text.isEmpty()) return 0;
		int cjk = 0;
		int ascii = 0;
		int len = text.length();
		for (int i = 0; i < len; ) {
			int cp = text.codePointAt(i);
			if (isCjk(cp)) cjk++;
			else ascii++;
			i += Character.charCount(cp);
		}
		return (int) Math.ceil(cjk / CJK_CHARS_PER_TOKEN + ascii / ASCII_CHARS_PER_TOKEN);
	}

	public static int estimateMessageTokens(ChatMessageDto msg) {
		if (msg == null) return 0;
		String content = msg.content() == null ? "" : msg.content();
		int base = MESSAGE_OVERHEAD + estimateTokens(content);
		// tool_calls / tool_call_id 走字符串化计数，粗略但稳定
		if (msg.toolCalls() != null && !msg.toolCalls().isEmpty()) {
			for (ToolCallDto call : msg.toolCalls()) {
				base += estimateTokens(call.name() == null ? "" : call.name());
				base += estimateTokens(call.arguments() == null ? "" : call.arguments());
			}
		}
		if (msg.toolCallId() != null) {
			base += estimateTokens(msg.toolCallId());
		}
		return base;
	}

	public static int estimateMessagesTokens(List<ChatMessageDto> msgs) {
		if (msgs == null || msgs.isEmpty()) return 0;
		int sum = 0;
		for (ChatMessageDto m : msgs) sum += estimateMessageTokens(m);
		return sum;
	}

	private static boolean isCjk(int cp) {
		// 覆盖 CJK 统一汉字、扩展 A、兼容汉字、扩展 B-F
		return (cp >= 0x4E00 && cp <= 0x9FFF)
				|| (cp >= 0x3400 && cp <= 0x4DBF)
				|| (cp >= 0xF900 && cp <= 0xFAFF)
				|| (cp >= 0x20000 && cp <= 0x2A6DF)
				|| (cp >= 0x2A700 && cp <= 0x2B73F);
	}
}
