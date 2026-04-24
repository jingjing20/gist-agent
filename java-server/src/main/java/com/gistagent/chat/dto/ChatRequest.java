package com.gistagent.chat.dto;

/**
 * 单次 chat 请求体。字段命名保留 camelCase，前端历史上使用该格式。
 */
public record ChatRequest(String message, String conversationId, Long datasourceId) {
}
