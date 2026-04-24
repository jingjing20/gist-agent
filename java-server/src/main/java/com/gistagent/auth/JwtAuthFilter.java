package com.gistagent.auth;

import java.io.IOException;
import java.util.List;

import com.gistagent.common.ApiException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Reads {@code Authorization: Bearer <token>}, verifies it, loads the user, and
 * populates the Spring {@link org.springframework.security.core.context.SecurityContext}.
 *
 * Missing / invalid tokens are silently ignored here; the security filter chain
 * decides whether a given route requires authentication. This is the Spring
 * idiom that replaces the Nest global {@code JwtAuthGuard + @Public} pair.
 */
@Component
public class JwtAuthFilter extends OncePerRequestFilter {

	private static final String BEARER_PREFIX = "Bearer ";

	private final JwtTokenService jwtTokenService;
	private final AuthService authService;

	public JwtAuthFilter(JwtTokenService jwtTokenService, AuthService authService) {
		this.jwtTokenService = jwtTokenService;
		this.authService = authService;
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
									FilterChain chain) throws ServletException, IOException {
		String header = request.getHeader("Authorization");
		if (header != null && header.startsWith(BEARER_PREFIX)
				&& SecurityContextHolder.getContext().getAuthentication() == null) {
			String token = header.substring(BEARER_PREFIX.length()).trim();
			try {
				long userId = jwtTokenService.parseUserId(token);
				AuthenticatedUser user = authService.findById(userId);
				UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(
						user, null, List.of());
				auth.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
				SecurityContextHolder.getContext().setAuthentication(auth);
			} catch (ApiException ignored) {
				// Token is present but invalid — leave context empty; downstream
				// authorization will return 401 for protected routes.
			}
		}
		chain.doFilter(request, response);
	}
}
