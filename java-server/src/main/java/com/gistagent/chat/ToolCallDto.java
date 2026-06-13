package com.gistagent.chat;

/** Assistant 发起的单次函数调用。{@code arguments} 始终保留为原始 JSON 字符串， 以便流式拼接和回写 LLM 时保持字节级别一致。 */
public record ToolCallDto(String id, String name, String arguments) {}
