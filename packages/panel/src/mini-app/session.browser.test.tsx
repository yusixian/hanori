import { expect, describe, it, vi } from "vitest";
import { bootstrapMiniAppSession } from "./session";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

function readyResponse(role = "admin") {
  return Response.json({
    ok: true,
    user: { id: 42, firstName: "Ada" },
    session: { expiresAt: 1_800_000_900, csrfToken: "csrf" },
    access: { role, capabilities: ["group.config.read"], chatScope: { kind: "all" } },
  });
}

describe("bootstrapMiniAppSession", () => {
  it("exchanges current initData before trusting an existing browser cookie", async () => {
    const fetcher = vi.fn(async () => readyResponse());

    await expect(
      bootstrapMiniAppSession({ botId: BOT_ID, initData: "secret", fetcher }),
    ).resolves.toMatchObject({ status: "ready", session: { role: "admin" } });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(`/api/mini-app/${BOT_ID}/session`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: "secret" }),
    });
  });

  it("uses a Bot-scoped cookie only when Telegram provides no fresh initData", async () => {
    const fetcher = vi.fn(async () => readyResponse("viewer"));

    await expect(
      bootstrapMiniAppSession({ botId: BOT_ID, initData: "", fetcher }),
    ).resolves.toMatchObject({ status: "ready", session: { role: "viewer" } });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(`/api/mini-app/${BOT_ID}/session`, {
      credentials: "same-origin",
    });
  });

  it("fails closed for missing initData, 403, malformed data, and network errors", async () => {
    await expect(
      bootstrapMiniAppSession({
        botId: BOT_ID,
        initData: "",
        fetcher: vi.fn(async () => new Response(null, { status: 401 })),
      }),
    ).resolves.toEqual({ status: "expired" });
    await expect(
      bootstrapMiniAppSession({
        botId: BOT_ID,
        initData: "signed",
        fetcher: vi.fn(async () => new Response(null, { status: 403 })),
      }),
    ).resolves.toEqual({ status: "forbidden" });
    await expect(
      bootstrapMiniAppSession({
        botId: BOT_ID,
        initData: "signed",
        fetcher: vi.fn(async () => Response.json({ ok: true })),
      }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      bootstrapMiniAppSession({
        botId: BOT_ID,
        initData: "signed",
        fetcher: vi.fn(async () => {
          throw new Error("offline");
        }),
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });
});
