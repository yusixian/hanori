import type { AppType } from "@cos-tool-bot/server";
import { hc } from "hono/client";

const isLoginRequest = (input: Parameters<typeof fetch>[0]): boolean => {
  const url = input instanceof Request ? input.url : String(input);
  return url.includes("/api/auth/login");
};

export const authFetch: typeof fetch = async (input, init) => {
  const token = localStorage.getItem("token");
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401 && !isLoginRequest(input)) {
    localStorage.removeItem("token");
    if (window.location.pathname !== "/login") {
      window.location.assign("/login");
    }
    const error = new Error("Unauthorized");
    (error as Error & { statusCode: number }).statusCode = 401;
    throw error;
  }
  return response;
};

export const client: ReturnType<typeof hc<AppType>> = hc<AppType>("/", { fetch: authFetch });
