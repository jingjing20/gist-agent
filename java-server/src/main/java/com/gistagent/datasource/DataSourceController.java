package com.gistagent.datasource;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gistagent.auth.AuthenticatedUser;
import com.gistagent.common.ApiException;
import com.gistagent.database.SchemaService;
import com.gistagent.datasource.dto.ColumnSpec;
import com.gistagent.datasource.dto.CreateDataSourceRequest;
import com.gistagent.datasource.dto.GrantRequest;
import com.gistagent.datasource.dto.UpdateDataSourceRequest;
import com.opencsv.CSVReader;
import com.opencsv.exceptions.CsvValidationException;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.DateUtil;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.usermodel.WorkbookFactory;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * File upload parsing (CSV / XLSX) lives here to mirror the Nest controller boundary. The service
 * layer is kept ignorant of parsing libraries so it can be reused by future programmatic callers.
 */
@RestController
@RequestMapping("/datasources")
public class DataSourceController {

  private static final int MAX_FILE_ROWS = 50_000;

  private final DataSourceService datasourceService;
  private final SuggestionService suggestionService;
  private final SchemaService schemaService;
  private final ObjectMapper mapper;

  public DataSourceController(
      DataSourceService datasourceService,
      SuggestionService suggestionService,
      SchemaService schemaService,
      ObjectMapper mapper) {
    this.datasourceService = datasourceService;
    this.suggestionService = suggestionService;
    this.schemaService = schemaService;
    this.mapper = mapper;
  }

  @GetMapping
  public List<Map<String, Object>> findAll(@AuthenticationPrincipal AuthenticatedUser user) {
    return datasourceService.findAllForUser(user.id());
  }

  @GetMapping("/{id}/tables")
  public List<Map<String, Object>> listTables(
      @AuthenticationPrincipal AuthenticatedUser user, @PathVariable long id) {
    return datasourceService.listUploadedTables(id, user.id());
  }

  @PostMapping("/{id}/tables")
  public List<Map<String, Object>> uploadTable(
      @AuthenticationPrincipal AuthenticatedUser user,
      @PathVariable("id") long datasourceId,
      @RequestParam("file") MultipartFile file,
      @RequestParam("tableConfigs") String tableConfigsStr) {
    if (file == null || file.isEmpty()) throw ApiException.badRequest("请上传文件");
    if (tableConfigsStr == null || tableConfigsStr.isBlank()) {
      throw ApiException.badRequest("缺失表配置信息");
    }

    List<TableConfig> tableConfigs;
    try {
      tableConfigs = mapper.readValue(tableConfigsStr, new TypeReference<>() {});
    } catch (Exception e) {
      throw ApiException.badRequest("表配置格式错误");
    }
    if (tableConfigs == null || tableConfigs.isEmpty()) {
      throw ApiException.badRequest("请选择至少一个要上传的表");
    }

    String originalName = file.getOriginalFilename();
    String ext = extractExtension(originalName);

    Workbook workbook = null;
    try {
      if ("xlsx".equals(ext) || "xls".equals(ext)) {
        try (InputStream in = file.getInputStream()) {
          workbook = WorkbookFactory.create(in);
        } catch (Exception e) {
          throw ApiException.badRequest("Excel 文件解析失败: " + e.getMessage());
        }
      }

      List<Map<String, Object>> results = new ArrayList<>();
      for (TableConfig config : tableConfigs) {
        String displayName = config.displayName == null ? "" : config.displayName.trim();
        if (displayName.isEmpty()) continue;

        List<Map<String, Object>> rawRows;
        if ("csv".equals(ext)) {
          rawRows = readCsv(file);
        } else if (workbook != null) {
          String sheetName =
              (config.sheetName == null || config.sheetName.isBlank())
                  ? workbook.getSheetName(0)
                  : config.sheetName;
          Sheet sheet = workbook.getSheet(sheetName);
          if (sheet == null) continue;
          rawRows = readSheet(sheet, sheetName);
        } else {
          throw ApiException.badRequest("不支持的文件类型: " + ext);
        }

        if (rawRows.isEmpty()) continue;

        List<String> colNames = new ArrayList<>(rawRows.get(0).keySet());
        List<Map<String, Object>> normalizedRows = new ArrayList<>(rawRows.size());
        for (Map<String, Object> row : rawRows) {
          Map<String, Object> out = new LinkedHashMap<>();
          for (String key : colNames) out.put(key, FileParsingUtil.normalizeValue(row.get(key)));
          normalizedRows.add(out);
        }

        List<String> uniqueNames = FileParsingUtil.ensureUniqueColumnNames(colNames);
        List<ColumnSpec> columns = new ArrayList<>(colNames.size());
        for (int i = 0; i < colNames.size(); i++) {
          String orig = colNames.get(i);
          List<Object> colValues = new ArrayList<>(normalizedRows.size());
          for (Map<String, Object> r : normalizedRows) colValues.add(r.get(orig));
          columns.add(
              new ColumnSpec(uniqueNames.get(i), orig, FileParsingUtil.inferMysqlType(colValues)));
        }

        List<Map<String, Object>> cleanRows = new ArrayList<>(normalizedRows.size());
        for (Map<String, Object> row : normalizedRows) {
          Map<String, Object> cleaned = new LinkedHashMap<>();
          for (int i = 0; i < colNames.size(); i++) {
            ColumnSpec c = columns.get(i);
            cleaned.put(c.name(), FileParsingUtil.coerce(row.get(colNames.get(i)), c.type()));
          }
          cleanRows.add(cleaned);
        }

        Map<String, Object> result =
            datasourceService.uploadTable(datasourceId, user.id(), displayName, columns, cleanRows);
        results.add(result);
      }

      if (!results.isEmpty()) {
        suggestionService.invalidateAndRegenerate(datasourceId, user.id());
      }
      return results;
    } finally {
      if (workbook != null) {
        try {
          workbook.close();
        } catch (IOException ignored) {
        }
      }
    }
  }

