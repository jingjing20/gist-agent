package com.gistagent.chat;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import com.gistagent.conversation.ConversationService;
import com.gistagent.database.SchemaService;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 组装 System Prompt 并按 Token 预算裁剪历史消息。
 *
 * 多级压缩策略（对齐 Nest 版 prompt-builder.ts）：
 * - 最近 {@link #FULL_WINDOW} 条：保留完整 tool chain（full）。
 * - 中距 {@link #MEDIUM_WINDOW} 条：保留 SQL + 结果行数 + 结论（medium）。
 * - 更远的历史：只保留纯文本摘要（compact）。
 */
@Component
public class PromptBuilder {

	private static final Logger log = LoggerFactory.getLogger(PromptBuilder.class);
	private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd");

	private static final int MAX_CONTEXT_TOKENS;
	private static final int RESPONSE_RESERVE = 4000;
	private static final int TOOLS_RESERVE = 1500;
	private static final int FULL_WINDOW = 2;
	private static final int MEDIUM_WINDOW = 6;

	static {
		String env = System.getenv("MAX_CONTEXT_TOKENS");
		int def = 32000;
		if (env != null && !env.isBlank()) {
			try { def = Integer.parseInt(env.trim()); } catch (NumberFormatException ignored) {}
		}
		MAX_CONTEXT_TOKENS = def;
	}

	private final SchemaService schemaService;
	private final ConversationService conversationService;
	private final ChatMessageConverter converter;

	public PromptBuilder(SchemaService schemaService,
						 ConversationService conversationService,
						 ChatMessageConverter converter) {
		this.schemaService = schemaService;
		this.conversationService = conversationService;
		this.converter = converter;
	}

	public String buildSystemPrompt(Long datasourceId, long userId, String conversationId) {
		String today = LocalDate.now().format(DATE_FMT);
		String schemaPrompt = schemaService.getDatabaseSchemaPrompt(datasourceId, userId);

		String statePrompt = "";
		if (conversationId != null) {
			Map<String, Object> conv = conversationService.findOne(conversationId, userId);
			if (conv != null && conv.get("semantic_state") instanceof Map<?, ?> raw) {
				Object defs = raw.get("definitions");
				if (defs instanceof Map<?, ?> m && !m.isEmpty()) {
					StringBuilder sb = new StringBuilder();
					for (Map.Entry<?, ?> e : m.entrySet()) {
						sb.append("- ").append(e.getKey()).append(": ").append(e.getValue()).append('\n');
					}
					statePrompt = "\n## 业务口径定义 (Semantic Memory)\n" + sb;
				}
			}
		}

		return "你是一个名为 Gist Agent 的高级数据分析专家。当前日期：" + today + "\n"
				+ "可用数据库表：\n"
				+ schemaPrompt + "\n"
				+ statePrompt + "\n"
				+ "## 工作流程（严格按顺序执行，不可跳步）\n\n"
				+ "1. **理解需求** — 分析用户问题，确定所需的表和字段。\n"
				+ "2. **查询数据** — 编写 SELECT 语句，调用 execute_sql_query。\n"
				+ "3. **可视化判断** — 必须调用 analyze_result 判断查询结果是否需要图表可视化。\n"
				+ "4. **生成图表** — 仅当 analyze_result 中 needsChart=true 时，调用 generate_chart 提供完整数据。\n"
				+ "5. **文字总结** — 最后用自然语言直接回答用户问题，给出清晰的分析结论。\n\n"
				+ "## 规则\n"
				+ "- 查询数据后必须先调 analyze_result，再决定是否调 generate_chart。禁止跳过 analyze_result 直接生成图表。\n"
				+ "- 文字总结必须在所有工具调用完成后再输出，不要在工具调用过程中输出。\n"
				+ "- generate_chart 的数据必须严格来自 execute_sql_query 的查询结果，不得编造数据。";
	}

	public List<ChatMessageDto> buildMessages(String conversationId, long userId, String systemPrompt) {
		ChatMessageDto systemMsg = ChatMessageDto.system(systemPrompt);
		int systemTokens = TokenEstimator.estimateMessageTokens(systemMsg);
		int budget = MAX_CONTEXT_TOKENS - systemTokens - RESPONSE_RESERVE - TOOLS_RESERVE;

		List<Map<String, Object>> history = conversationService.getMessages(conversationId, userId);
		if (history.isEmpty()) {
			return List.of(systemMsg);
		}

		List<HistoryEntry> entries = history.stream().map(this::toHistoryEntry).toList();
		List<Selection> selected = selectEntriesWithinBudget(entries, budget);

		List<ChatMessageDto> out = new ArrayList<>();
		out.add(systemMsg);
		for (Selection s : selected) {
			out.addAll(entries.get(s.index).messagesFor(s.level));
		}

		log.debug("Context: {} msgs, {} included, budget {} tokens, system {} tokens",
				history.size(), selected.size(), budget, systemTokens);
		return out;
	}

	// --- 压缩逻辑 ---------------------------------------------------------

	private enum Level { FULL, MEDIUM, COMPACT }

	private record Selection(int index, Level level) {}

	private record HistoryEntry(
			List<ChatMessageDto> fullMessages,
			List<ChatMessageDto> mediumMessages,
			List<ChatMessageDto> compactMessages,
			int fullTokens,
			int mediumTokens,
			int compactTokens
	) {
		List<ChatMessageDto> messagesFor(Level level) {
			return switch (level) {
				case FULL -> fullMessages;
				case MEDIUM -> mediumMessages;
				case COMPACT -> compactMessages;
			};
		}
		int tokensFor(Level level) {
			return switch (level) {
				case FULL -> fullTokens;
				case MEDIUM -> mediumTokens;
				case COMPACT -> compactTokens;
			};
		}
	}

	private HistoryEntry toHistoryEntry(Map<String, Object> msg) {
		String role = (String) msg.get("role");
		String content = (String) msg.getOrDefault("content", "");

		if ("user".equals(role)) {
			ChatMessageDto user = ChatMessageDto.user(content);
			int tokens = TokenEstimator.estimateMessageTokens(user);
			return new HistoryEntry(
					List.of(user), List.of(user), List.of(user),
					tokens, tokens, tokens
			);
		}

		// assistant 消息
		String compactText = extractCompactText(msg);
		ChatMessageDto compactMsg = ChatMessageDto.assistant(
				(compactText == null || compactText.isEmpty()) ? "(无文字回复)" : compactText);
		int compactTokens = TokenEstimator.estimateMessageTokens(compactMsg);

		List<ChatMessageDto> storedLlm = converter.fromStoredList(msg.get("llm_messages"));
		boolean hasLlm = !storedLlm.isEmpty();

		List<ChatMessageDto> fullMessages = hasLlm
				? storedLlm.stream().map(PromptBuilder::dehydrateMessage).toList()
				: List.of(compactMsg);
		int fullTokens = TokenEstimator.estimateMessagesTokens(fullMessages);

		List<ChatMessageDto> mediumMessages = hasLlm
				? List.of(buildMediumMessage(storedLlm, compactText))
				: List.of(compactMsg);
		int mediumTokens = TokenEstimator.estimateMessagesTokens(mediumMessages);

		return new HistoryEntry(
				fullMessages, mediumMessages, List.of(compactMsg),
				fullTokens, mediumTokens, compactTokens
		);
	}

	private ChatMessageDto buildMediumMessage(List<ChatMessageDto> llmMessages, String fallbackText) {
		List<String> parts = new ArrayList<>();
		for (ChatMessageDto m : llmMessages) {
			if ("assistant".equals(m.role()) && m.toolCalls() != null) {
				for (ToolCallDto call : m.toolCalls()) {
					if ("execute_sql_query".equals(call.name()) && call.arguments() != null) {
						String sql = extractJsonField(call.arguments(), "sql");
						if (sql != null) parts.add("[SQL] " + sql);
					}
				}
			}
			if ("tool".equals(m.role()) && m.content() != null) {
				Integer rowCount = extractRowCount(m.content());
				if (rowCount != null) parts.add("[结果: " + rowCount + " 行]");
			}
			if ("assistant".equals(m.role())
					&& (m.toolCalls() == null || m.toolCalls().isEmpty())
					&& m.content() != null && !m.content().isBlank()) {
				parts.add(m.content());
			}
		}
		String content = parts.isEmpty()
				? (fallbackText == null || fallbackText.isEmpty() ? "(无文字回复)" : fallbackText)
				: String.join("\n", parts);
		return ChatMessageDto.assistant(content);
	}

	private static ChatMessageDto dehydrateMessage(ChatMessageDto msg) {
		if ("tool".equals(msg.role()) && msg.content() != null) {
			return new ChatMessageDto(msg.role(), dehydrateToolResult(msg.content()),
					msg.toolCalls(), msg.toolCallId());
		}
		if ("assistant".equals(msg.role()) && msg.toolCalls() != null) {
			List<ToolCallDto> dehydrated = msg.toolCalls().stream()
					.map(PromptBuilder::dehydrateToolCall).toList();
			return new ChatMessageDto(msg.role(), msg.content(), dehydrated, msg.toolCallId());
		}
		return msg;
	}

	private static String dehydrateToolResult(String content) {
		// 与 Nest 版一致：识别两种结构（数组 / {data:[...]}），转成行数+列名摘要
		try {
			Object parsed = MAPPER.readValue(content, Object.class);
			if (parsed instanceof List<?> list) {
				if (list.isEmpty()) return "[查询结果: 0 行]";
				if (list.get(0) instanceof Map<?, ?> first) {
					return "[查询结果: " + list.size() + " 行, 列: " + String.join(", ", keysOf(first)) + "]";
				}
			}
			if (parsed instanceof Map<?, ?> map && map.get("data") instanceof List<?> data) {
				int total = data.size();
				String cols = total > 0 && data.get(0) instanceof Map<?, ?> first
						? String.join(", ", keysOf(first)) : "";
				String meta = "[查询结果: " + total + " 行, 列: " + cols + "]";
				Object sysMsg = map.get("systemMessage");
				return sysMsg == null ? meta : meta + "\n" + sysMsg;
			}
		} catch (Exception ignored) {}
		return content.length() > 500 ? content.substring(0, 500) + "...[已截断]" : content;
	}

	private static ToolCallDto dehydrateToolCall(ToolCallDto call) {
		if (!"generate_chart".equals(call.name()) || call.arguments() == null) return call;
		try {
			Map<?, ?> args = MAPPER.readValue(call.arguments(), Map.class);
			java.util.LinkedHashMap<String, Object> skeleton = new java.util.LinkedHashMap<>();
			skeleton.put("chartType", args.get("chartType"));
			skeleton.put("title", args.get("title"));
			skeleton.put("xAxisName", args.get("xAxisName"));
			skeleton.put("_note", "[图表数据已省略]");
			return new ToolCallDto(call.id(), call.name(), MAPPER.writeValueAsString(skeleton));
		} catch (Exception e) {
			return call;
		}
	}

	// --- 预算调度 --------------------------------------------------------

	private List<Selection> selectEntriesWithinBudget(List<HistoryEntry> entries, int budget) {
		int remaining = budget;
		List<Selection> selected = new ArrayList<>();
		int total = entries.size();

		for (int i = total - 1; i >= 0; i--) {
			HistoryEntry entry = entries.get(i);
			int distance = total - 1 - i;
			List<Level> levels = distance < FULL_WINDOW
					? List.of(Level.FULL, Level.MEDIUM, Level.COMPACT)
					: distance < MEDIUM_WINDOW
					? List.of(Level.MEDIUM, Level.COMPACT)
					: List.of(Level.COMPACT);
			for (Level level : levels) {
				int tokens = entry.tokensFor(level);
				if (tokens <= remaining) {
					selected.add(new Selection(i, level));
					remaining -= tokens;
					break;
				}
			}
		}
		Collections.reverse(selected);
		return selected;
	}

	// --- 工具函数 --------------------------------------------------------

	@SuppressWarnings("unchecked")
	private String extractCompactText(Map<String, Object> msg) {
		String content = (String) msg.get("content");
		if (content != null && !content.isEmpty()) return content;
		Object blocks = msg.get("blocks");
		if (blocks instanceof List<?> list) {
			StringBuilder sb = new StringBuilder();
			for (Object b : list) {
				if (b instanceof Map<?, ?> bm && "text".equals(bm.get("type"))) {
					Object c = ((Map<String, Object>) bm).get("content");
					if (c != null) {
						if (sb.length() > 0) sb.append('\n');
						sb.append(c);
					}
				}
			}
			return sb.toString();
		}
		return "";
	}

	private static String extractJsonField(String json, String field) {
		try {
			Map<?, ?> map = MAPPER.readValue(json, Map.class);
			Object v = map.get(field);
			return v == null ? null : v.toString();
		} catch (Exception e) {
			return null;
		}
	}

	private static Integer extractRowCount(String content) {
		try {
			Object parsed = MAPPER.readValue(content, Object.class);
			if (parsed instanceof List<?> l) return l.size();
			if (parsed instanceof Map<?, ?> m && m.get("data") instanceof List<?> data) return data.size();
		} catch (Exception ignored) {}
		return null;
	}

	private static List<String> keysOf(Map<?, ?> m) {
		List<String> out = new ArrayList<>(m.size());
		for (Object k : m.keySet()) out.add(String.valueOf(k));
		return out;
	}

	// Jackson instance used for local dehydration only - kept static to avoid
	// threading ObjectMapper through every dehydration helper.
	private static final com.fasterxml.jackson.databind.ObjectMapper MAPPER =
			new com.fasterxml.jackson.databind.ObjectMapper();
}
