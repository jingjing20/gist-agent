package com.gistagent.auth;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.stereotype.Component;

/**
 * Returns {@code { statusCode, message, error }} JSON on missing/invalid auth,
 * matching the shape that {@code GlobalExceptionHandler} produces elsewhere.
 */
@Component
public class JwtAuthEntryPoint implements AuthenticationEntryPoint {

	private final ObjectMapper objectMapper;

	public JwtAuthEntryPoint(ObjectMapper objectMapper) {
		this.objectMapper = objectMapper;
	}

	@Override
	public void commence(HttpServletRequest request, HttpServletResponse response,
						 AuthenticationException authException) throws IOException {
		response.setStatus(HttpStatus.UNAUTHORIZED.value());
		response.setContentType(MediaType.APPLICATION_JSON_VALUE);
		response.setCharacterEncoding("UTF-8");

		Map<String, Object> body = new LinkedHashMap<>();
		body.put("statusCode", HttpStatus.UNAUTHORIZED.value());
		body.put("message", "Unauthorized");
		body.put("error", HttpStatus.UNAUTHORIZED.getReasonPhrase());
		objectMapper.writeValue(response.getOutputStream(), body);
	}
}
