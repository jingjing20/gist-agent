package com.gistagent.chat.tools;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.gistagent.chat.SseEvent;
import com.openai.models.chat.completions.ChatCompletionTool;

import org.springframework.stereotype.Component;

/**
 * generate_chart：在 analyze_result 判断需要图表后调用。
 * 把结构化图表数据以 {@code type=chart} 的 SSE 事件下发给前端。
 */
@Component
public class GenerateChartTool implements Tool {

	private static final String NAME = "generate_chart";

	private final ChatCompletionTool definition = ToolDefinitions.functionTool(
			NAME,
			"仅在 analyze_result 返回 needsChart=true 后调用。提供完整的图表数据，样式由前端统一处理。",
			Map.of(
					"type", "object",
					"properties", Map.of(
							"chartType", Map.of(
									"type", "string",
									"enum", List.of("line", "bar", "pie", "scatter", "radar", "funnel"),
									"description", "图表类型，与 analyze_result 中声明的一致"
							),
							"title", Map.of(
									"type", "string",
									"description", "图表标题，与 analyze_result 中声明的一致"
							),
							"xAxis", Map.of(
									"type", "array",
									"items", Map.of("type", "string"),
									"description", "各数据点的标签；bar/line/scatter 为 X 轴分类，pie/funnel 为各扇区名称，radar 为多维指标名称（必填，长度需对应数据）"
							),
							"series", Map.of(
									"type", "array",
									"description", "数据系列",
									"items", Map.of(
											"type", "object",
											"properties", Map.of(
													"name", Map.of("type", "string", "description", "系列名称"),
													"data", Map.of(
															"type", "array",
															"items", Map.of("type", "number"),
															"description", "数值数组，与 xAxis 一一对应"
													)
											),
											"required", List.of("name", "data")
									)
							)
					),
					"required", List.of("chartType", "title", "series")
			)
	);

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
		Map<String, Object> chartData = new LinkedHashMap<>();
		chartData.put("chartType", args.get("chartType"));
		chartData.put("title", args.get("title"));
		chartData.put("xAxis", args.get("xAxis"));
		chartData.put("series", args.get("series"));

		SseEvent event = SseEvent.of("chart").with("chartData", chartData);
		ctx.emitter().send(event);

		return ToolExecutionResult.builder("图表已成功渲染到用户界面。")
				.block(event)
				.build();
	}
}
