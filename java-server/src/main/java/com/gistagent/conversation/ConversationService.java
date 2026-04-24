package com.gistagent.conversation;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gistagent.common.ApiException;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Port of the Nest ConversationService.
 *
 * Response rows intentionally stay as LinkedHashMap to keep parity with the
 * Nest implementation which just returns raw MySQL rows; JSON columns
 * (semantic_state / blocks / llm_messages / metadata) are deserialized so the
 * wire format matches what the frontend already consumes.
 */
@Service
public class ConversationService {

	private static final Logger log = LoggerFactory.getLogger(ConversationService.class);

	private final JdbcTemplate jdbc;
	private final ObjectMapper mapper;

	public ConversationService(JdbcTemplate jdbc, ObjectMapper mapper) {
		this.jdbc = jdbc;
		this.mapper = mapper;
	}

	@PostConstruct
	void ensureMigrations() {
		addColumnIfMissing("conversation", "user_id", "ALTER TABLE conversation ADD COLUMN user_id INT NULL AFTER id");
		addColumnIfMissing("conversation", "datasource_id", "ALTER TABLE conversation ADD COLUMN datasource_id INT NULL AFTER user_id");
		addColumnIfMissing("conversation", "semantic_state", "ALTER TABLE conversation ADD COLUMN semantic_state JSON NULL COMMENT 'Semantic Summary' AFTER title");
		addColumnIfMissing("message", "llm_messages", "ALTER TABLE message ADD COLUMN llm_messages JSON NULL AFTER blocks");
		addIndexIfMissing("message", "idx_conv_time", "ALTER TABLE message ADD INDEX idx_conv_time (conversation_id, created_at)");
	}

	private void addColumnIfMissing(String table, String column, String alterSql) {
		try {
			Integer count = jdbc.queryForObject(
					"SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
					Integer.class, table, column);
			if (count == null || count == 0) {
				jdbc.execute(alterSql);
			}
		} catch (Exception e) {
			log.debug("migration skip {}.{}: {}", table, column, e.getMessage());
		}
	}

	private void addIndexIfMissing(String table, String index, String alterSql) {
		try {
			Integer count = jdbc.queryForObject(
					"SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
					Integer.class, table, index);
			if (count == null || count == 0) {
				jdbc.execute(alterSql);
			}
		} catch (Exception e) {
			log.debug("migration skip index {}.{}: {}", table, index, e.getMessage());
		}
	}

	public List<Map<String, Object>> findAll(long userId) {
		List<Map<String, Object>> rows = jdbc.queryForList(
				"SELECT * FROM conversation WHERE user_id = ? ORDER BY updated_at DESC", userId);
		rows.forEach(this::inflateConversationJson);
		return rows;
	}

	public Map<String, Object> findOne(String id, long userId) {
		List<Map<String, Object>> rows = jdbc.queryForList(
				"SELECT * FROM conversation WHERE id = ? AND user_id = ?", id, userId);
		if (rows.isEmpty()) return null;
		Map<String, Object> row = rows.get(0);
		inflateConversationJson(row);
		return row;
	}

	public Map<String, Object> create(long userId, String title) {
		String id = UUID.randomUUID().toString();
		String finalTitle = (title == null || title.isBlank()) ? "新对话" : title;
		jdbc.update("INSERT INTO conversation (id, user_id, title) VALUES (?, ?, ?)",
				id, userId, finalTitle);
		return findOne(id, userId);
	}

	public void updateTitle(String id, String title, Long datasourceId) {
		jdbc.update("UPDATE conversation SET title = ?, datasource_id = ? WHERE id = ?",
				title, datasourceId, id);
	}

	public void updateSemanticState(String id, Object state) {
		try {
			jdbc.update("UPDATE conversation SET semantic_state = ? WHERE id = ?",
					mapper.writeValueAsString(state), id);
		} catch (JsonProcessingException e) {
			throw ApiException.internal("序列化 semantic_state 失败");
		}
	}

	public void remove(String id, long userId) {
		Map<String, Object> conv = findOne(id, userId);
		if (conv == null) throw ApiException.notFound("对话不存在或无权删除");
		// message_block -> message -> conversation 均有 ON DELETE CASCADE
		jdbc.update("DELETE FROM conversation WHERE id = ?", id);
	}

