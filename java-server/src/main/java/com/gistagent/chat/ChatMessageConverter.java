package com.gistagent.chat;

import com.openai.core.JsonValue;
import com.openai.models.chat.completions.ChatCompletionAssistantMessageParam;
import com.openai.models.chat.completions.ChatCompletionMessageFunctionToolCall;
import com.openai.models.chat.completions.ChatCompletionMessageParam;
import com.openai.models.chat.completions.ChatCompletionMessageToolCall;
import com.openai.models.chat.completions.ChatCompletionSystemMessageParam;
import com.openai.models.chat.completions.ChatCompletionToolMessageParam;
import com.openai.models.chat.completions.ChatCompletionUserMessageParam;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * 在三种形态之间来回翻译： - 应用内中性 {@link ChatMessageDto} - OpenAI SDK 的 {@link ChatCompletionMessageParam}
 * union - 持久化到 {@code message.llm_messages} 的 OpenAI wire JSON（Map 结构）
 *
 * <p>wire JSON 形状参考 OpenAI Chat Completions 规范，目的是让 Nest 服务端和 Java 服务端可以共享同一张表而不互相踩对方的历史数据。
 */
@Component
public class ChatMessageConverter {

  public ChatCompletionMessageParam toParam(ChatMessageDto msg) {
    return switch (msg.role()) {
      case "system" ->
          ChatCompletionMessageParam.ofSystem(
              ChatCompletionSystemMessageParam.builder()
                  .content(nullToEmpty(msg.content()))
                  .build());
      case "user" ->
          ChatCompletionMessageParam.ofUser(
              ChatCompletionUserMessageParam.builder().content(nullToEmpty(msg.content())).build());
      case "assistant" -> {
        ChatCompletionAssistantMessageParam.Builder b =
            ChatCompletionAssistantMessageParam.builder();
        if (msg.content() != null && !msg.content().isEmpty()) {
          b.content(msg.content());
        }
        if (msg.toolCalls() != null && !msg.toolCalls().isEmpty()) {
          for (ToolCallDto tc : msg.toolCalls()) {
            b.addToolCall(
                ChatCompletionMessageToolCall.ofFunction(
                    ChatCompletionMessageFunctionToolCall.builder()
                        .id(tc.id())
                        .function(
                            ChatCompletionMessageFunctionToolCall.Function.builder()
                                .name(tc.name())
                                .arguments(tc.arguments() == null ? "" : tc.arguments())
                                .build())
                        .build()));
          }
        }
        if (msg.reasoningContent() != null && !msg.reasoningContent().isEmpty()) {
          b.putAdditionalProperty("reasoning_content", JsonValue.from(msg.reasoningContent()));
        }
        yield ChatCompletionMessageParam.ofAssistant(b.build());
      }
      case "tool" ->
          ChatCompletionMessageParam.ofTool(
              ChatCompletionToolMessageParam.builder()
                  .toolCallId(msg.toolCallId() == null ? "" : msg.toolCallId())
                  .content(nullToEmpty(msg.content()))
                  .build());
      default -> throw new IllegalArgumentException("未知的消息 role: " + msg.role());
    };
  }

  /** 序列化到数据库的 wire 形态：和 OpenAI HTTP body 的字段命名保持一致。 */
  public Map<String, Object> toWire(ChatMessageDto msg) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("role", msg.role());
    if (msg.content() != null) out.put("content", msg.content());
    if ("tool".equals(msg.role()) && msg.toolCallId() != null) {
      out.put("tool_call_id", msg.toolCallId());
    }
    if ("assistant".equals(msg.role()) && msg.toolCalls() != null && !msg.toolCalls().isEmpty()) {
      List<Map<String, Object>> calls = new ArrayList<>(msg.toolCalls().size());
      for (ToolCallDto tc : msg.toolCalls()) {
        Map<String, Object> fn = new LinkedHashMap<>();
        fn.put("name", tc.name());
        fn.put("arguments", tc.arguments() == null ? "" : tc.arguments());
        Map<String, Object> call = new LinkedHashMap<>();
        call.put("id", tc.id());
        call.put("type", "function");
        call.put("function", fn);
        calls.add(call);
      }
      out.put("tool_calls", calls);
    }
    if (msg.reasoningContent() != null && !msg.reasoningContent().isEmpty()) {
      out.put("reasoning_content", msg.reasoningContent());
    }
    return out;
  }

  public List<Map<String, Object>> toWireList(List<ChatMessageDto> msgs) {
    if (msgs == null || msgs.isEmpty()) return List.of();
    List<Map<String, Object>> out = new ArrayList<>(msgs.size());
    for (ChatMessageDto m : msgs) out.add(toWire(m));
    return out;
  }

  /** 从 {@code message.llm_messages} 的反序列化结果（List of Map）恢复成 DTO。 */
  @SuppressWarnings("unchecked")
  public List<ChatMessageDto> fromStoredList(Object raw) {
    if (!(raw instanceof List<?> list) || list.isEmpty()) return List.of();
    List<ChatMessageDto> out = new ArrayList<>(list.size());
    for (Object item : list) {
      if (!(item instanceof Map<?, ?> m)) continue;
      Map<String, Object> mm = (Map<String, Object>) m;
      String role = asString(mm.get("role"));
      if (role == null) continue;
      String content = asString(mm.get("content"));
      String toolCallId = asString(mm.get("tool_call_id"));
      List<ToolCallDto> calls = null;
      Object rawCalls = mm.get("tool_calls");
      if (rawCalls instanceof List<?> lc && !lc.isEmpty()) {
        calls = new ArrayList<>(lc.size());
        for (Object c : lc) {
          if (!(c instanceof Map<?, ?> cm)) continue;
          Map<String, Object> cmm = (Map<String, Object>) cm;
          String id = asString(cmm.get("id"));
          Map<String, Object> fn =
              cmm.get("function") instanceof Map<?, ?> fm ? (Map<String, Object>) fm : Map.of();
          calls.add(
              new ToolCallDto(
                  id == null ? "" : id, asString(fn.get("name")), asString(fn.get("arguments"))));
        }
      }
      String reasoningContent = asString(mm.get("reasoning_content"));
      out.add(new ChatMessageDto(role, content, calls, toolCallId, reasoningContent));
    }
    return out;
  }

  private static String asString(Object value) {
    if (value == null) return null;
    return value instanceof String s ? s : value.toString();
  }

  private static String nullToEmpty(String s) {
    return s == null ? "" : s;
  }
}