  private List<Map<String, Object>> readCsv(MultipartFile file) {
    List<Map<String, Object>> rows = new ArrayList<>();
    try (InputStream in = file.getInputStream();
        BufferedReader reader =
            new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        CSVReader csv = new CSVReader(reader)) {
      String[] headers = csv.readNext();
      if (headers == null) return rows;
      String[] record;
      while ((record = csv.readNext()) != null) {
        Map<String, Object> row = new LinkedHashMap<>();
        for (int i = 0; i < headers.length; i++) {
          row.put(headers[i], i < record.length ? record[i] : null);
        }
        rows.add(row);
        if (rows.size() > MAX_FILE_ROWS) {
          throw ApiException.badRequest("文件行数超过上限 " + MAX_FILE_ROWS + " 行");
        }
      }
      return rows;
    } catch (IOException | CsvValidationException e) {
      throw ApiException.badRequest("CSV 解析失败: " + e.getMessage());
    }
  }

  /**
   * Mirrors xlsx.sheet_to_json with {defval: null, raw: true}: - first row is header - each cell
   * keeps its native type (number stays number, date becomes epoch-ish), empty cell becomes null
   */
  private List<Map<String, Object>> readSheet(Sheet sheet, String sheetName) {
    int lastRow = sheet.getLastRowNum();
    if (lastRow < 1) return new ArrayList<>();

    Row headerRow = sheet.getRow(sheet.getFirstRowNum());
    if (headerRow == null) return new ArrayList<>();
    int lastCol = headerRow.getLastCellNum();
    List<String> headers = new ArrayList<>(lastCol);
    for (int c = 0; c < lastCol; c++) {
      Cell cell = headerRow.getCell(c);
      headers.add(cell == null ? "" : cell.toString());
    }

    List<Map<String, Object>> rows = new ArrayList<>();
    for (int r = sheet.getFirstRowNum() + 1; r <= lastRow; r++) {
      Row row = sheet.getRow(r);
      if (row == null) continue;
      Map<String, Object> obj = new LinkedHashMap<>();
      boolean anyValue = false;
      for (int c = 0; c < headers.size(); c++) {
        Cell cell = row.getCell(c);
        Object v = readCell(cell);
        if (v != null) anyValue = true;
        obj.put(headers.get(c), v);
      }
      if (!anyValue) continue;
      rows.add(obj);
      if (rows.size() > MAX_FILE_ROWS) {
        throw ApiException.badRequest("Sheet「" + sheetName + "」行数超过上限 " + MAX_FILE_ROWS + " 行");
      }
    }
    return rows;
  }