	public List<Map<String, Object>> getMessages(String conversationId, long userId) {
		Map<String, Object> conv = findOne(conversationId, userId);
		if (conv == null) return List.of();

		List<Map<String, Object>> rows = jdbc.queryForList(
				"SELECT * FROM message WHERE conversation_id = ? ORDER BY created_at ASC",
				conversationId);
		if (rows.isEmpty()) return List.of();

		List<String> messageIds = rows.stream().map(r -> (String) r.get("id")).toList();
		String placeholders = String.join(", ", Collections.nCopies(messageIds.size(), "?"));
		List<Map<String, Object>> blockRows = jdbc.queryForList(
				"SELECT * FROM message_block WHERE message_id IN (" + placeholders
						+ ") ORDER BY message_id, sort_order",
				messageIds.toArray());

		Map<String, List<Map<String, Object>>> blocksByMessageId = new HashMap<>();
		for (Map<String, Object> row : blockRows) {
			String msgId = (String) row.get("message_id");
			Map<String, Object> metadata = parseJsonObject(row.get("metadata"));
			Map<String, Object> block = new LinkedHashMap<>();
			block.put("type", row.get("type"));
			Object content = row.get("content");
			if (content != null) block.put("content", content);
			if (metadata != null) block.putAll(metadata);
			blocksByMessageId.computeIfAbsent(msgId, k -> new ArrayList<>()).add(block);
		}

		List<Map<String, Object>> result = new ArrayList<>(rows.size());
		for (Map<String, Object> row : rows) {
			Map<String, Object> out = new LinkedHashMap<>(row);
			List<Map<String, Object>> blocksFromTable = blocksByMessageId.get((String) row.get("id"));
			List<Object> blocksFromJson = parseJsonArray(row.get("blocks"));
			out.put("blocks", (blocksFromTable != null && !blocksFromTable.isEmpty())
					? blocksFromTable
					: (blocksFromJson == null ? List.of() : blocksFromJson));
			List<Object> llm = parseJsonArray(row.get("llm_messages"));
			out.put("llm_messages", llm == null ? List.of() : llm);
			result.add(out);
		}
		return result;
	}

	/**
	 * Inserts a message + its blocks inside a single transaction.
	 *
	 * Nest returns the caller-supplied blocks verbatim alongside the new id
	 * and timestamps; we do the same so downstream SSE streaming code sees the
	 * exact shape it expects.
	 */
	@Transactional
	public Map<String, Object> addMessage(String conversationId,
										  String role,
										  String content,
										  List<Map<String, Object>> blocks,
										  List<Object> llmMessages) {
		if (!"user".equals(role) && !"assistant".equals(role)) {
			throw ApiException.badRequest("role 必须是 user 或 assistant");
		}

		String id = UUID.randomUUID().toString();
		String llmJson;
		try {
			llmJson = mapper.writeValueAsString(llmMessages == null ? List.of() : llmMessages);
		} catch (JsonProcessingException e) {
			throw ApiException.internal("序列化 llm_messages 失败");
		}

		jdbc.update("INSERT INTO message (id, conversation_id, role, content, llm_messages) VALUES (?, ?, ?, ?, ?)",
				id, conversationId, role, content, llmJson);

		if (blocks != null && !blocks.isEmpty()) {
			List<Object[]> batchArgs = new ArrayList<>(blocks.size());
			for (int i = 0; i < blocks.size(); i++) {
				Map<String, Object> block = blocks.get(i);
				String blockId = UUID.randomUUID().toString();
				String type = (String) block.get("type");
				Object blockContent = block.get("content");
				Map<String, Object> rest = new LinkedHashMap<>(block);
				rest.remove("type");
				rest.remove("content");
				String metadataStr;
				try {
					metadataStr = rest.isEmpty() ? null : mapper.writeValueAsString(rest);
				} catch (JsonProcessingException e) {
					throw ApiException.internal("序列化 message_block metadata 失败");
				}
				batchArgs.add(new Object[]{blockId, id, i, type, blockContent, metadataStr});
			}
			jdbc.batchUpdate(
					"INSERT INTO message_block (id, message_id, sort_order, type, content, metadata) VALUES (?, ?, ?, ?, ?, ?)",
					batchArgs);
		}

		jdbc.update("UPDATE conversation SET updated_at = NOW() WHERE id = ?", conversationId);

		Map<String, Object> out = new LinkedHashMap<>();
		out.put("id", id);
		out.put("conversation_id", conversationId);
		out.put("role", role);
		out.put("content", content);
		out.put("blocks", blocks == null ? List.of() : blocks);
		out.put("llm_messages", llmMessages == null ? List.of() : llmMessages);
		out.put("created_at", java.time.LocalDateTime.now());
		return out;
	}

	private void inflateConversationJson(Map<String, Object> row) {
		if (row.containsKey("semantic_state")) {
			row.put("semantic_state", parseJsonObject(row.get("semantic_state")));
		}
	}

	@SuppressWarnings("unchecked")
	private Map<String, Object> parseJsonObject(Object value) {
		if (value == null) return null;
		if (value instanceof Map<?, ?> m) return (Map<String, Object>) m;
		if (value instanceof String s) {
			if (s.isBlank()) return null;
			try {
				return mapper.readValue(s, Map.class);
			} catch (Exception e) {
				return null;
			}
		}
		return null;
	}

	@SuppressWarnings("unchecked")
	private List<Object> parseJsonArray(Object value) {
		if (value == null) return null;
		if (value instanceof List<?> l) return (List<Object>) l;
		if (value instanceof String s) {
			if (s.isBlank()) return List.of();
			try {
				return mapper.readValue(s, List.class);
			} catch (Exception e) {
				return List.of();
			}
		}
		return List.of();
	}
}
