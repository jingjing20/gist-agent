package com.gistagent.common;

import org.springframework.http.HttpStatus;

/**
 * Mirrors Nest's HttpException family (BadRequestException, UnauthorizedException,
 * ForbiddenException, NotFoundException, ConflictException, ...).
 * Thrown anywhere in the service layer; surfaced as JSON by GlobalExceptionHandler
 * in the shape { statusCode, message, error } to stay wire-compatible with the
 * Nest implementation.
 */
public class ApiException extends RuntimeException {

	private final HttpStatus status;

	public ApiException(HttpStatus status, String message) {
		super(message);
		this.status = status;
	}

	public HttpStatus getStatus() {
		return status;
	}

	public static ApiException badRequest(String message) {
		return new ApiException(HttpStatus.BAD_REQUEST, message);
	}

	public static ApiException unauthorized(String message) {
		return new ApiException(HttpStatus.UNAUTHORIZED, message);
	}

	public static ApiException forbidden(String message) {
		return new ApiException(HttpStatus.FORBIDDEN, message);
	}

	public static ApiException notFound(String message) {
		return new ApiException(HttpStatus.NOT_FOUND, message);
	}

	public static ApiException conflict(String message) {
		return new ApiException(HttpStatus.CONFLICT, message);
	}

	public static ApiException internal(String message) {
		return new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, message);
	}
}
