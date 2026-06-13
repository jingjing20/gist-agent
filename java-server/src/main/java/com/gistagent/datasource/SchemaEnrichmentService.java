package com.gistagent.datasource;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.gistagent.llm.LlmService;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

/**
 * Port of the Nest SchemaEnrichmentService.
 *
 * <p>Runs best-effort: fires after a new table is uploaded, calls the LLM with a handful of sample
 * rows + existing column metadata, then writes the LLM-suggested comments back via ALTER TABLE.
 * Failures are logged; they must never fail the upload pipeline itself.
 */
@Service
public class SchemaEnrichmentService {

  private static final Logger log = LoggerFactory.getLogger(SchemaEnrichmentService.class);
  private static final Pattern JSON_ARRAY = Pattern.compile("\\[[\\s\\S]*\\]");
  private static final int COMMENT_MAX_LEN = 1000;

  private final JdbcTemplate jdbc;
  private final LlmService llm;
  private final ObjectMapper mapper;

  public SchemaEnrichmentService(JdbcTemplate jdbc, LlmService llm, ObjectMapper mapper) {
    this.jdbc = jdbc;
    this.llm = llm;
    this.mapper = mapper;
  }

  @Async
  public void enrichTableSchemaAsync(String tableName) {
    try {
      enrichTableSchema(tableName);
    } catch (Exception e) {
      log.warn("Failed to enrich schema for table [{}]: {}", tableName, e.getMessage());
    }
  }

  private void enrichTableSchema(String tableName) throws Exception {
    List<Map<String, Object>> cols =
        jdbc.queryForList(
            "SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT "
                + "FROM information_schema.COLUMNS "
                + "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? "
                + "ORDER BY ORDINAL_POSITION",
            tableName);
    if (cols.isEmpty()) return;

    List<Map<String, Object>> samples =
        jdbc.queryForList("SELECT * FROM `" + tableName + "` LIMIT 5");
    if (samples.isEmpty()) return;

    String systemPrompt =
        """
				你是一个资深的数据架构师。你的任务是根据给定的表结构和真实数据样本，推导并增强各个字段的业务注释。
				要求：
				- 注意推导分类字段的可能取值、时间字段的格式、数字字段的可能业务含义（例如金额单位、数量等）。
				- 结合原有注释、字段名和数据样例，给出一个精炼且带更多语义信息的注释（适合未来给大模型生成 SQL 时参考阅读）。
				- 只返回严格的 JSON 数组，格式必须为 [{"column": "原字段名", "comment": "丰富增强后的注释(如果原注释好则保留+补充)"}]。
				- 没有解释，只有 JSON。""";

    StringBuilder cols4Prompt = new StringBuilder();
    for (Map<String, Object> c : cols) {
      cols4Prompt
          .append("- ")
          .append(c.get("COLUMN_NAME"))
          .append(" (")
          .append(c.get("COLUMN_TYPE"))
          .append("): ")
          .append(c.get("COLUMN_COMMENT") == null ? "" : c.get("COLUMN_COMMENT"))
          .append('\n');
    }
    String userPrompt =
        "表（"
            + tableName
            + "）结构：\n"
            + cols4Prompt
            + "\n前 5 条真实数据样本：\n"
            + mapper.writerWithDefaultPrettyPrinter().writeValueAsString(samples);

    String response = llm.chat(systemPrompt, userPrompt, 0);
    Matcher m = JSON_ARRAY.matcher(response);
    if (!m.find()) throw new IllegalStateException("LLM did not return a JSON array");

    List<Map<String, Object>> enrichments =
        mapper.readValue(
            m.group(), mapper.getTypeFactory().constructCollectionType(List.class, Map.class));

    for (Map<String, Object> e : enrichments) {
      String colName = (String) e.get("column");
      Object rawComment = e.get("comment");
      if (colName == null || rawComment == null) continue;

      Map<String, Object> col =
          cols.stream().filter(c -> colName.equals(c.get("COLUMN_NAME"))).findFirst().orElse(null);
      if (col == null) continue;

      String newComment = String.valueOf(rawComment);
      if (newComment.length() > COMMENT_MAX_LEN) {
        newComment = newComment.substring(0, COMMENT_MAX_LEN);
      }
      String escaped = FileParsingUtil.escapeSingleQuote(newComment);
      String sql =
          "ALTER TABLE `"
              + tableName
              + "` MODIFY `"
              + col.get("COLUMN_NAME")
              + "` "
              + col.get("COLUMN_TYPE")
              + " COMMENT '"
              + escaped
              + "'";
      jdbc.execute(sql);
    }

    log.info("Table [{}] schema enrichment completed successfully.", tableName);
  }
}
