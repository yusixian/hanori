import { describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { createQuotaCommand } from "./quota.js";

function groupContext(match: string) {
  return {
    chat: { id: -100, type: "supergroup" },
    from: { id: 42 },
    match,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as WrapperContext;
}

describe("/quota set parsing", () => {
  it("parses a per-user image ceiling with the optional cooldown", async () => {
    const tighten = vi.fn().mockResolvedValue({ ok: true });
    const command = createQuotaCommand({ getUsage: vi.fn(), tighten });
    const ctx = groupContext("set image user 777 4 12 90");
    if (typeof command !== "function") throw new Error("Expected command middleware function");

    await command(ctx as never, vi.fn());

    expect(tighten).toHaveBeenCalledWith({
      chatId: -100,
      actorUserId: 42,
      resource: "image",
      targetUserId: 777,
      hourly: 4,
      daily: 12,
      cooldownSeconds: 90,
    });
    expect(ctx.reply).toHaveBeenCalledWith("群聊限流已收紧并立即生效。");
  });

  it("parses a group AI ceiling without inventing a target user or cooldown", async () => {
    const tighten = vi.fn().mockResolvedValue({ ok: true });
    const command = createQuotaCommand({ getUsage: vi.fn(), tighten });
    const ctx = groupContext("set ai group 20 100");
    if (typeof command !== "function") throw new Error("Expected command middleware function");

    await command(ctx as never, vi.fn());

    expect(tighten).toHaveBeenCalledWith({
      chatId: -100,
      actorUserId: 42,
      resource: "ai_reply",
      targetUserId: undefined,
      hourly: 20,
      daily: 100,
      cooldownSeconds: undefined,
    });
  });

  it("rejects malformed numeric limits before calling the policy writer", async () => {
    const tighten = vi.fn().mockResolvedValue({ ok: true });
    const command = createQuotaCommand({ getUsage: vi.fn(), tighten });
    const ctx = groupContext("set ai user 777 NaN 100");
    if (typeof command !== "function") throw new Error("Expected command middleware function");

    await command(ctx as never, vi.fn());

    expect(tighten).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("/quota set ai|image user"));
  });
});
