package com.gistagent.chat.tools;

import com.openai.core.JsonValue;
import com.openai.models.FunctionDefinition;
import com.openai.models.FunctionParameters;
import com.openai.models.chat.completions.ChatCompletionFunctionTool;
import com.openai.models.chat.completions.ChatCompletionTool;
import java.util.Map;

/**
 * 把“人话”的工具定义打包成 OpenAI SDK 的 {@link ChatCompletionTool}。
 *
 * <p>SDK 本身的 FunctionParameters 需要逐键 putAdditionalProperty， 这里提供一个短路径：直接收一份 {@code Map<String,
 * Object>}（JSON schema） 转成 JsonValue。调用方只关心 schema 形状，不用跟 SDK 的 JsonField 打交道。
 */
public final class ToolDefinitions {

  private ToolDefinitions() {}

  public static ChatCompletionTool functionTool(
      String name, String description, Map<String, Object> parametersSchema) {
    FunctionParameters.Builder paramsBuilder = FunctionParameters.builder();
    parametersSchema.forEach((k, v) -> paramsBuilder.putAdditionalProperty(k, JsonValue.from(v)));

    FunctionDefinition fn =
        FunctionDefinition.builder()
            .name(name)
            .description(description)
            .parameters(paramsBuilder.build())
            .build();

    ChatCompletionFunctionTool functionTool =
        ChatCompletionFunctionTool.builder().function(fn).build();

    return ChatCompletionTool.ofFunction(functionTool);
  }
}
