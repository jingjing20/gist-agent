package com.gistagent.chat.agents;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import javax.sql.DataSource;

import com.gistagent.database.SchemaService;
import com.gistagent.llm.LlmService;

import net.sf.jsqlparser.JSQLParserException;
import net.sf.jsqlparser.expression.LongValue;
import net.sf.jsqlparser.parser.CCJSqlParserUtil;
import net.sf.jsqlparser.statement.DescribeStatement;
import net.sf.jsqlparser.statement.ExplainStatement;
import net.sf.jsqlparser.statement.ShowColumnsStatement;
import net.sf.jsqlparser.statement.ShowStatement;
import net.sf.jsqlparser.statement.select.Limit;
import net.sf.jsqlparser.statement.select.Select;
import net.sf.jsqlparser.statement.show.ShowTablesStatement;
import net.sf.jsqlparser.util.TablesNamesFinder;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * 安全 SQL 执行器（对齐 Nest 版 sql-executor.ts）。
 *
 * 三条防线：
 * 1. AST 白名单校验：只放行 SELECT / SHOW / DESCRIBE / EXPLAIN。
 * 2. LIMIT 强制注入：裸 SELECT 自动追加 LIMIT 1000，防止前端爆内存。
 * 3. 查询超时：{@code Statement.setQueryTimeout(15)} 走 JDBC 内建机制。
 *
 * 自愈：针对纯“语法层”MySQL 错误（1064/1055/1140/1052/1066）走小模型修复重试，
 * 最多 2 次。语义错误（1146 表不存在、1054 字段不存在）直接上抛——强行修复会
 * 让模型凭空编造字段。
 */
@Service
public class SqlExecutorAgent {

	private static final Logger log = LoggerFactory.getLogger(SqlExecutorAgent.class);

	private static final int MAX_ROWS = 1000;
	private static final int QUERY_TIMEOUT_SECONDS = 15;
	private static final int MAX_FIX_RETRIES = 2;

	/** MySQL 纯语法错误代码集合，其他错误（1146/1054 等）不允许小模型胡乱修复。 */
	private static final Set<Integer> SYNTAX_ERROR_CODES = Set.of(
			1064, // ER_PARSE_ERROR
			1055, // ER_WRONG_FIELD_WITH_GROUP (ONLY_FULL_GROUP_BY)
			1140, // ER_MIX_OF_GROUP_FUNC_AND_FIELDS
			1052, // ER_NON_UNIQ_ERROR 列歧义
			1066  // ER_NONUNIQ_TABLE
	);

	private static final Pattern SHOW_TABLES_PATTERN =
			Pattern.compile("^\\s*SHOW\\s+(FULL\\s+)?TABLES", Pattern.CASE_INSENSITIVE);

	private final DataSource dataSource;
	private final LlmService llm;
	private final SchemaService schemaService;

	public SqlExecutorAgent(DataSource dataSource, LlmService llm, SchemaService schemaService) {
		this.dataSource = dataSource;
		this.llm = llm;
		this.schemaService = schemaService;
	}

	public record QueryResult(
			String finalSql,
			boolean wasFixed,
			List<String> columns,
			List<Map<String, Object>> rows,
			int rowCount
	) {}

	public QueryResult execute(String sql, Long datasourceId, long userId) throws SQLException {
		List<String> allowedTables = schemaService.getAllowedTableNames(datasourceId, userId);
		// 空列表代表该数据源下用户根本没有可访问的表，保留 null 语义表示“不约束”以兼容 admin
		Set<String> allowed = allowedTables.isEmpty() ? null : toLowerSet(allowedTables);

		String currentSql = sql;
		SQLException lastError = null;

		for (int attempt = 0; attempt <= MAX_FIX_RETRIES; attempt++) {
			try {
				String safeSql = validateAndPatch(currentSql, allowed);
				List<Map<String, Object>> rows = runQuery(safeSql);

				if (allowed != null && SHOW_TABLES_PATTERN.matcher(safeSql).find()) {
					rows = filterShowTablesRows(rows, allowed);
				}

				List<String> columns = rows.isEmpty() ? List.of() : new ArrayList<>(rows.get(0).keySet());
				return new QueryResult(
						safeSql,
						!currentSql.equals(sql),
						columns,
						rows,
						rows.size()
				);
			} catch (SyntaxError e) {
				// AST 解析失败：包装成 1064 走修复路径
				lastError = new SQLException(e.getMessage(), "42000", 1064);
			} catch (SecurityException e) {
				// 安全阻断：直接上抛，让 LLM 感知
				throw new SQLException(e.getMessage());
			} catch (SQLException e) {
				lastError = e;
			}

			if (attempt >= MAX_FIX_RETRIES || !isSyntaxError(lastError)) {
				break;
			}

			log.warn("SQL 语法错误 ({})，启动小模型修复 (第 {} 次)", lastError.getErrorCode(), attempt + 1);
			try {
				currentSql = attemptFixSql(currentSql, lastError.getMessage());
				log.info("小模型修复完成，重试 SQL: {}", currentSql);
			} catch (Exception fixError) {
				log.error("小模型修复 SQL 失败: {}", fixError.getMessage());
				break;
			}
		}

		throw lastError != null ? lastError : new SQLException("SQL 执行失败");
	}

	// --- AST 层 -----------------------------------------------------------

