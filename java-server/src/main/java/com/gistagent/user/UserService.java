package com.gistagent.user;

import java.util.List;

import com.gistagent.common.ApiException;
import com.gistagent.user.dto.UserSearchResult;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

@Service
public class UserService {

	private static final int SEARCH_LIMIT = 20;

	private final JdbcTemplate jdbc;
	private final PasswordEncoder passwordEncoder;

	public UserService(JdbcTemplate jdbc, PasswordEncoder passwordEncoder) {
		this.jdbc = jdbc;
		this.passwordEncoder = passwordEncoder;
	}

	public List<UserSearchResult> searchByEmail(String q) {
		if (q == null) return List.of();
		String trimmed = q.trim();
		if (trimmed.length() < 2) return List.of();
		return jdbc.query(
				"SELECT id, email, name FROM user WHERE email LIKE ? ORDER BY email LIMIT ?",
				(rs, rowNum) -> new UserSearchResult(
						rs.getLong("id"),
						rs.getString("email"),
						rs.getString("name")),
				"%" + trimmed + "%", SEARCH_LIMIT);
	}

	public void updateProfile(long userId, String name) {
		if (name == null || name.trim().isEmpty()) {
			throw ApiException.badRequest("用户名不能为空");
		}
		jdbc.update("UPDATE user SET name = ? WHERE id = ?", name.trim(), userId);
	}

	public void updatePassword(long userId, String newPassword) {
		if (newPassword == null || newPassword.length() < 6) {
			throw ApiException.badRequest("密码至少 6 位");
		}
		String hash = passwordEncoder.encode(newPassword);
		jdbc.update("UPDATE user SET password_hash = ? WHERE id = ?", hash, userId);
	}
}
