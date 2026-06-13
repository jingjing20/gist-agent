package com.gistagent.auth;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.LocalDateTime;

/**
 * JSON-serializable principal that represents the authenticated user, matching the shape of the
 * Nest {@code User} interface: {@code { id, email, name, created_at }}.
 */
public record AuthenticatedUser(
    long id, String email, String name, @JsonProperty("created_at") LocalDateTime createdAt) {}
