import { afterEach, expect, test, vi } from "vitest";
import { pluginsApi } from "./api";

afterEach(() => vi.restoreAllMocks());

test("QR login requests use Bot-scoped endpoints, guarded start body, and empty poll/cancel JSON", async () => {
  const calls: Array<{
    path: string;
    method: string;
    body: unknown;
    credentials: RequestCredentials;
  }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(new URL(String(input), window.location.origin), init);
    calls.push({
      path: new URL(request.url).pathname,
      method: request.method,
      body: await request.json(),
      credentials: request.credentials,
    });
    return Response.json({
      ok: true,
      data: {
        id: "synthetic-session",
        status: "waiting",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        qrUrl: "https://example.test/synthetic",
      },
    });
  });
  await pluginsApi.startLogin("synthetic.plugin", "bot-1", {
    expectedRevision: 3,
    manifestHash: "synthetic-manifest",
  });
  await pluginsApi.pollLogin("synthetic.plugin", "bot-1", "synthetic-session");
  await pluginsApi.cancelLogin("synthetic.plugin", "bot-1", "synthetic-session");
  expect(calls).toEqual([
    {
      path: "/api/plugins/synthetic.plugin/bots/bot-1/login",
      method: "POST",
      body: { expectedRevision: 3, manifestHash: "synthetic-manifest" },
      credentials: "include",
    },
    {
      path: "/api/plugins/synthetic.plugin/bots/bot-1/login/synthetic-session/poll",
      method: "POST",
      body: {},
      credentials: "include",
    },
    {
      path: "/api/plugins/synthetic.plugin/bots/bot-1/login/synthetic-session/cancel",
      method: "POST",
      body: {},
      credentials: "include",
    },
  ]);
});
