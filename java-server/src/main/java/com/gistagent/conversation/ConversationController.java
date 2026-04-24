package com.gistagent.conversation;

import java.util.List;
import java.util.Map;

import com.gistagent.auth.AuthenticatedUser;
import com.gistagent.conversation.dto.CreateConversationRequest;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/conversations")
public class ConversationController {

	private final ConversationService service;

	public ConversationController(ConversationService service) {
		this.service = service;
	}

	@GetMapping
	public List<Map<String, Object>> findAll(@AuthenticationPrincipal AuthenticatedUser user) {
		return service.findAll(user.id());
	}

	@PostMapping
	public Map<String, Object> create(@AuthenticationPrincipal AuthenticatedUser user,
									  @RequestBody(required = false) CreateConversationRequest body) {
		return service.create(user.id(), body == null ? null : body.title());
	}

	@DeleteMapping("/{id}")
	public void remove(@AuthenticationPrincipal AuthenticatedUser user, @PathVariable String id) {
		service.remove(id, user.id());
	}

	@GetMapping("/{id}/messages")
	public List<Map<String, Object>> getMessages(@AuthenticationPrincipal AuthenticatedUser user,
												 @PathVariable String id) {
		return service.getMessages(id, user.id());
	}
}
