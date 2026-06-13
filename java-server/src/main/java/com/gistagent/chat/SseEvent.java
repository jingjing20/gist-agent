package com.gistagent.chat;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 一条 SSE 事件的业务层表示。
 *
 * <p>与前端契约同 Nest 版 {@code SSEEvent}：必定含 {@code type} 字段，其余键值对由具体 事件语义决定。内部用 {@link LinkedHashMap}
 * 维持插入顺序以便调试。
 */
public final class SseEvent {

  private final Map<String, Object> payload;

  private SseEvent(Map<String, Object> payload) {
    this.payload = payload;
  }

  public static SseEvent of(String type) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("type", type);
    return new SseEvent(m);
  }

  public static SseEvent of(String type, String key, Object value) {
    SseEvent event = of(type);
    event.payload.put(key, value);
    return event;
  }

  public SseEvent with(String key, Object value) {
    payload.put(key, value);
    return this;
  }

  public SseEvent withAll(Map<String, Object> values) {
    payload.putAll(values);
    return this;
  }

  public String type() {
    return (String) payload.get("type");
  }

  public Map<String, Object> payload() {
    return payload;
  }

  public Object get(String key) {
    return payload.get(key);
  }

  /** 复制当前事件并改写 type。用于 log -> log_update 原地更新的场景。 */
  public SseEvent asType(String newType) {
    Map<String, Object> copy = new LinkedHashMap<>(payload);
    copy.put("type", newType);
    return new SseEvent(copy);
  }
}
