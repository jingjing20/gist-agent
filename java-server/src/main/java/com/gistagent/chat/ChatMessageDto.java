package com.gistagent.chat;

import java.util.List;

/**
 * 内部中性的 Chat 消息表示，用于在 DB、Prompt 构建器、Agent Loop 与 OpenAI SDK
 * 之间转换。直接存 OpenAI SDK 的 union 类型既不好持久化也不好估算 token，
 * 所以统一用这个简易 POJO。
 */
public record ChatMessageDto(
		String role,                    // system / user / assistant / tool
		String content,
		List<ToolCallDto> toolCalls,    // 仅 assistant 可能有
		String toolCallId               // 仅 tool 消息有
) {
	public static ChatMessageDto system(String content) {
		return new ChatMessageDto("system", content, null, null);
	}

	public static ChatMessageDto user(String content) {
		return new ChatMessageDto("user", content, null, null);
	}

	public static ChatMessageDto assistant(String content) {
		return new ChatMessageDto("assistant", content, null, null);
	}

	public static ChatMessageDto assistant(String content, List<ToolCallDto> toolCalls) {
		return new ChatMessageDto("assistant", content, toolCalls, null);
	}

	public static ChatMessageDto tool(String toolCallId, String content) {
		return new ChatMessageDto("tool", content, null, toolCallId);
	}
}
