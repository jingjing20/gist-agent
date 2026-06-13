package com.gistagent.chat.tools;

import com.openai.models.chat.completions.ChatCompletionTool;

/**
 * 一个 Agent 可调用的工具。
 *
 * <p>对齐 Nest 版的 {@code base-tool.ts#Tool}：拥有唯一名字、面向 LLM 的定义（JSON schema）， 以及真正干活的 execute
 * 入口。新增工具只需实现该接口并 {@code @Component} 注入即可， {@link ToolRegistry} 会自动收集。
 */
public interface Tool {

  String name();

  ChatCompletionTool definition();

  ToolExecutionResult execute(java.util.Map<String, Object> args, ToolContext ctx) throws Exception;
}
