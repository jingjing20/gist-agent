package com.gistagent.chat.tools;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.openai.models.chat.completions.ChatCompletionTool;

import org.springframework.stereotype.Component;

/**
 * Tool 注册表：收集 Spring 容器中所有 {@link Tool} Bean，提供按名查找和面向
 * LLM 的 tool definitions 列表。新增工具只需实现接口并 {@code @Component} 即可。
 */
@Component
public class ToolRegistry {

	private final Map<String, Tool> tools = new LinkedHashMap<>();

	public ToolRegistry(List<Tool> tools) {
		for (Tool tool : tools) {
			this.tools.put(tool.name(), tool);
		}
	}

	public Tool get(String name) {
		return tools.get(name);
	}

	public List<ChatCompletionTool> getDefinitions() {
		return tools.values().stream().map(Tool::definition).toList();
	}
}
