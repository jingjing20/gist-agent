package com.gistagent.auth.dto;

public record ResetPasswordRequest(String token, String password) {}
