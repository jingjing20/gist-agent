package com.gistagent.chat.agents;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.gistagent.conversation.ConversationService;
import com.gistagent.llm.LlmService;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

/**
 * 语义蒸馏器：每轮对话结束后异步提取业务口径定义并写回 semantic_state。
 *
 * <p>与 Nest 版对齐：失败只记日志，不影响当次对话响应；在 {@link #updateStateAsync} 直接用 Spring {@code @Async} 托管，调用方无须
 * await。
 */
@Service
public class SemanticDistillerService {

  private static final Logger log = LoggerFactory.getLogger(SemanticDistillerService.class);
  private static final Pattern JSON_BLOCK = Pattern.compile("\\{[\\s\\S]*}");

  private final LlmService llm;
  private final ConversationService conversation;
  private final ObjectMapper mapper;

  public SemanticDistillerService(
      LlmService llm, ConversationService conversation, ObjectMapper mapper) {
    this.llm = llm;
    this.conversation = conversation;
    this.mapper = mapper;
  }

  @Async
  public void updateStateAsync(String conversationId, long userId, String userMessage) {
    try {
      distillAndUpdate(conversationId, userId, userMessage);
    } catch (Exception e) {
      log.warn("Semantic Distillation failed for conv {}: {}", conversationId, e.getMessage());
    }
  }

  @SuppressWarnings("unchecked")
  private void distillAndUpdate(String conversationId, long userId, String userMessage)
      throws Exception {
    Map<String, Object> conv = conversation.findOne(conversationId, userId);
    if (conv == null) return;

    Map<String, Object> currentState = new LinkedHashMap<>();
    Object rawState = conv.get("semantic_state");
    if (rawState instanceof Map<?, ?> m && m.get("definitions") instanceof Map<?, ?> defs) {
      currentState.put("definitions", defs);
    } else {
      currentState.put("definitions", Map.of());
    }

    String systemPrompt =
        "你是一个幕后的知识蒸馏 Agent。你的任务是从数据分析对话中提取【业务名词口径】。\n"
            + "规则：\n"
            + "1. 若用户在对话中定义了业务口径（如\"活跃就是登录且消费\"），提取加入 definitions。\n"
            + "2. 只提取用户主观定义的口径，不要提取查询结果中的数据事实。\n"
            + "3. 返回必须是合法的 JSON 对象，包含 \"definitions\" 字典（值必是字符串）。不要任何多余的话语或Markdown代码块。格式如：{\"definitions\":{}}。\n"
            + "4. 若无新口径，直接原样返回旧的状态。";

    String userPrompt =
        "旧的状态: "
            + mapper.writeValueAsString(currentState)
            + "\n新的一轮对话：\n用户问: "
            + userMessage
            + "\n\n请基于新回合信息，决定是否更新旧的状态，并返回更新后的完整纯 JSON 参数。";

    String response = llm.chat(systemPrompt, userPrompt, 0.1);
    Matcher m = JSON_BLOCK.matcher(response);
    if (!m.find()) return;

    try {
      Map<String, Object> newState = mapper.readValue(m.group(), Map.class);
      conversation.updateSemanticState(conversationId, newState);
      log.info("Semantic state updated for conv {}", conversationId);
    } catch (Exception e) {
      log.error("Failed to parse/update distilled state: {}", e.getMessage());
    }
  }
}
