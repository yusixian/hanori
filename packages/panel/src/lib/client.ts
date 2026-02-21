import type { AppType } from "@cos-tool-bot/server";
import { hc } from "hono/client";

const customFetch: typeof fetch = (input, init) => {
  const token = localStorage.getItem("token");
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
};

export const client = hc<AppType>("/", { fetch: customFetch });
