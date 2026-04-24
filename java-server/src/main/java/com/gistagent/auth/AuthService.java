package com.gistagent.auth;

import java.security.SecureRandom;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

import com.gistagent.auth.dto.AuthResponse;
import com.gistagent.common.ApiException;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {

	private static final SecureRandom RANDOM = new SecureRandom();

	private final JdbcTemplate jdbc;
	private final PasswordEncoder passwordEncoder;
	private final JwtTokenService jwtTokenService;
	private final MailerService mailer;

	public AuthService(JdbcTemplate jdbc,
					   PasswordEncoder passwordEncoder,
					   JwtTokenService jwtTokenService,
					   MailerService mailer) {
		this.jdbc = jdbc;
		this.passwordEncoder = passwordEncoder;
		this.jwtTokenService = jwtTokenService;
		this.mailer = mailer;
	}

	public AuthResponse register(String email, String password, String name) {
		String normalizedEmail = email.toLowerCase().trim();
		Integer existing = jdbc.query(
				"SELECT id FROM user WHERE email = ?",
				rs -> rs.next() ? rs.getInt(1) : null,
				normalizedEmail);
		if (existing != null) {
			throw ApiException.conflict("该邮箱已注册");
		}

		String hash = passwordEncoder.encode(password);
		String displayName = (name == null || name.isBlank()) ? normalizedEmail.split("@")[0] : name.trim();

		KeyHolder keyHolder = new GeneratedKeyHolder();
		jdbc.update(conn -> {
			PreparedStatement ps = conn.prepareStatement(
					"INSERT INTO user (email, password_hash, name) VALUES (?, ?, ?)",
					Statement.RETURN_GENERATED_KEYS);
			ps.setString(1, normalizedEmail);
			ps.setString(2, hash);
			ps.setString(3, displayName);
			return ps;
		}, keyHolder);

		Number key = keyHolder.getKey();
		if (key == null) throw ApiException.internal("用户创建失败");
		AuthenticatedUser user = findById(key.longValue());
		String token = jwtTokenService.issue(user.id(), user.email());
		return new AuthResponse(user, token);
	}

	public AuthResponse login(String email, String password) {
		String normalizedEmail = email.toLowerCase().trim();
		List<Map<String, Object>> rows = jdbc.queryForList(
				"SELECT id, email, name, password_hash, created_at FROM user WHERE email = ?",
				normalizedEmail);
		if (rows.isEmpty()) {
			throw ApiException.unauthorized("邮箱或密码错误");
		}
		Map<String, Object> row = rows.get(0);
		String hash = (String) row.get("password_hash");
		if (!passwordEncoder.matches(password, hash)) {
			throw ApiException.unauthorized("邮箱或密码错误");
		}

		AuthenticatedUser user = new AuthenticatedUser(
				((Number) row.get("id")).longValue(),
				(String) row.get("email"),
				(String) row.get("name"),
				toLocalDateTime(row.get("created_at")));
		String token = jwtTokenService.issue(user.id(), user.email());
		return new AuthResponse(user, token);
	}

	public void requestReset(String email, String origin) {
		String normalizedEmail = email.toLowerCase().trim();
		Long userId = jdbc.query(
				"SELECT id FROM user WHERE email = ?",
				rs -> rs.next() ? rs.getLong(1) : null,
				normalizedEmail);
		if (userId == null) {
			// Do not leak whether the email exists.
			return;
		}

		String token = generateResetToken();
		jdbc.update(
				"INSERT INTO password_reset_token (user_id, token, expires_at) "
						+ "VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 15 MINUTE))",
				userId, token);

		String baseUrl = (origin == null || origin.isBlank()) ? "http://localhost:5173" : origin;
		if (baseUrl.endsWith("/")) baseUrl = baseUrl.substring(0, baseUrl.length() - 1);
		String resetUrl = baseUrl + "/#/reset-password?token=" + token;
		mailer.sendResetEmail(normalizedEmail, resetUrl);
	}

	@Transactional
	public void resetPassword(String token, String newPassword) {
		if (token == null || token.isBlank()) throw ApiException.badRequest("token 不能为空");
		if (newPassword == null || newPassword.length() < 6) throw ApiException.badRequest("密码至少 6 位");

		Map<String, Object> row = jdbc.query(
				"SELECT id, user_id FROM password_reset_token "
						+ "WHERE token = ? AND expires_at > NOW() AND used_at IS NULL",
				rs -> rs.next() ? Map.of(
						"id", rs.getLong("id"),
						"user_id", rs.getLong("user_id")
				) : null,
				token);
		if (row == null) throw ApiException.badRequest("链接已失效或已使用");

		long tokenId = ((Number) row.get("id")).longValue();
		long userId = ((Number) row.get("user_id")).longValue();
		String hash = passwordEncoder.encode(newPassword);

		jdbc.update("UPDATE user SET password_hash = ? WHERE id = ?", hash, userId);
		jdbc.update("UPDATE password_reset_token SET used_at = NOW() WHERE id = ?", tokenId);
	}

	public AuthenticatedUser findById(long id) {
		try {
			return jdbc.queryForObject(
					"SELECT id, email, name, created_at FROM user WHERE id = ?",
					(rs, rowNum) -> new AuthenticatedUser(
							rs.getLong("id"),
							rs.getString("email"),
							rs.getString("name"),
							rs.getObject("created_at", LocalDateTime.class)),
					id);
		} catch (EmptyResultDataAccessException e) {
			throw ApiException.unauthorized("用户不存在");
		}
	}

	private static String generateResetToken() {
		byte[] bytes = new byte[32];
		RANDOM.nextBytes(bytes);
		return HexFormat.of().formatHex(bytes);
	}

	private static LocalDateTime toLocalDateTime(Object value) {
		if (value == null) return null;
		if (value instanceof java.sql.Timestamp ts) return ts.toLocalDateTime();
		if (value instanceof LocalDateTime ldt) return ldt;
		return null;
	}
}
