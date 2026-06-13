package com.gistagent.datasource;

import com.gistagent.common.ApiException;
import com.gistagent.database.SchemaService;
import com.gistagent.datasource.dto.ColumnSpec;
import com.gistagent.datasource.dto.CreateDataSourceRequest;
import com.gistagent.datasource.dto.UpdateDataSourceRequest;
import com.mysql.cj.jdbc.JdbcStatement;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Service;

/**
 * Port of the Nest DataSourceService.
 *
 * <p>Permission model (3 tiers, short-circuited): 1. created_by IS NULL -> public, everyone can
 * read 2. created_by = userId -> owner, full control 3. datasource_permission row present ->
 * granted read access
 *
 * <p>uploadTable() follows the Nest pipeline: 1) CREATE TABLE with inferred column types 2) LOAD
 * DATA LOCAL INFILE using an in-memory TSV stream -> on any failure, fall back to chunked multi-row
 * INSERTs 3) ALTER TABLE to persist display-name / original-column-name comments 4) fire-and-forget
 * schema enrichment + suggestion regeneration
 */
@Service
public class DataSourceService {

  private static final Logger log = LoggerFactory.getLogger(DataSourceService.class);

  private final JdbcTemplate jdbc;
  private final DataSource dataSource;
  private final SchemaService schemaService;
  private final SchemaEnrichmentService schemaEnrichmentService;

  public DataSourceService(
      JdbcTemplate jdbc,
      DataSource dataSource,
      SchemaService schemaService,
      SchemaEnrichmentService schemaEnrichmentService) {
    this.jdbc = jdbc;
    this.dataSource = dataSource;
    this.schemaService = schemaService;
    this.schemaEnrichmentService = schemaEnrichmentService;
  }

