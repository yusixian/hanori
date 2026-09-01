import type { AppType } from "@cos-tool-bot/server";
import { hc } from "hono/client";

export const authFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const response = await fetch(input, { ...init, headers, credentials: "include" });
  if (response.status === 401) {
    if (window.location.pathname !== "/login") {
      window.location.assign(loginPathFor(window.location));
    }
    const error = new Error("Unauthorized");
    (error as Error & { statusCode: number }).statusCode = 401;
    throw error;
  }
  return response;
};

export function loginPathFor(location: Pick<Location, "pathname" | "search" | "hash">): string {
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export const client: ReturnType<typeof hc<AppType>> = hc<AppType>("/", { fetch: authFetch });
