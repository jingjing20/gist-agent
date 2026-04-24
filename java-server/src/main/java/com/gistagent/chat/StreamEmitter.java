package com.gistagent.chat;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * SSE 推送器：封装 Spring {@link SseEmitter}，对齐 Nest 版 StreamEmitter 的线协议
 * ({@code data: <json>\n\n})。
 *
 * 设计取舍：
 * - Nest 端通过裸写 {@code res.write('data: ' + JSON + '\n\n')} 手动构造 SSE，
 *   Spring 默认的 {@link SseEmitter#event()} 会加 {@code id:}/{@code event:} 行，
 *   前端已有解析逻辑只认 {@code data:} 一行，所以这里用 {@code send(Object)} 直发。
 * - {@link #send(SseEvent)} 捕获 IOException 只记日志——客户端断开是常态，
 *   不应当把异常冒泡到 Agent Loop 导致对话整体失败。
 */
public final class StreamEmitter {

	private static final Logger log = LoggerFactory.getLogger(StreamEmitter.class);

	private final SseEmitter emitter;
	private final ObjectMapper mapper;

	public StreamEmitter(SseEmitter emitter, ObjectMapper mapper) {
		this.emitter = emitter;
		this.mapper = mapper;
	}

	public void send(SseEvent event) {
		try {
			emitter.send(event.payload());
		} catch (IOException e) {
			log.debug("SSE send failed (client closed?): {}", e.getMessage());
		}
	}

	public void done() {
		send(SseEvent.of("done"));
		emitter.complete();
	}

	public void fail(Throwable t) {
		try {
			Map<String, Object> err = new LinkedHashMap<>();
			err.put("type", "error");
			err.put("content", t.getMessage() == null ? "unknown error" : t.getMessage());
			emitter.send(err);
		} catch (IOException e) {
			log.debug("SSE error event failed: {}", e.getMessage());
		}
		emitter.complete();
	}

	/**
	 * 用于构造 {@link SseEvent}：提供“安全字符串化”入口，避免调用方自行
	 * {@code ObjectMapper} 拼接出错。
	 */
	public String stringify(Object value) {
		try {
			return mapper.writeValueAsString(value);
		} catch (JsonProcessingException e) {
			return "\"\"";
		}
	}
}
