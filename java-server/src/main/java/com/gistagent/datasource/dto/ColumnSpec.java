package com.gistagent.datasource.dto;

/**
 * Internal DTO describing one column in an upload request. originalName = the raw CSV/Excel header
 * (used for COLUMN COMMENT only).
 */
public record ColumnSpec(String name, String originalName, String type) {}