  public boolean canAccess(long datasourceId, long userId) {
    Map<String, Object> row =
        queryOne("SELECT created_by FROM data_source WHERE id = ?", datasourceId);
    if (row == null) return false;
    Object createdBy = row.get("created_by");
    if (createdBy == null) return true;
    if (((Number) createdBy).longValue() == userId) return true;
    Integer cnt =
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM datasource_permission WHERE datasource_id = ? AND user_id = ?",
            Integer.class,
            datasourceId,
            userId);
    return cnt != null && cnt > 0;
  }

  public List<Map<String, Object>> findAllForUser(long userId) {
    return jdbc.queryForList(
        "SELECT d.id, d.name, d.is_local, d.created_by, u.name as creator_name, d.description, d.created_at "
            + "FROM data_source d "
            + "LEFT JOIN user u ON d.created_by = u.id "
            + "LEFT JOIN datasource_permission p ON d.id = p.datasource_id AND p.user_id = ? "
            + "WHERE d.created_by IS NULL OR d.created_by = ? OR p.user_id IS NOT NULL "
            + "ORDER BY d.id ASC",
        userId,
        userId);
  }

  public Map<String, Object> findOne(long id, long userId) {
    if (!canAccess(id, userId)) throw ApiException.forbidden("无权访问此数据源");
    Map<String, Object> row =
        queryOne(
            "SELECT id, name, is_local, created_by, description, created_at FROM data_source WHERE id = ?",
            id);
    if (row == null) throw ApiException.notFound("数据源 id=" + id + " 不存在");
    return row;
  }

  public Map<String, Object> create(long userId, CreateDataSourceRequest body) {
    KeyHolder keyHolder = new GeneratedKeyHolder();
    jdbc.update(
        conn -> {
          PreparedStatement ps =
              conn.prepareStatement(
                  "INSERT INTO data_source (name, created_by, description) VALUES (?, ?, ?)",
                  Statement.RETURN_GENERATED_KEYS);
          ps.setString(1, body.name());
          ps.setLong(2, userId);
          if (body.description() == null) ps.setNull(3, java.sql.Types.VARCHAR);
          else ps.setString(3, body.description());
          return ps;
        },
        keyHolder);

    Number key = keyHolder.getKey();
    if (key == null) throw ApiException.internal("数据源创建失败");
    long newId = key.longValue();
    jdbc.update(
        "INSERT INTO datasource_permission (datasource_id, user_id, granted_by) VALUES (?, ?, ?)",
        newId,
        userId,
        null);
    return findOne(newId, userId);
  }

  public Map<String, Object> update(long id, long userId, UpdateDataSourceRequest body) {
    Map<String, Object> ds = findOne(id, userId);
    Object createdBy = ds.get("created_by");
    if (createdBy == null || ((Number) createdBy).longValue() != userId) {
      throw ApiException.forbidden("仅创建人可编辑数据源信息");
    }

    List<String> fields = new ArrayList<>();
    List<Object> values = new ArrayList<>();
    if (body.name() != null) {
      fields.add("name = ?");
      values.add(body.name());
    }
    if (body.description() != null) {
      fields.add("description = ?");
      values.add(body.description());
    }
    if (!fields.isEmpty()) {
      values.add(id);
      jdbc.update(
          "UPDATE data_source SET " + String.join(", ", fields) + " WHERE id = ?",
          values.toArray());
    }
    return findOne(id, userId);
  }

  public void remove(long id, long userId) {
    Map<String, Object> row =
        queryOne("SELECT is_local, created_by FROM data_source WHERE id = ?", id);
    if (row == null) throw ApiException.notFound("数据源 id=" + id + " 不存在");
    Object isLocal = row.get("is_local");
    if (isLocal != null && ((Number) isLocal).intValue() != 0) {
      throw ApiException.badRequest("默认本地库不可删除");
    }
    Object createdBy = row.get("created_by");
    if (createdBy == null || ((Number) createdBy).longValue() != userId) {
      throw ApiException.forbidden("仅创建人可删除");
    }

    List<String> tables =
        jdbc.queryForList(
            "SELECT table_name FROM uploaded_table WHERE datasource_id = ?", String.class, id);
    for (String t : tables) {
      jdbc.execute("DROP TABLE IF EXISTS `" + t + "`");
    }

    jdbc.update("DELETE FROM data_source WHERE id = ?", id);
    schemaService.clearUserCache(id, userId);
  }

  public Map<String, Object> uploadTable(
      long datasourceId,
      long userId,
      String displayName,
      List<ColumnSpec> columns,
      List<Map<String, Object>> rows) {
    Map<String, Object> ds = findOne(datasourceId, userId);
    if (((Number) ds.get("is_local")).intValue() == 1) {
      throw ApiException.forbidden("公共默认数据源不支持上传文件");
    }
    if (columns.isEmpty()) throw ApiException.badRequest("文件不包含有效列");

    for (ColumnSpec col : columns) {
      if (!FileParsingUtil.isSafeColumnName(col.name())) {
        throw ApiException.badRequest("列名 \"" + col.name() + "\" 包含非法字符，仅允许字母、数字、下划线和中文");
      }
    }

    String tableName = "ut_" + System.currentTimeMillis() + "_" + randomSuffix();
    String colDefs =
        columns.stream()
            .map(c -> "`" + c.name() + "` " + c.type())
            .reduce((a, b) -> a + ", " + b)
            .orElseThrow();
    jdbc.execute("CREATE TABLE `" + tableName + "` (" + colDefs + ")");

    try {
      boolean loaded = tryLoadDataLocalInfile(tableName, columns, rows);
      if (!loaded) {
        batchInsert(tableName, columns, rows);
      }

      String displayComment = FileParsingUtil.escapeSingleQuote(displayName);
      jdbc.execute("ALTER TABLE `" + tableName + "` COMMENT = '" + displayComment + "'");
      for (ColumnSpec col : columns) {
        String commentSource = col.originalName() != null ? col.originalName() : col.name();
        String comment = FileParsingUtil.escapeSingleQuote(commentSource);
        jdbc.execute(
            "ALTER TABLE `"
                + tableName
                + "` MODIFY `"
                + col.name()
                + "` "
                + col.type()
                + " COMMENT '"
                + comment
                + "'");
      }

      KeyHolder keyHolder = new GeneratedKeyHolder();
      jdbc.update(
          conn -> {
            PreparedStatement ps =
                conn.prepareStatement(
                    "INSERT INTO uploaded_table (datasource_id, user_id, table_name, display_name) VALUES (?, ?, ?, ?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setLong(1, datasourceId);
            ps.setLong(2, userId);
            ps.setString(3, tableName);
            ps.setString(4, displayName);
            return ps;
          },
          keyHolder);

      schemaService.clearUserCache(datasourceId, userId);
      schemaEnrichmentService.enrichTableSchemaAsync(tableName);

      Number insertedId = keyHolder.getKey();
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("id", insertedId == null ? null : insertedId.longValue());
      out.put("datasource_id", datasourceId);
      out.put("user_id", userId);
      out.put("table_name", tableName);
      out.put("display_name", displayName);
      out.put("created_at", java.time.LocalDateTime.now());
      return out;
    } catch (RuntimeException e) {
      try {
        jdbc.execute("DROP TABLE IF EXISTS `" + tableName + "`");
      } catch (Exception drop) {
        log.warn("failed to drop table {} during rollback: {}", tableName, drop.getMessage());
      }
      throw e;
    }
  }

  /**
   * Try LOAD DATA LOCAL INFILE via mysql-connector-j's JdbcConnection. Some cloud providers strip
   * LOCAL_FILES; returning false tells the caller to fall back to chunked inserts without losing
   * the table we just created.
   */
  private boolean tryLoadDataLocalInfile(
      String tableName, List<ColumnSpec> columns, List<Map<String, Object>> rows) {
    StringBuilder tsv = new StringBuilder();
    for (Map<String, Object> row : rows) {
      boolean first = true;
      for (ColumnSpec c : columns) {
        if (!first) tsv.append('\t');
        first = false;
        Object v = row.get(c.name());
        if (v == null) {
          tsv.append("\\N");
        } else {
          String s = String.valueOf(v).replace("\\", "\\\\").replace("\t", " ").replace("\n", " ");
          tsv.append(s);
        }
      }
      tsv.append('\n');
    }

    String colList = String.join(", ", columns.stream().map(c -> "`" + c.name() + "`").toList());
    String sql =
        "LOAD DATA LOCAL INFILE 'stream' INTO TABLE `"
            + tableName
            + "` FIELDS TERMINATED BY '\\t' LINES TERMINATED BY '\\n' ("
            + colList
            + ")";

    try (Connection raw = dataSource.getConnection();
        Statement stmt = raw.createStatement()) {
      JdbcStatement jdbcStmt = stmt.unwrap(JdbcStatement.class);
      InputStream stream =
          new ByteArrayInputStream(tsv.toString().getBytes(StandardCharsets.UTF_8));
      jdbcStmt.setLocalInfileInputStream(stream);
      try {
        stmt.execute(sql);
      } finally {
        jdbcStmt.setLocalInfileInputStream(null);
      }
      return true;
    } catch (Exception e) {
      log.warn(
          "LOAD DATA LOCAL INFILE failed for {}, falling back to batch insert: {}",
          tableName,
          e.getMessage());
      return false;
    }
  }

  private void batchInsert(
      String tableName, List<ColumnSpec> columns, List<Map<String, Object>> rows) {
    int batchSize = Math.max(1, 60000 / columns.size());
    String colList = String.join(", ", columns.stream().map(c -> "`" + c.name() + "`").toList());
    String placeholders = "(" + String.join(", ", columns.stream().map(c -> "?").toList()) + ")";

    for (int i = 0; i < rows.size(); i += batchSize) {
      int end = Math.min(i + batchSize, rows.size());
      List<Map<String, Object>> batch = rows.subList(i, end);
      if (batch.isEmpty()) continue;

      StringBuilder sql =
          new StringBuilder("INSERT INTO `")
              .append(tableName)
              .append("` (")
              .append(colList)
              .append(") VALUES ");
      for (int r = 0; r < batch.size(); r++) {
        if (r > 0) sql.append(", ");
        sql.append(placeholders);
      }
      Object[] values = new Object[batch.size() * columns.size()];
      int idx = 0;
      for (Map<String, Object> row : batch) {
        for (ColumnSpec c : columns) values[idx++] = row.get(c.name());
      }
      jdbc.update(sql.toString(), values);
    }
  }

  public List<Map<String, Object>> listUploadedTables(long datasourceId, long userId) {
    findOne(datasourceId, userId);
    return jdbc.queryForList(
        "SELECT t.id, t.datasource_id, t.user_id, u.name as uploader_name, t.table_name, t.display_name, t.created_at "
            + "FROM uploaded_table t LEFT JOIN user u ON t.user_id = u.id "
            + "WHERE t.datasource_id = ? ORDER BY t.created_at DESC",
        datasourceId);
  }

  /**
   * @return datasourceId of the owning datasource (used by caller to invalidate suggestion cache);
   *     never returns null — absence throws.
   */
  public long deleteUploadedTable(long tableId, long userId) {
    Map<String, Object> row =
        queryOne(
            "SELECT t.table_name, t.user_id, t.datasource_id, d.created_by as ds_creator_id "
                + "FROM uploaded_table t LEFT JOIN data_source d ON t.datasource_id = d.id "
                + "WHERE t.id = ?",
            tableId);
    if (row == null) throw ApiException.notFound("上传表 id=" + tableId + " 不存在");

    long ownerId = ((Number) row.get("user_id")).longValue();
    Object dsCreator = row.get("ds_creator_id");
    long dsCreatorId = dsCreator == null ? -1 : ((Number) dsCreator).longValue();
    if (ownerId != userId && dsCreatorId != userId) {
      throw ApiException.forbidden("仅数据源创建者或表上传人可删除");
    }

    String tableName = (String) row.get("table_name");
    jdbc.execute("DROP TABLE IF EXISTS `" + tableName + "`");
    jdbc.update("DELETE FROM uploaded_table WHERE id = ?", tableId);
    long datasourceId = ((Number) row.get("datasource_id")).longValue();
    schemaService.clearUserCache(datasourceId, userId);
    return datasourceId;
  }

  public List<String> getUploadedTableNames(long datasourceId) {
    return jdbc.queryForList(
        "SELECT table_name FROM uploaded_table WHERE datasource_id = ?",
        String.class,
        datasourceId);
  }

  public void grant(long datasourceId, long targetUserId, long grantorId) {
    requireOwner(datasourceId, grantorId, "仅创建人可授权");
    jdbc.update(
        "INSERT IGNORE INTO datasource_permission (datasource_id, user_id, granted_by) VALUES (?, ?, ?)",
        datasourceId,
        targetUserId,
        grantorId);
  }

  public void revoke(long datasourceId, long targetUserId, long grantorId) {
    requireOwner(datasourceId, grantorId, "仅创建人可撤销授权");
    jdbc.update(
        "DELETE FROM datasource_permission WHERE datasource_id = ? AND user_id = ?",
        datasourceId,
        targetUserId);
  }

  public List<Map<String, Object>> listPermissionUsers(long datasourceId, long grantorId) {
    requireOwner(datasourceId, grantorId, "仅创建人可查看授权列表");
    return jdbc.queryForList(
        "SELECT u.id, u.email, u.name FROM user u "
            + "INNER JOIN datasource_permission p ON u.id = p.user_id AND p.datasource_id = ? "
            + "ORDER BY u.email",
        datasourceId);
  }

  private void requireOwner(long datasourceId, long grantorId, String forbiddenMsg) {
    Map<String, Object> row =
        queryOne("SELECT created_by FROM data_source WHERE id = ?", datasourceId);
    if (row == null) throw ApiException.notFound("数据源 id=" + datasourceId + " 不存在");
    Object createdBy = row.get("created_by");
    if (createdBy == null || ((Number) createdBy).longValue() != grantorId) {
      throw ApiException.forbidden(forbiddenMsg);
    }
  }

  private Map<String, Object> queryOne(String sql, Object... args) {
    List<Map<String, Object>> rows = jdbc.queryForList(sql, args);
    return rows.isEmpty() ? null : rows.get(0);
  }

  private static String randomSuffix() {
    return Long.toString(Math.round(Math.random() * Long.MAX_VALUE), 36).substring(0, 6);
  }
}
