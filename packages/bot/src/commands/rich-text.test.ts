import { describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { createRichTextCommand } from "./rich-text.js";

function context(match = "") {
  return {
    match,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as WrapperContext;
}

describe("createRichTextCommand", () => {
  it("reports the global state without changing it", async () => {
    const ctx = context();
    const setEnabled = vi.fn();
    const command = createRichTextCommand({ getEnabled: () => true, setEnabled });

    if (typeof command !== "function") throw new Error("Expected command middleware");
    await command(ctx as never, vi.fn());

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("当前已开启"));
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("persists the requested state before confirming", async () => {
    const ctx = context("off");
    const setEnabled = vi.fn().mockResolvedValue(undefined);
    const command = createRichTextCommand({ getEnabled: () => true, setEnabled });

    if (typeof command !== "function") throw new Error("Expected command middleware");
    await command(ctx as never, vi.fn());

    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("已全局关闭"));
  });

  it("exposes persistence failures instead of claiming success", async () => {
    const ctx = context("on");
    const command = createRichTextCommand({
      getEnabled: () => false,
      setEnabled: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });

    if (typeof command !== "function") throw new Error("Expected command middleware");
    await command(ctx as never, vi.fn());

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("database unavailable"));
  });
});
