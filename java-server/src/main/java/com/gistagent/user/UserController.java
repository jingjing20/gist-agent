package com.gistagent.user;

import java.util.List;
import java.util.Map;

import com.gistagent.auth.AuthenticatedUser;
import com.gistagent.user.dto.UpdatePasswordRequest;
import com.gistagent.user.dto.UpdateProfileRequest;
import com.gistagent.user.dto.UserSearchResult;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/users")
public class UserController {

	private final UserService userService;

	public UserController(UserService userService) {
		this.userService = userService;
	}

	@GetMapping("/search")
	public List<UserSearchResult> search(@RequestParam(name = "q", required = false) String q) {
		return userService.searchByEmail(q == null ? "" : q);
	}

	@PutMapping("/profile")
	public Map<String, Boolean> updateProfile(@AuthenticationPrincipal AuthenticatedUser user,
											  @RequestBody UpdateProfileRequest body) {
		userService.updateProfile(user.id(), body.name());
		return Map.of("success", true);
	}

	@PutMapping("/password")
	public Map<String, Boolean> updatePassword(@AuthenticationPrincipal AuthenticatedUser user,
											   @RequestBody UpdatePasswordRequest body) {
		userService.updatePassword(user.id(), body.password());
		return Map.of("success", true);
	}
}
