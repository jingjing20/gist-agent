package com.gistagent.config;

import com.openai.client.OpenAIClient;
import com.openai.client.okhttp.OpenAIOkHttpClient;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenAIClientConfig {

	@Bean
	public OpenAIClient openAIClient(AppProperties props) {
		AppProperties.Openai cfg = props.openai();
		OpenAIOkHttpClient.Builder builder = OpenAIOkHttpClient.builder()
				.apiKey(cfg.apiKey() == null ? "" : cfg.apiKey());
		if (cfg.baseUrl() != null && !cfg.baseUrl().isBlank()) {
			builder.baseUrl(cfg.baseUrl());
		}
		return builder.build();
	}
}
