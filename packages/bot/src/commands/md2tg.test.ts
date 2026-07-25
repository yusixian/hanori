import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { sendMarkdownWithFallback } from "../utils/rich-message.js";
import { createMd2tgCommand } from "./md2tg.js";

vi.mock("../utils/rich-message.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/rich-message.js")>();
  return { ...actual, sendMarkdownWithFallback: vi.fn() };
});

function mockDelivery(mode: "rich" | "html" | "plain") {
  vi.mocked(sendMarkdownWithFallback).mockResolvedValue({
    mode,
    message: {},
  } as never);
}

function context({
  originalMsg = "",
  replyText,
  replyCaption,
}: {
  originalMsg?: string;
  replyText?: string;
  replyCaption?: string;
} = {}) {
  const reply_to_message =
    replyText !== undefined || replyCaption !== undefined
      ? { text: replyText, caption: replyCaption }
      : undefined;
  return {
    chat: { id: -100 },
    api: {},
    command: { name: "md2tg", args: [], original_msg: originalMsg },
    reply_to_message,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as WrapperContext;
}

async function run(ctx: WrapperContext, config?: { getRichMessageEnabled?: () => boolean }) {
  const command = createMd2tgCommand(config ?? {});
  if (typeof command !== "function") throw new Error("Expected command middleware");
  await command(ctx as never, vi.fn());
}

describe("createMd2tgCommand", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows usage when there is no input", async () => {
    const ctx = context();
    await run(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("用法"));
    expect(sendMarkdownWithFallback).not.toHaveBeenCalled();
  });

  it("delivers inline markdown through the shared pipeline", async () => {
    mockDelivery("html");
    const ctx = context({ originalMsg: "**bold**" });
    await run(ctx);

    expect(sendMarkdownWithFallback).toHaveBeenCalledWith(
      (ctx as never as { api: unknown }).api,
      -100,
      "**bold**",
      false,
    );
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("uses the replied-to message text when no inline text is given", async () => {
    mockDelivery("html");
    const ctx = context({ replyText: "*italic*" });
    await run(ctx);

    expect(sendMarkdownWithFallback).toHaveBeenCalledWith(
      expect.anything(),
      -100,
      "*italic*",
      false,
    );
  });

  it("prefers inline text over the replied-to message", async () => {
    mockDelivery("html");
    const ctx = context({ originalMsg: "**inline**", replyText: "**reply**" });
    await run(ctx);

    expect(sendMarkdownWithFallback).toHaveBeenCalledWith(
      expect.anything(),
      -100,
      "**inline**",
      false,
    );
  });

  it("passes the global rich message setting to the pipeline", async () => {
    mockDelivery("rich");
    const ctx = context({ originalMsg: "| a | b |\n| - | - |\n| 1 | 2 |" });
    await run(ctx, { getRichMessageEnabled: () => true });

    expect(sendMarkdownWithFallback).toHaveBeenCalledWith(
      expect.anything(),
      -100,
      expect.any(String),
      true,
    );
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("warns when rich content fell back to plain text", async () => {
    mockDelivery("plain");
    const ctx = context({ originalMsg: "**bold**" });
    await run(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("回退为原文"));
  });

  it("stays silent when plain input is delivered as plain text", async () => {
    mockDelivery("plain");
    const ctx = context({ originalMsg: "just some words" });
    await run(ctx);

    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
