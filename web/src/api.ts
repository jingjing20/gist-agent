const API_BASE = "/api";

export async function apiFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const token = localStorage.getItem("auth_token");
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (
    init?.body &&
    !(init.body instanceof FormData) &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${API_BASE}${url}`, { ...init, headers });
  if (res.status === 401 && !url.includes("/auth/")) {
    localStorage.removeItem("auth_token");
    window.location.hash = "#/login";
  }
  return res;
}
