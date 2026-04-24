package com.gistagent.auth;

import java.util.Map;

import com.gistagent.auth.dto.AuthResponse;
import com.gistagent.auth.dto.ForgotPasswordRequest;
import com.gistagent.auth.dto.LoginRequest;
import com.gistagent.auth.dto.RegisterRequest;
import com.gistagent.auth.dto.ResetPasswordRequest;
import com.gistagent.common.ApiException;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/auth")
public class AuthController {

	private final AuthService authService;

	public AuthController(AuthService authService) {
		this.authService = authService;
	}

	@PostMapping("/register")
	public AuthResponse register(@RequestBody RegisterRequest body) {
		if (isBlank(body.email()) || isBlank(body.password())) {
			throw ApiException.badRequest("邮箱和密码不能为空");
		}
		if (body.password().length() < 6) {
			throw ApiException.badRequest("密码至少 6 位");
		}
		return authService.register(body.email(), body.password(), body.name());
	}

	@PostMapping("/login")
	public AuthResponse login(@RequestBody LoginRequest body) {
		if (isBlank(body.email()) || isBlank(body.password())) {
			throw ApiException.badRequest("邮箱和密码不能为空");
		}
		return authService.login(body.email(), body.password());
	}

	@PostMapping("/forgot-password")
	public Map<String, String> forgotPassword(@RequestBody ForgotPasswordRequest body) {
		if (isBlank(body.email())) {
			throw ApiException.badRequest("邮箱不能为空");
		}
		authService.requestReset(body.email(), body.origin());
		return Map.of("message", "若该邮箱已注册，重置链接已发送，请查收邮件");
	}

	@PostMapping("/reset-password")
	public Map<String, String> resetPassword(@RequestBody ResetPasswordRequest body) {
		authService.resetPassword(body.token(), body.password());
		return Map.of("message", "密码已重置，请重新登录");
	}

	@PostMapping("/me")
	public AuthenticatedUser me(@AuthenticationPrincipal AuthenticatedUser user) {
		if (user == null) throw ApiException.unauthorized("Unauthorized");
		return user;
	}

	private static boolean isBlank(String s) {
		return s == null || s.trim().isEmpty();
	}
}
