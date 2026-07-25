import { GrammyError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { markdownToTelegramHtml } from "../utils/format.js";
import { md2tgCommand } from "./md2tg.js";

vi.mock("../utils/format.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/format.js")>();
  return { ...actual, markdownToTelegramHtml: vi.fn(actual.markdownToTelegramHtml) };
});

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
    command: { name: "md2tg", args: [], original_msg: originalMsg },
    reply_to_message,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as WrapperContext;
}

async function run(ctx: WrapperContext) {
  if (typeof md2tgCommand !== "function") throw new Error("Expected command middleware");
  await md2tgCommand(ctx as never, vi.fn());
}

describe("md2tgCommand", () => {
  afterEach(() => {
    vi.mocked(markdownToTelegramHtml).mockClear();
  });

  it("shows usage when there is no input", async () => {
    const ctx = context();
    await run(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("用法"));
  });

  it("converts inline markdown and replies with HTML parse mode", async () => {
    const ctx = context({ originalMsg: "**bold** and `code`" });
    await run(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("<b>bold</b>"), {
      parse_mode: "HTML",
    });
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("<code>code</code>"), {
      parse_mode: "HTML",
    });
  });

  it("converts the replied-to message text when no inline text is given", async () => {
    const ctx = context({ replyText: "*italic*" });
    await run(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("<i>italic</i>"), {
      parse_mode: "HTML",
    });
  });

  it("prefers inline text over the replied-to message", async () => {
    const ctx = context({ originalMsg: "**inline**", replyText: "**reply**" });
    await run(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("<b>inline</b>"), {
      parse_mode: "HTML",
    });
  });

  it("falls back to plain text when Telegram rejects the HTML", async () => {
    const ctx = context({ originalMsg: "**bold**" });
    const grammyError = new GrammyError(
      "Bad Request",
      { ok: false, error_code: 400, description: "can't parse entities" },
      "sendMessage",
      {},
    );
    vi.mocked(ctx.reply)
      .mockRejectedValueOnce(grammyError)
      .mockResolvedValueOnce({} as never);

    await run(ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(ctx.reply).toHaveBeenLastCalledWith(expect.stringContaining("**bold**"));
    expect(ctx.reply).toHaveBeenLastCalledWith(expect.stringContaining("富文本发送失败"));
  });

  it("reports a readable error when conversion throws", async () => {
    vi.mocked(markdownToTelegramHtml).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const ctx = context({ originalMsg: "whatever" });
    await run(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("转换失败"));
  });
});
