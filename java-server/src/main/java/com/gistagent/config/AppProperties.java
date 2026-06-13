package com.gistagent.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Strongly-typed binding for the {@code app.*} keys in application.yml. Mirrors the env variables
 * the Nest server reads via process.env.
 */
@ConfigurationProperties(prefix = "app")
public record AppProperties(Openai openai, Jwt jwt, Smtp smtp, Langsmith langsmith) {
  public record Openai(String apiKey, String baseUrl, String model) {
    public String modelOrDefault() {
      return (model == null || model.isBlank()) ? "gpt-4o" : model;
    }
  }

  public record Jwt(String secret, long expirationSeconds) {}

  public record Smtp(String from) {}

  public record Langsmith(boolean tracing, String apiKey, String project) {}
}
