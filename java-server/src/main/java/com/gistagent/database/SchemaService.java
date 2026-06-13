package com.gistagent.database;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.gistagent.common.JdbcScalars;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Manages DB schema visibility and prompt generation for the AI.
 *
 * <p>Port of the Nest SchemaService. Access control semantics: - internal/local datasource: preset
 * business tables + user's uploaded tables - external datasource: only user's uploaded tables
 */
@Service
public class SchemaService {

  private static final List<String> PRESET_BUSINESS_TABLES =
      List.of("platform_info", "daily_active_stats", "user_behavior_log");
  private static final Duration CACHE_TTL = Duration.ofMinutes(1);

  private final JdbcTemplate jdbc;
  private final Map<String, CacheEntry> cache = new ConcurrentHashMap<>();

  public SchemaService(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public String getDatabaseSchemaPrompt(Long datasourceId, long userId) {
    String cacheKey = cacheKey(datasourceId, userId);
    CacheEntry cached = cache.get(cacheKey);
    if (cached != null
        && Duration.between(cached.createdAt, Instant.now()).compareTo(CACHE_TTL) < 0) {
      return cached.prompt;
    }

    boolean internal = isInternalDs(datasourceId);
    List<String> uploaded = getUserUploadedTableNames(datasourceId, userId);
    List<String> allowed = internal ? merge(PRESET_BUSINESS_TABLES, uploaded) : uploaded;

    if (allowed.isEmpty()) {
      return internal ? "当前数据库中没有可用的业务表。" : "当前数据源中还没有上传的表。";
    }

    String prompt = fetchSchemaPromptFromLocal(allowed, uploaded);
    if (prompt != null && !prompt.isBlank()) {
      cache.put(cacheKey, new CacheEntry(prompt, Instant.now()));
    }
    return prompt;
  }

  public void clearUserCache(Long datasourceId, long userId) {
    cache.remove(cacheKey(datasourceId, userId));
  }

  public List<String> getAllowedTableNames(Long datasourceId, long userId) {
    boolean internal = isInternalDs(datasourceId);
    List<String> uploaded = getUserUploadedTableNames(datasourceId, userId);
    return internal ? merge(PRESET_BUSINESS_TABLES, uploaded) : uploaded;
  }

  public List<StructuredTable> getStructuredSchema(Long datasourceId, long userId) {
    boolean internal = isInternalDs(datasourceId);
    List<String> uploaded = getUserUploadedTableNames(datasourceId, userId);
    List<String> allowed = internal ? merge(PRESET_BUSINESS_TABLES, uploaded) : uploaded;
    if (allowed.isEmpty()) return List.of();

    String dbName = currentDatabaseName();
    if (dbName == null) return List.of();

    List<Map<String, Object>> rows = queryColumnRows(dbName, allowed);
    Map<String, StructuredTable> map = new LinkedHashMap<>();
    for (Map<String, Object> row : rows) {
      String tableName = (String) row.get("TABLE_NAME");
      StructuredTable table =
          map.computeIfAbsent(
              tableName,
              name ->
                  new StructuredTable(
                      name,
                      stringOrDefault(row.get("TABLE_COMMENT"), name),
                      uploaded.contains(name),
                      new ArrayList<>()));
      table
          .fields()
          .add(
              new StructuredField(
                  (String) row.get("COLUMN_NAME"),
                  (String) row.get("COLUMN_TYPE"),
                  stringOrDefault(row.get("COLUMN_COMMENT"), "")));
    }
    return new ArrayList<>(map.values());
  }

  private boolean isInternalDs(Long datasourceId) {
    if (datasourceId == null) return true;
    List<Map<String, Object>> rows =
        jdbc.queryForList("SELECT is_local FROM data_source WHERE id = ?", datasourceId);
    if (rows.isEmpty()) return true;
    return JdbcScalars.isTruthy(rows.get(0).get("is_local"));
  }

  private String fetchSchemaPromptFromLocal(List<String> allowed, List<String> uploaded) {
    String dbName = currentDatabaseName();
    if (dbName == null) return "无法获取目标数据库名称。";

    List<Map<String, Object>> rows = queryColumnRows(dbName, allowed);
    return formatSchemaRows(rows, uploaded);
  }

  private String currentDatabaseName() {
    List<String> names = jdbc.queryForList("SELECT DATABASE()", String.class);
    return names.isEmpty() ? null : names.get(0);
  }

  private List<Map<String, Object>> queryColumnRows(String dbName, List<String> allowedTables) {
    String placeholders = String.join(", ", Collections.nCopies(allowedTables.size(), "?"));
    String sql =
        """
				SELECT
					c.TABLE_NAME,
					t.TABLE_COMMENT,
					c.COLUMN_NAME,
					c.COLUMN_TYPE,
					c.COLUMN_COMMENT
				FROM information_schema.COLUMNS c
				JOIN information_schema.TABLES t
				  ON c.TABLE_NAME = t.TABLE_NAME AND c.TABLE_SCHEMA = t.TABLE_SCHEMA
				WHERE c.TABLE_SCHEMA = ?
				  AND c.TABLE_NAME IN (%s)
				ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
				"""
            .formatted(placeholders);

    Object[] params = new Object[allowedTables.size() + 1];
    params[0] = dbName;
    for (int i = 0; i < allowedTables.size(); i++) {
      params[i + 1] = allowedTables.get(i);
    }
    return jdbc.queryForList(sql, params);
  }

  private List<String> getUserUploadedTableNames(Long datasourceId, long userId) {
    Long actualId = datasourceId != null ? datasourceId : getLocalDatasourceId();
    if (actualId == null) return List.of();
    return jdbc.queryForList(
        "SELECT table_name FROM uploaded_table WHERE datasource_id = ?", String.class, actualId);
  }

  private Long getLocalDatasourceId() {
    List<Long> ids =
        jdbc.queryForList("SELECT id FROM data_source WHERE is_local = 1 LIMIT 1", Long.class);
    return ids.isEmpty() ? null : ids.get(0);
  }

  private String formatSchemaRows(List<Map<String, Object>> rows, List<String> uploadedTableNames) {
    if (rows == null || rows.isEmpty()) return "当前数据库中没有可用的业务表。";

    Map<String, TableInfo> map = new LinkedHashMap<>();
    for (Map<String, Object> row : rows) {
      String tableName = (String) row.get("TABLE_NAME");
      TableInfo info =
          map.computeIfAbsent(
              tableName,
              name ->
                  new TableInfo(
                      stringOrDefault(row.get("TABLE_COMMENT"), ""),
                      uploadedTableNames.contains(name),
                      new ArrayList<>()));
      info.columns()
          .add(
              "  %s %s -- %s"
                  .formatted(
                      row.get("COLUMN_NAME"),
                      row.get("COLUMN_TYPE"),
                      stringOrDefault(row.get("COLUMN_COMMENT"), "")));
    }

    return map.entrySet().stream()
        .map(
            e -> {
              String label = e.getValue().isUploaded() ? " [用户上传]" : "";
              return "表名: "
                  + e.getKey()
                  + label
                  + "\n"
                  + "说明: "
                  + e.getValue().comment()
                  + "\n"
                  + "字段:\n"
                  + String.join("\n", e.getValue().columns())
                  + "\n";
            })
        .collect(Collectors.joining("\n"))
        .trim();
  }

  private static List<String> merge(List<String> a, List<String> b) {
    List<String> out = new ArrayList<>(a.size() + b.size());
    out.addAll(a);
    out.addAll(b);
    return out;
  }

  private static String cacheKey(Long datasourceId, long userId) {
    return (datasourceId == null ? "local" : datasourceId.toString()) + "_" + userId;
  }

  private static String stringOrDefault(Object value, String fallback) {
    if (value == null) return fallback;
    String s = value.toString();
    return s.isEmpty() ? fallback : s;
  }

  private record CacheEntry(String prompt, Instant createdAt) {}

  private record TableInfo(String comment, boolean isUploaded, List<String> columns) {}

  public record StructuredTable(
      String tableName,
      @JsonProperty("display_name") String displayName,
      boolean isUploaded,
      List<StructuredField> fields) {}

  public record StructuredField(String name, String type, String comment) {}
}
