package com.gistagent.common;

/**
 * Normalizes JDBC values that differ by driver (e.g. MySQL {@code TINYINT(1)} as Boolean or Integer).
 */
public final class JdbcScalars {

	private JdbcScalars() {
	}

	public static boolean isTruthy(Object value) {
		if (value == null) return false;
		if (value instanceof Boolean b) return b;
		if (value instanceof Number n) return n.intValue() != 0;
		if (value instanceof byte[] bytes && bytes.length > 0) return bytes[0] != 0;
		return Boolean.parseBoolean(value.toString());
	}
}
