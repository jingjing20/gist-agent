package com.gistagent.chat;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.gistagent.auth.AuthenticatedUser;
import com.gistagent.chat.dto.ChatRequest;
import com.gistagent.common.ApiException;

import org.springframework.core.task.AsyncTaskExecutor;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * POST /chat 入口：立刻返回 {@link SseEmitter} 把 HTTP 连接交给 Spring，
 * 真正的 Agent 循环在 {@link AsyncTaskExecutor} 里异步跑，通过 emitter 推送事件。
 *
 * 不在控制器线程里直接跑 handleChat 的原因：handleChat 内部用 Future.get(120s)
 * 做熔断，会阻塞 controller 返回，导致 SseEmitter 迟迟握手不上，前端看到的是
 * 请求 pending 很久才开始吐数据，用户体验极差。
 */
@RestController
@RequestMapping("/chat")
public class ChatController {

	private static final Logger log = LoggerFactory.getLogger(ChatController.class);

	// 稍大于业务 120s 熔断，避免 tomcat 先切断 SSE 连接触发诡异的客户端重连
	private static final long SSE_TIMEOUT_MS = 150_000L;

	private final ChatService chatService;
	private final ObjectMapper mapper;
	private final AsyncTaskExecutor taskExecutor;

	public ChatController(ChatService chatService, ObjectMapper mapper, AsyncTaskExecutor taskExecutor) {
		this.chatService = chatService;
		this.mapper = mapper;
		this.taskExecutor = taskExecutor;
	}

	@PostMapping(produces = MediaType.TEXT_EVENT_STREAM_VALUE)
	public SseEmitter chat(@AuthenticationPrincipal AuthenticatedUser user,
						   @RequestBody ChatRequest body) {
		if (body == null || body.message() == null || body.message().isBlank()) {
			throw ApiException.badRequest("消息不能为空");
		}
		if (body.conversationId() == null || body.conversationId().isBlank()) {
			throw ApiException.badRequest("conversationId 不能为空");
		}

		SseEmitter emitter = new SseEmitter(SSE_TIMEOUT_MS);
		StreamEmitter stream = new StreamEmitter(emitter, mapper);
		long userId = user.id();

		taskExecutor.execute(() -> {
			try {
				chatService.handleChat(stream, userId, body.message(),
						body.conversationId(), body.datasourceId());
			} catch (Exception e) {
				log.warn("chat handling failed: {}", e.getMessage(), e);
				stream.fail(e);
			}
		});
		return emitter;
	}
}
