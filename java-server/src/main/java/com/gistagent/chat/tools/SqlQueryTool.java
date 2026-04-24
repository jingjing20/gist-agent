package com.gistagent.chat.tools;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gistagent.chat.SseEvent;
import com.gistagent.chat.agents.SqlExecutorAgent;
import com.openai.models.chat.completions.ChatCompletionTool;

import org.springframework.stereotype.Component;

/**
 * execute_sql_query：读取数据的唯一入口。
 *
 * 落到 {@link SqlExecutorAgent} 做 AST 校验、LIMIT 注入、超时和小模型自愈，
 * 本工具只负责：日志事件、结果事件、结果体积超限时的就地截断。
 */
@Component
public class SqlQueryTool implements Tool {

	private static final String NAME = "execute_sql_query";
	private static final int MAX_TOOL_RESULT_CHARS = 60000;

	private final ChatCompletionTool definition = ToolDefinitions.functionTool(
			NAME,
			"执行 SELECT 语句读取数据。",
			Map.of(
					"type", "object",
					"properties", Map.of(
							"sql", Map.of(
									"type", "string",
									"description", "安全的只读 MySQL 查询语句"
							)
					),
					"required", List.of("sql")
			)
	);

	private final SqlExecutorAgent executor;
	private final ObjectMapper mapper;

	public SqlQueryTool(SqlExecutorAgent executor, ObjectMapper mapper) {
		this.executor = executor;
		this.mapper = mapper;
	}

	@Override
	public String name() {
		return NAME;
	}

	@Override
	public ChatCompletionTool definition() {
		return definition;
	}

	@Override
	public ToolExecutionResult execute(Map<String, Object> args, ToolContext ctx) {
		String sql = args.get("sql") == null ? "" : args.get("sql").toString();
		List<SseEvent> blocks = new ArrayList<>();

		SseEvent execLog = SseEvent.of("log")
				.with("title", "[数据查询]")
				.with("content", "正在从数据库提取并处理结果...");
		ctx.emitter().send(execLog);
		blocks.add(execLog);

		// 给前端一个可感知的“思考时间”，否则快的查询瞬间闪过不利于用户理解
		sleepQuietly(1000);

		try {
			SqlExecutorAgent.QueryResult r = executor.execute(sql, ctx.datasourceId(),
					ctx.userId() == null ? 0L : ctx.userId());

			if (r.wasFixed()) {
				SseEvent fixLog = SseEvent.of("log")
						.with("title", "[防腐层自动修复]")
						.with("content", "检测到语法错误已由内部子模型修复。\n修复前：" + sql
								+ "\n\n修复后：" + r.finalSql());
				ctx.emitter().send(fixLog);
				blocks.add(fixLog);
			}

			execLog.with("content", "查询成功，共读取 " + r.rowCount() + " 条数据");
			ctx.emitter().send(execLog.asType("log_update"));

			SseEvent tableEvent = SseEvent.of("table")
					.with("columns", r.columns())
					.with("rows", r.rows())
					.with("rowCount", r.rowCount());
			ctx.emitter().send(tableEvent);
			blocks.add(tableEvent);

			String toolResult = buildToolResult(r, sql);
			return ToolExecutionResult.of(toolResult, blocks);
		} catch (Exception e) {
			execLog.with("content", "查询失败: " + e.getMessage());
			ctx.emitter().send(execLog.asType("log_update"));
			return ToolExecutionResult.of("SQL 执行出错: " + e.getMessage(), blocks);
		}
	}

	/**
	 * 构造回填给 LLM 的 tool 消息内容：体积超限时就地截断并注入 systemMessage。
	 * 截断策略：按平均行字节估算可容纳条数，保留前 N 行。相比 Nest 版，直接用
	 * Jackson 序列化再做字节估算，避免多次重复序列化。
	 */
	private String buildToolResult(SqlExecutorAgent.QueryResult r, String originalSql) {
		List<Map<String, Object>> rows = r.rows();
		String serialized = safeSerialize(rows);
		String truncationNote = "";

		if (serialized.length() > MAX_TOOL_RESULT_CHARS && rows.size() > 1) {
			double avg = (double) serialized.length() / rows.size();
			int fit = Math.max(1, (int) Math.floor(MAX_TOOL_RESULT_CHARS / avg));
			rows = rows.subList(0, fit);
			truncationNote = "\n[注意：完整查询共 " + r.rowCount()
					+ " 条，因数据体积超限仅提供前 " + fit + " 条用于分析，请在结论中注明数据未完整展示。]";
		}

		boolean hasFixNote = r.wasFixed();
		if (!hasFixNote && truncationNote.isEmpty()) {
			return safeSerialize(rows);
		}

		Map<String, Object> wrapper = new LinkedHashMap<>();
		if (hasFixNote) {
			wrapper.put("systemMessage",
					"注意：由于你写的原始 SQL 存在特定语法错误，已被系统防腐代理自动拦截修复！"
							+ "最终成功执行的 SQL 为: " + r.finalSql() + "。请在最终结论中以此为准。"
							+ truncationNote);
		} else {
			wrapper.put("systemMessage", truncationNote.trim());
		}
		wrapper.put("data", rows);
		return safeSerialize(wrapper);
	}

	private String safeSerialize(Object value) {
		try {
			return mapper.writeValueAsString(value);
		} catch (JsonProcessingException e) {
			return "[]";
		}
	}

	private static void sleepQuietly(long ms) {
		try {
			Thread.sleep(ms);
		} catch (InterruptedException ignored) {
			Thread.currentThread().interrupt();
		}
	}
}
