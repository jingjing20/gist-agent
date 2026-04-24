package com.gistagent.auth;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;

import javax.crypto.SecretKey;

import com.gistagent.common.ApiException;
import com.gistagent.config.AppProperties;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.security.Keys;
import io.jsonwebtoken.security.WeakKeyException;
import org.springframework.stereotype.Service;

/**
 * Issues and validates HS256 JWTs with the shape {@code { sub, email, iat, exp }},
 * matching the Nest {@code JwtService.sign({ sub, email })} contract.
 */
@Service
public class JwtTokenService {

	private final SecretKey key;
	private final Duration expiration;

	public JwtTokenService(AppProperties properties) {
		AppProperties.Jwt cfg = properties.jwt();
		String secret = cfg != null ? cfg.secret() : null;
		if (secret == null || secret.isBlank()) {
			throw new IllegalStateException("app.jwt.secret (JWT_SECRET) is not configured");
		}
		try {
			this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
		} catch (WeakKeyException e) {
			throw new IllegalStateException(
					"JWT_SECRET must be at least 32 bytes (256 bits) for HS256", e);
		}
		long seconds = cfg.expirationSeconds() > 0 ? cfg.expirationSeconds() : 7 * 24 * 3600L;
		this.expiration = Duration.ofSeconds(seconds);
	}

	public String issue(long userId, String email) {
		Instant now = Instant.now();
		return Jwts.builder()
				.subject(String.valueOf(userId))
				.claim("email", email)
				.issuedAt(Date.from(now))
				.expiration(Date.from(now.plus(expiration)))
				.signWith(key)
				.compact();
	}

	public long parseUserId(String token) {
		try {
			Claims claims = Jwts.parser()
					.verifyWith(key)
					.build()
					.parseSignedClaims(token)
					.getPayload();
			return Long.parseLong(claims.getSubject());
		} catch (JwtException | NumberFormatException e) {
			throw ApiException.unauthorized("无效或过期的 token");
		}
	}
}