	private String validateAndPatch(String sql, Set<String> allowedTables) throws SyntaxError {
		net.sf.jsqlparser.statement.Statement stmt;
		try {
			stmt = CCJSqlParserUtil.parse(sql);
		} catch (JSQLParserException e) {
			throw new SyntaxError("[AST 解析异常] " + rootMessage(e));
		}

		validateStatementType(stmt);

		if (allowedTables != null) {
			enforceAllowedTables(sql, allowedTables);
		}

		if (stmt instanceof Select select) {
			return injectLimit(select);
		}
		return stmt.toString();
	}

	private void validateStatementType(net.sf.jsqlparser.statement.Statement stmt) {
		if (stmt instanceof Select) return;
		if (stmt instanceof ShowTablesStatement) return;
		if (stmt instanceof ShowStatement) return;
		if (stmt instanceof ShowColumnsStatement) return;
		if (stmt instanceof DescribeStatement) return;
		if (stmt instanceof ExplainStatement) return;

		String type = stmt.getClass().getSimpleName().toLowerCase(Locale.ROOT);
		throw new SecurityException(
				"安全阻断：探测到非法的 [" + type + "] 操作。当前被限制为纯只读探查模式，禁止可能的数据修改或越权操作！"
		);
	}

	private void enforceAllowedTables(String sql, Set<String> allowedTables) {
		Set<String> used;
		try {
			used = TablesNamesFinder.findTables(sql);
		} catch (JSQLParserException e) {
			// 解析失败留给外层的语法错误路径处理
			return;
		}
		for (String t : used) {
			String clean = t.replace("`", "").toLowerCase(Locale.ROOT);
			// 去掉可能的 schema 前缀 db.table
			int dot = clean.lastIndexOf('.');
			if (dot >= 0) clean = clean.substring(dot + 1);
			if (!allowedTables.contains(clean)) {
				throw new SecurityException(
						"安全阻断：探测到越权访问。表 [" + clean + "] 不在当前数据源的允许范围内。"
				);
			}
		}
	}

	private String injectLimit(Select select) {
		if (select.getLimit() == null) {
			Limit limit = new Limit();
			limit.setRowCount(new LongValue(MAX_ROWS));
			select.setLimit(limit);
		}
		return select.toString();
	}

	// --- JDBC 层 ----------------------------------------------------------

	private List<Map<String, Object>> runQuery(String sql) throws SQLException {
		try (Connection conn = dataSource.getConnection();
			 Statement stmt = conn.createStatement()) {
			stmt.setQueryTimeout(QUERY_TIMEOUT_SECONDS);
			stmt.setMaxRows(MAX_ROWS);
			try (ResultSet rs = stmt.executeQuery(sql)) {
				return readAll(rs);
			}
		}
	}

	private List<Map<String, Object>> readAll(ResultSet rs) throws SQLException {
		ResultSetMetaData md = rs.getMetaData();
		int cols = md.getColumnCount();
		List<String> names = new ArrayList<>(cols);
		for (int i = 1; i <= cols; i++) names.add(md.getColumnLabel(i));

		List<Map<String, Object>> rows = new ArrayList<>();
		while (rs.next()) {
			Map<String, Object> row = new LinkedHashMap<>(cols);
			for (int i = 0; i < cols; i++) {
				row.put(names.get(i), rs.getObject(i + 1));
			}
			rows.add(row);
		}
		return rows;
	}

	private List<Map<String, Object>> filterShowTablesRows(List<Map<String, Object>> rows, Set<String> allowed) {
		List<Map<String, Object>> out = new ArrayList<>(rows.size());
		for (Map<String, Object> row : rows) {
			if (row.isEmpty()) continue;
			Object first = row.values().iterator().next();
			if (first instanceof String s && allowed.contains(s.toLowerCase(Locale.ROOT))) {
				out.add(row);
			}
		}
		return out;
	}

	// --- 错误分类 + 自愈 --------------------------------------------------

	private boolean isSyntaxError(SQLException error) {
		if (error == null) return false;
		return SYNTAX_ERROR_CODES.contains(error.getErrorCode());
	}

	private String attemptFixSql(String originalSql, String errorMessage) {
		String systemPrompt =
				"你是一个顶尖的 MySQL 数据分析工程师。你的任务是修复一段报错的 SQL 语句。"
						+ "由于你是在一个自动拦截防腐层内运行，你的上下文中没有完整的数据库 Schema。"
						+ "因此，你 **绝不能** 随意猜测或编造表名、字段名，你只能仅就 SQL 的**语法层面**进行修复"
						+ "（例如修改 GROUP BY、修复标点符号、处理严格模式等）。\n\n"
						+ "你 **必须且只能** 返回修复后的并且可以直接在 MySQL 8.0 运行的纯 SQL 代码。\n"
						+ "不要返回任何 markdown 格式（例如 ```sql），不要加任何解释，不要包含多余的话语。";

		String userPrompt = "原始 SQL:\n" + originalSql + "\n\nMySQL 报错信息:\n" + errorMessage;
		String response = llm.chat(systemPrompt, userPrompt, 0.0);
		// 去掉可能出现的 markdown 包裹
		return response.replaceAll("(?i)```sql", "").replace("```", "").trim();
	}

	private static Set<String> toLowerSet(List<String> values) {
		Set<String> out = new java.util.HashSet<>(values.size());
		for (String v : values) out.add(v.toLowerCase(Locale.ROOT));
		return out;
	}

	private static String rootMessage(Throwable t) {
		Throwable cur = t;
		while (cur.getCause() != null && cur.getCause() != cur) cur = cur.getCause();
		return cur.getMessage() == null ? t.toString() : cur.getMessage();
	}

	/** 内部信号：AST 解析失败，统一走“语法错误 → 小模型修复”通道。 */
	private static final class SyntaxError extends Exception {
		SyntaxError(String msg) { super(msg); }
	}
}
