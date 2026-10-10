import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { LarkWebhookClient } from "./lark-webhook-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["not JSON", "null", "[]", "{}", '{"code":"0"}'])(
  "returns a failure for an invalid webhook response %s without retrying",
  async (response) => {
    const fetch = vi.fn().mockResolvedValue(new Response(response));
    vi.stubGlobal("fetch", fetch);
    const client = new LarkWebhookClient("https://example.com/webhook");
    await expect(client.sendText("hello")).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/invalid.*response/i),
    });
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it("returns a failure when the response body cannot be read", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("response interrupted"));
          },
        }),
      ),
    ),
  );
  const result = await new LarkWebhookClient("https://example.com/webhook").sendText("hello");
  expect(result).toEqual({ ok: false, error: expect.any(String) });
});

it.each([
  [{ code: 100, msg: "rejected" }, "rejected"],
  [{ code: 100, msg: { unexpected: true } }, "Lark API error code: 100"],
])("returns a string diagnostic for API errors", async (response, error) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
  await expect(
    new LarkWebhookClient("https://example.com/webhook").sendText("hello"),
  ).resolves.toEqual({ ok: false, error });
});

it("preserves signed card payloads without mutating the caller's object", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  const fetch = vi.fn().mockResolvedValue(Response.json({ code: 0 }));
  vi.stubGlobal("fetch", fetch);
  const card = { elements: [{ tag: "div", text: { tag: "plain_text", content: "hello" } }] };
  const original = structuredClone(card);
  const client = new LarkWebhookClient("https://example.com/webhook", "test-signing-key");
  await expect(client.sendCard(card)).resolves.toEqual({ ok: true });
  const timestamp = String(Math.floor(Date.now() / 1000));
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
    msg_type: "interactive",
    card,
    timestamp,
    sign: createHmac("sha256", `${timestamp}\ntest-signing-key`).update("").digest("base64"),
  });
  expect(card).toEqual(original);
  expect(fetch).toHaveBeenCalledOnce();
});
