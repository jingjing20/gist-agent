package com.gistagent.chat.tools;

import com.gistagent.chat.StreamEmitter;

/** 工具执行时可见的上下文。对齐 Nest 版 {@code ToolContext}： 提供向客户端推送 SSE 的通道、当前请求的数据源 ID 和用户 ID。 */
public record ToolContext(StreamEmitter emitter, Long datasourceId, Long userId) {}