  private Object readCell(Cell cell) {
    if (cell == null) return null;
    return switch (cell.getCellType()) {
      case BLANK -> null;
      case BOOLEAN -> cell.getBooleanCellValue();
      case NUMERIC -> {
        if (DateUtil.isCellDateFormatted(cell)) {
          yield cell.getDateCellValue().toInstant().toString();
        }
        double d = cell.getNumericCellValue();
        if (d == Math.floor(d) && !Double.isInfinite(d)) {
          yield (long) d;
        }
        yield d;
      }
      case STRING -> cell.getStringCellValue();
      case FORMULA -> {
        try {
          yield cell.getNumericCellValue();
        } catch (Exception e) {
          try {
            yield cell.getStringCellValue();
          } catch (Exception ex) {
            yield null;
          }
        }
      }
      default -> null;
    };
  }

  @DeleteMapping("/{id}/tables/{tableId}")
  public Map<String, Boolean> deleteTable(
      @AuthenticationPrincipal AuthenticatedUser user, @PathVariable("tableId") long tableId) {
    long dsId = datasourceService.deleteUploadedTable(tableId, user.id());
    suggestionService.invalidateAndRegenerate(dsId, user.id());
    return Map.of("ok", true);
  }

  @GetMapping("/{id}/suggestions")
  public Map<String, Object> getSuggestions(
      @AuthenticationPrincipal AuthenticatedUser user, @PathVariable long id) {
    List<String> questions = suggestionService.getSuggestions(id, user.id());
    return Map.of("questions", questions);
  }

  @GetMapping("/{id}/schema")
  public List<SchemaService.StructuredTable> getSchema(
      @AuthenticationPrincipal AuthenticatedUser user, @PathVariable long id) {
    return schemaService.getStructuredSchema(id, user.id());
  }

  @GetMapping("/{id}")
  public Map<String, Object> findOne(
      @AuthenticationPrincipal AuthenticatedUser user, @PathVariable long id) {
    return datasourceService.findOne(id, user.id());
  }

  @PostMapping
  public Map<String, Object> create(
      @AuthenticationPrincipal AuthenticatedUser user, @RequestBody CreateDataSourceRequest body) {
    if (body == null || body.name() == null || body.name().trim().isEmpty()) {
      throw ApiException.badRequest("请提供数据源名称");
    }
    return datasourceService.create(user.id(), body);
  }

  @PostMapping("/{id}/grant")
  public Map<String, Boolean> grant(
      @AuthenticationPrincipal AuthenticatedUser user,
      @PathVariable long id,
      @RequestBody GrantRequest body) {
    if (body == null || body.userId() == null) throw ApiException.badRequest("请提供 userId");
    datasourceService.grant(id, body.userId(), user.id());
    return Map.of("ok", true);
  }

  @PostMapping("/{id}/revoke")
  public Map<String, Boolean> revoke(
      @AuthenticationPrincipal AuthenticatedUser user,
      @PathVariable long id,
      @RequestBody GrantRequest body) {
    if (body == null || body.userId() == null) throw ApiException.badRequest("请提供 userId");
    datasourceService.revoke(id, body.userId(), user.id());
    return Map.of("ok", true);
  }

  @GetMapping("/{id}/permissions")
  public List<Map<String, Object>> listPermissions(
      @AuthenticationPrincipal AuthenticatedUser user, @PathVariable long id) {
    return datasourceService.listPermissionUsers(id, user.id());
  }

  @PatchMapping("/{id}")
  public Map<String, Object> update(
      @AuthenticationPrincipal AuthenticatedUser user,
      @PathVariable long id,
      @RequestBody UpdateDataSourceRequest body) {
    if (body != null && body.name() != null && body.name().trim().isEmpty()) {
      throw ApiException.badRequest("数据源名称不能为空");
    }
    return datasourceService.update(
        id, user.id(), body == null ? new UpdateDataSourceRequest(null, null) : body);
  }

  @DeleteMapping("/{id}")
  public void remove(@AuthenticationPrincipal AuthenticatedUser user, @PathVariable long id) {
    datasourceService.remove(id, user.id());
  }

  private static String extractExtension(String filename) {
    if (filename == null) return "";
    int dot = filename.lastIndexOf('.');
    if (dot < 0 || dot == filename.length() - 1) return "";
    return filename.substring(dot + 1).toLowerCase(Locale.ROOT);
  }

  /** Minimal echo of the Nest body shape: { sheetName?: string; displayName: string } */
  public static final class TableConfig {
    public String sheetName;
    public String displayName;
  }
}
