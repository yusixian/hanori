import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BotPool } from "../services/bot-pool.js";
import { botDebugRoutes } from "./bot-debug.js";

describe("bot debugger Rich Message route", () => {
  it("strictly sends the requested Telegram Rich Message", async () => {
    const sendRichMessage = vi.fn().mockResolvedValue({
      messageId: 91,
      chatId: 123,
      format: "markdown",
    });
    const app = new Hono().route(
      "/bots",
      botDebugRoutes({ sendRichMessage } as unknown as BotPool),
    );

    const response = await app.request("/bots/bot-1/debug/rich-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "123", format: "markdown", content: "# Hello" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { messageId: 91, chatId: 123, format: "markdown" },
    });
    expect(sendRichMessage).toHaveBeenCalledWith("bot-1", 123, "markdown", "# Hello");
  });

  it("rejects invalid chat IDs before delivery", async () => {
    const sendRichMessage = vi.fn();
    const app = new Hono().route(
      "/bots",
      botDebugRoutes({ sendRichMessage } as unknown as BotPool),
    );

    const response = await app.request("/bots/bot-1/debug/rich-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "chat", format: "html", content: "<h1>Hello</h1>" }),
    });

    expect(response.status).toBe(400);
    expect(sendRichMessage).not.toHaveBeenCalled();
  });

  it("returns the strict Telegram delivery error without a fallback", async () => {
    const sendRichMessage = vi.fn().mockRejectedValue(new Error("Bad Request: invalid rich HTML"));
    const app = new Hono().route(
      "/bots",
      botDebugRoutes({ sendRichMessage } as unknown as BotPool),
    );

    const response = await app.request("/bots/bot-1/debug/rich-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "-100123", format: "html", content: "<details>" }),
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Bad Request: invalid rich HTML");
    expect(sendRichMessage).toHaveBeenCalledOnce();
  });
});
