package com.gistagent.chat.tools;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import com.gistagent.chat.SseEvent;

/**
 * 工具执行的最终结果。
 *
 * - {@code toolMessageContent}：会回填给 LLM 的 tool 消息内容（通常是 JSON）。
 * - {@code blocks}：需要持久化到 message_block 的 SSE 事件；实时推送已经在
 *   工具内部完成，这里只是标记“这些事件属于本次 assistant 回复的一部分”。
 */
public record ToolExecutionResult(String toolMessageContent, List<SseEvent> blocks) {

	public static ToolExecutionResult of(String content) {
		return new ToolExecutionResult(content, Collections.emptyList());
	}

	public static ToolExecutionResult of(String content, List<SseEvent> blocks) {
		return new ToolExecutionResult(content, blocks == null ? Collections.emptyList() : blocks);
	}

	public static Builder builder(String content) {
		return new Builder(content);
	}

	public static final class Builder {
		private final String content;
		private final List<SseEvent> blocks = new ArrayList<>();

		private Builder(String content) {
			this.content = content;
		}

		public Builder block(SseEvent event) {
			blocks.add(event);
			return this;
		}

		public ToolExecutionResult build() {
			return new ToolExecutionResult(content, blocks);
		}
	}
}
