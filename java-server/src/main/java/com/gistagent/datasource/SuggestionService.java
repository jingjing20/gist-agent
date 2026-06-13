package com.gistagent.datasource;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.gistagent.common.ApiException;
import com.gistagent.database.SchemaService;
import com.gistagent.llm.LlmService;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

/**
 * Port of the Nest SuggestionService. LLM output is cached in {@code datasource_suggestions} keyed
 * by (datasource_id, user_id).
 *
 * <p>Async methods delegate to a self-inject so Spring's proxy kicks in; we do not swallow LLM
 * errors silently in sync calls — the controller's getSuggestions surface still returns 500 when
 * generation actually fails on a cache miss.
 */
@Service
public class SuggestionService {

  private static final Logger log = LoggerFactory.getLogger(SuggestionService.class);
  private static final Pattern JSON_ARRAY = Pattern.compile("\\[[\\s\\S]*\\]");

  private final JdbcTemplate jdbc;
  private final SchemaService schema;
  private final LlmService llm;
  private final ObjectMapper mapper;

  public SuggestionService(
      JdbcTemplate jdbc, SchemaService schema, LlmService llm, ObjectMapper mapper) {
    this.jdbc = jdbc;
    this.schema = schema;
    this.llm = llm;
    this.mapper = mapper;
  }

  public List<String> getSuggestions(long datasourceId, long userId) {
    List<String> cached = getFromCache(datasourceId, userId);
    if (cached != null) return cached;
    return generateAndCache(datasourceId, userId);
  }

  @Async
  public void triggerAsync(long datasourceId, long userId) {
    try {
      generateAndCache(datasourceId, userId);
    } catch (Exception e) {
      log.warn(
          "background suggestion generation failed for ds={} user={}: {}",
          datasourceId,
          userId,
          e.getMessage());
    }
  }

  @Async
  public void invalidateAndRegenerate(long datasourceId, long userId) {
    try {
      jdbc.update(
          "DELETE FROM datasource_suggestions WHERE datasource_id = ? AND user_id = ?",
          datasourceId,
          userId);
      generateAndCache(datasourceId, userId);
    } catch (Exception e) {
      log.warn(
          "background suggestion invalidate+regen failed for ds={} user={}: {}",
          datasourceId,
          userId,
          e.getMessage());
    }
  }

  private List<String> getFromCache(long datasourceId, long userId) {
    return jdbc.query(
        "SELECT questions FROM datasource_suggestions WHERE datasource_id = ? AND user_id = ?",
        rs -> {
          if (!rs.next()) return null;
          String q = rs.getString("questions");
          if (q == null || q.isBlank()) return null;
          try {
            return mapper.readValue(
                q, mapper.getTypeFactory().constructCollectionType(List.class, String.class));
          } catch (Exception e) {
            return null;
          }
        },
        datasourceId,
        userId);
  }

  private List<String> generateAndCache(long datasourceId, long userId) {
    String schemaPrompt = schema.getDatabaseSchemaPrompt(datasourceId, userId);
    List<String> questions = callLlm(schemaPrompt);
    String json;
    try {
      json = mapper.writeValueAsString(questions);
    } catch (Exception e) {
      throw ApiException.internal("序列化 suggestions 失败");
    }
    jdbc.update(
        "INSERT INTO datasource_suggestions (datasource_id, user_id, questions) VALUES (?, ?, ?) "
            + "ON DUPLICATE KEY UPDATE questions = VALUES(questions), created_at = CURRENT_TIMESTAMP",
        datasourceId,
        userId,
        json);
    return questions;
  }

  private List<String> callLlm(String schemaPrompt) {
    String system =
        """
				你是一个业务数据分析专家。根据给定的数据库 schema，生成 3 个业务人员最关心的、可以用自然语言提问的问题。
				要求：
				- 使用简洁、自然的业务口吻提问（例如：“帮我分析下不同平台的活跃趋势”）
				- **禁止** 在问题中提及具体的表名、字段名或任何数据库术语（如：关联、主键、指标计算等）
				- 问题要聚焦核心业务价值（如：留存分析、各区域对比、增长趋势等）
				- 只返回 JSON 数组，格式：["问题1", "问题2", "问题3"]
				- 不要有任何辅助文字""";
    String user = "数据库 Schema:\n" + schemaPrompt;
    String raw = llm.chat(system, user, 0.3);
    Matcher m = JSON_ARRAY.matcher(raw);
    if (!m.find()) throw ApiException.internal("LLM returned invalid JSON for suggestions");
    try {
      List<String> parsed =
          mapper.readValue(
              m.group(), mapper.getTypeFactory().constructCollectionType(List.class, String.class));
      if (parsed == null || parsed.isEmpty()) {
        throw ApiException.internal("LLM returned invalid array");
      }
      return parsed.size() > 3 ? parsed.subList(0, 3) : parsed;
    } catch (ApiException e) {
      throw e;
    } catch (Exception e) {
      throw ApiException.internal("解析 LLM 返回失败: " + e.getMessage());
    }
  }
}
