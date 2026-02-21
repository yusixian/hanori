import type { ApiResponse } from "@cos-tool-bot/shared";

const BASE_URL = "/api";

function getToken(): string | null {
  return localStorage.getItem("token");
}

export function setToken(token: string) {
  localStorage.setItem("token", token);
}

export function clearToken() {
  localStorage.removeItem("token");
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  return res.json() as Promise<ApiResponse<T>>;
}

export const api = {
  login: (password: string) =>
    request<{ token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  getBotStatus: () =>
    request<{ status: string; uptime: number | null }>("/bot/status"),

  startBot: () => request("/bot/start", { method: "POST" }),
  stopBot: () => request("/bot/stop", { method: "POST" }),
  restartBot: () => request("/bot/restart", { method: "POST" }),

  getLogs: (page = 1, limit = 50, level?: string) => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    if (level) params.set("level", level);
    return request(`/logs?${params}`);
  },
};
