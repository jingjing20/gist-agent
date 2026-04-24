package com.gistagent.datasource;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Port of the data-cleanup helpers in the Nest datasource.controller.
 *
 * Rules are kept byte-identical to avoid behavioral drift across servers:
 * - strip zero-width / NBSP characters, trim
 * - turn thousands-separator strings ("1,234.56") into plain numerics
 * - blank strings become null so MySQL type inference is not poisoned
 * - column names keep Chinese / alphanumerics; everything else is _ ; duplicates get _1, _2
 * - type inference is conservative: TEXT unless all non-null values are numeric
 */
public final class FileParsingUtil {

	private static final Pattern NUMERIC = Pattern.compile("^-?(\\d+\\.?\\d*|\\d*\\.\\d+)$");
	private static final Pattern THOUSAND_SEP = Pattern.compile("^-?\\d{1,3}(,\\d{3})+(\\.\\d+)?$");
	private static final Pattern ZERO_WIDTH = Pattern.compile("[\\u200B\\uFEFF\\u00A0]");
	private static final Pattern UNSAFE_CHAR = Pattern.compile("[^a-zA-Z0-9_\\u4e00-\\u9fa5]");
	private static final Pattern EDGE_UNDERSCORE = Pattern.compile("^_+|_+$");
	private static final Pattern SAFE_COLUMN_NAME = Pattern.compile(
			"^[a-zA-Z_\\u4e00-\\u9fff][a-zA-Z0-9_\\u4e00-\\u9fff]*$");

	private FileParsingUtil() {
	}

	public static Object normalizeValue(Object v) {
		if (v == null) return null;
		if (v instanceof Number n) {
			double d = n.doubleValue();
			return Double.isFinite(d) ? v : null;
		}
		if (v instanceof String raw) {
			String s = ZERO_WIDTH.matcher(raw).replaceAll(" ").trim();
			if (s.isEmpty()) return null;
			if (THOUSAND_SEP.matcher(s).matches()) {
				s = s.replace(",", "");
			}
			return s;
		}
		return v;
	}

	public static boolean isNumeric(Object v) {
		if (v instanceof Number n) return Double.isFinite(n.doubleValue());
		if (v instanceof String s) return NUMERIC.matcher(s).matches();
		return false;
	}

	/**
	 * Conservative type inference: everything non-numeric -> TEXT. If every
	 * non-null sample parses as a number, pick BIGINT for pure integers else
	 * DOUBLE. Pre-existing Nest behavior — do not widen the decision tree.
	 */
	public static String inferMysqlType(List<Object> values) {
		List<Object> nonNull = new ArrayList<>();
		for (Object v : values) if (v != null) nonNull.add(v);
		if (nonNull.isEmpty()) return "TEXT";
		for (Object v : nonNull) if (!isNumeric(v)) return "TEXT";
		boolean hasDecimal = false;
		for (Object v : nonNull) {
			if (v instanceof Number n) {
				double d = n.doubleValue();
				if (d != Math.floor(d) || Double.isInfinite(d)) {
					hasDecimal = true;
					break;
				}
			} else if (v instanceof String s && s.contains(".")) {
				hasDecimal = true;
				break;
			}
		}
		return hasDecimal ? "DOUBLE" : "BIGINT";
	}

	public static Object coerce(Object value, String type) {
		if (value == null) return null;
		if ("TEXT".equals(type)) return value;
		if (value instanceof Number) return value;
		try {
			double d = Double.parseDouble(String.valueOf(value));
			if (!Double.isFinite(d)) return null;
			if ("BIGINT".equals(type)) return (long) d;
			return d;
		} catch (NumberFormatException e) {
			return null;
		}
	}

	public static List<String> ensureUniqueColumnNames(List<String> rawNames) {
		Map<String, Integer> seen = new HashMap<>();
		List<String> out = new ArrayList<>(rawNames.size());
		for (String raw : rawNames) {
			String sanitized = EDGE_UNDERSCORE.matcher(
					UNSAFE_CHAR.matcher(raw == null ? "" : raw).replaceAll("_")).replaceAll("");
			if (sanitized.isEmpty()) sanitized = "col";
			int count = seen.getOrDefault(sanitized, 0);
			seen.put(sanitized, count + 1);
			out.add(count == 0 ? sanitized : sanitized + "_" + count);
		}
		return out;
	}

	public static boolean isSafeColumnName(String name) {
		return name != null && SAFE_COLUMN_NAME.matcher(name).matches();
	}

	public static String escapeSingleQuote(String s) {
		return s.replace("\\", "\\\\").replace("'", "\\'");
	}
}
