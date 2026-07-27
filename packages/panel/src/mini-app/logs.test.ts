import { describe, expect, it, vi } from "vitest";
import { fetchMiniAppLogs, MiniAppLogApiError, parseMiniAppLogPage } from "./logs";

describe("Mini App log API", () => {
  it("accepts only the strict safe response shape", () => {
    expect(
      parseMiniAppLogPage({
        ok: true,
        logs: [
          {
            id: 1,
            level: "info",
            message: "Bot started",
            createdAt: "2026-07-28T00:00:00.000Z",
            meta: { command: "help", chatType: "private", updateId: 2, messageId: 3 },
          },
        ],
        nextCursor: null,
      }),
    ).not.toBeNull();

    for (const unsafe of [
      { meta: { text: "private" } },
      { meta: { args: ["private"] } },
      { meta: { token: "secret" } },
      { rawError: { stack: "secret" } },
    ]) {
      const entry = {
        id: 1,
        level: "info",
        message: "Bot started",
        createdAt: "2026-07-28T00:00:00.000Z",
        meta: {},
        ...unsafe,
      };
      expect(parseMiniAppLogPage({ ok: true, logs: [entry], nextCursor: null })).toBeNull();
    }
  });

  it("encodes bounded level filters and fails closed on an unsafe payload", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        ok: true,
        logs: [
          {
            id: 1,
            level: "info",
            message: "Bot started",
            createdAt: "2026-07-28T00:00:00.000Z",
            meta: { apiKey: "secret" },
          },
        ],
        nextCursor: null,
      }),
    );

    await expect(
      fetchMiniAppLogs("bot/a", { before: 10, level: "warn", limit: 20 }, fetcher),
    ).rejects.toBeInstanceOf(MiniAppLogApiError);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/mini-app/bot%2Fa/logs?limit=20&before=10&level=warn",
      { credentials: "same-origin" },
    );
  });
});
