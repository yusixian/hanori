import type { UserPrivacyMode } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { createPrivacyCommand, parsePrivacyAction } from "./privacy.js";

describe("parsePrivacyAction", () => {
  it("parses supported modes and the explicit forget confirmation", () => {
    expect(parsePrivacyAction("")).toEqual({ kind: "status" });
    expect(parsePrivacyAction("isolated")).toEqual({ kind: "set", mode: "isolated" });
    expect(parsePrivacyAction("forget")).toEqual({ kind: "forget", confirmed: false });
    expect(parsePrivacyAction("forget confirm")).toEqual({ kind: "forget", confirmed: true });
    expect(parsePrivacyAction("unknown")).toEqual({ kind: "help" });
  });
});

describe("/privacy", () => {
  function setup(match: string) {
    let mode: UserPrivacyMode = "normal";
    const replies: string[] = [];
    const waitForPendingProfileUpdate = vi.fn().mockResolvedValue(undefined);
    const forget = vi.fn().mockResolvedValue({
      conversationMessages: 3,
      profiles: 1,
      personalMemories: 2,
    });
    const command = createPrivacyCommand({
      getMode: vi.fn(async () => mode),
      runExclusive: vi.fn(async (_userId, operation) => operation()),
      setMode: vi.fn(async (_userId, nextMode) => {
        mode = nextMode;
      }),
      forget,
      waitForPendingProfileUpdate,
    });
    if (typeof command !== "function") throw new Error("Expected command middleware function");
    const ctx = {
      match,
      from: { id: 42 },
      reply: vi.fn(async (text: string) => {
        replies.push(text);
      }),
    };
    return { command, ctx, replies, forget, waitForPendingProfileUpdate };
  }

  it("requires an explicit second command before forgetting data", async () => {
    const pending = setup("forget");
    await pending.command(pending.ctx as never, vi.fn());
    expect(pending.forget).not.toHaveBeenCalled();
    expect(pending.replies[0]).toContain("/privacy forget confirm");

    const confirmed = setup("forget confirm");
    await confirmed.command(confirmed.ctx as never, vi.fn());
    expect(confirmed.waitForPendingProfileUpdate).toHaveBeenCalledWith(42);
    expect(confirmed.forget).toHaveBeenCalledWith(42);
    expect(confirmed.replies[0]).toContain("对话消息：3");
  });

  it("discloses that off does not remove messages from public group history", async () => {
    const test = setup("off");
    await test.command(test.ctx as never, vi.fn());
    expect(test.replies[0]).toContain("群消息仍属于共享群历史");
  });
});
