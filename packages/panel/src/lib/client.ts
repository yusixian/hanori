import type { AppType } from "@cos-tool-bot/server";
import { hc } from "hono/client";

export const authFetch: typeof fetch = async (input, init) => {
  const token = localStorage.getItem("token");
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    const error = new Error("Unauthorized");
    (error as Error & { statusCode: number }).statusCode = 401;
    throw error;
  }
  return response;
};

export const client = hc<AppType>("/", { fetch: authFetch });
