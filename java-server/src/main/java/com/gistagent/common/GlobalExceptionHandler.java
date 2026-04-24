package com.gistagent.common;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.servlet.NoHandlerFoundException;

/**
 * Produces the same JSON error shape as Nest's default HttpExceptionFilter:
 *   { "statusCode": 403, "message": "...", "error": "Forbidden" }
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

	private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

	@ExceptionHandler(ApiException.class)
	public ResponseEntity<Map<String, Object>> handleApi(ApiException ex) {
		return build(ex.getStatus(), ex.getMessage());
	}

	@ExceptionHandler(MethodArgumentNotValidException.class)
	public ResponseEntity<Map<String, Object>> handleValidation(MethodArgumentNotValidException ex) {
		String message = ex.getBindingResult().getFieldErrors().stream()
				.map(fe -> fe.getField() + " " + fe.getDefaultMessage())
				.collect(Collectors.joining("; "));
		if (message.isBlank()) message = "请求参数校验失败";
		return build(HttpStatus.BAD_REQUEST, message);
	}

	@ExceptionHandler(HttpMessageNotReadableException.class)
	public ResponseEntity<Map<String, Object>> handleUnreadable(HttpMessageNotReadableException ex) {
		return build(HttpStatus.BAD_REQUEST, "请求体解析失败");
	}

	@ExceptionHandler(MaxUploadSizeExceededException.class)
	public ResponseEntity<Map<String, Object>> handleUpload(MaxUploadSizeExceededException ex) {
		return build(HttpStatus.BAD_REQUEST, "上传文件过大");
	}

	@ExceptionHandler(NoHandlerFoundException.class)
	public ResponseEntity<Map<String, Object>> handleNotFound(NoHandlerFoundException ex) {
		return build(HttpStatus.NOT_FOUND, "Cannot " + ex.getHttpMethod() + " " + ex.getRequestURL());
	}

	@ExceptionHandler(AuthenticationException.class)
	public ResponseEntity<Map<String, Object>> handleAuth(AuthenticationException ex) {
		return build(HttpStatus.UNAUTHORIZED, ex.getMessage() == null ? "Unauthorized" : ex.getMessage());
	}

	@ExceptionHandler(AccessDeniedException.class)
	public ResponseEntity<Map<String, Object>> handleAccessDenied(AccessDeniedException ex) {
		return build(HttpStatus.FORBIDDEN, ex.getMessage() == null ? "Forbidden" : ex.getMessage());
	}

	@ExceptionHandler(IllegalArgumentException.class)
	public ResponseEntity<Map<String, Object>> handleIllegal(IllegalArgumentException ex) {
		return build(HttpStatus.BAD_REQUEST, ex.getMessage() == null ? "Bad Request" : ex.getMessage());
	}

	@ExceptionHandler(Exception.class)
	public ResponseEntity<Map<String, Object>> handleOther(Exception ex) {
		log.error("Unhandled exception", ex);
		return build(HttpStatus.INTERNAL_SERVER_ERROR, "Internal server error");
	}

	private ResponseEntity<Map<String, Object>> build(HttpStatus status, String message) {
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("statusCode", status.value());
		body.put("message", message);
		body.put("error", status.getReasonPhrase());
		return ResponseEntity.status(status).body(body);
	}
}
