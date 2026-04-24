package com.gistagent.llm;

import java.util.function.Consumer;

import com.gistagent.common.ApiException;
import com.gistagent.config.AppProperties;
import com.openai.client.OpenAIClient;
import com.openai.core.http.StreamResponse;
import com.openai.models.chat.completions.ChatCompletion;
import com.openai.models.chat.completions.ChatCompletionChunk;
import com.openai.models.chat.completions.ChatCompletionCreateParams;

import org.springframework.stereotype.Service;

/**
 * Thin wrapper over the OpenAI Java SDK that matches the surface of the Nest
 * LlmService: a blocking {@link #chat} and a callback-style {@link #chatStream}.
 * The underlying OpenAIClient is configured in {@code OpenAIClientConfig}.
 *
 * Note: LangSmith tracing is wired by wrapping the OpenAI client in the Nest
 * version. Java has no drop-in equivalent yet; if you need tracing, introduce
 * the langsmith Java SDK in a later phase and decorate the client bean there.
 */
@Service
public class LlmService {

	private final OpenAIClient client;
	private final String model;

	public LlmService(OpenAIClient client, AppProperties properties) {
		this.client = client;
		this.model = properties.openai().modelOrDefault();
	}

	public String getModel() {
		return model;
	}

	public OpenAIClient getClient() {
		return client;
	}

	public String chat(String systemPrompt, String userPrompt) {
		return chat(systemPrompt, userPrompt, 0.0);
	}

	public String chat(String systemPrompt, String userPrompt, double temperature) {
		ChatCompletionCreateParams params = ChatCompletionCreateParams.builder()
				.model(model)
				.temperature(temperature)
				.addSystemMessage(systemPrompt)
				.addUserMessage(userPrompt)
				.build();

		ChatCompletion completion = client.chat().completions().create(params);
		String content = completion.choices().stream()
				.flatMap(choice -> choice.message().content().stream())
				.findFirst()
				.map(String::trim)
				.orElse("");
		if (content.isEmpty()) {
			throw ApiException.internal("LLM returned empty response");
		}
		return content;
	}

	public String chatStream(String systemPrompt, String userPrompt, Consumer<String> onChunk) {
		return chatStream(systemPrompt, userPrompt, 0.0, onChunk);
	}

	public String chatStream(String systemPrompt, String userPrompt, double temperature,
							 Consumer<String> onChunk) {
		ChatCompletionCreateParams params = ChatCompletionCreateParams.builder()
				.model(model)
				.temperature(temperature)
				.addSystemMessage(systemPrompt)
				.addUserMessage(userPrompt)
				.build();

		StringBuilder buffer = new StringBuilder();
		try (StreamResponse<ChatCompletionChunk> stream = client.chat().completions().createStreaming(params)) {
			stream.stream()
					.flatMap(chunk -> chunk.choices().stream())
					.flatMap(choice -> choice.delta().content().stream())
					.forEach(delta -> {
						if (delta == null || delta.isEmpty()) return;
						buffer.append(delta);
						onChunk.accept(delta);
					});
		}
		return buffer.toString();
	}
}
