package com.gistagent.auth.dto;

import com.gistagent.auth.AuthenticatedUser;

public record AuthResponse(AuthenticatedUser user, String token) {}
