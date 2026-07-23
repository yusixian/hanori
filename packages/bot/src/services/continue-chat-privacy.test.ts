import type { UserPrivacyCallbacks } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { continueChat, type ContinueChatConfig } from "./continue-chat.js";

describe("continueChat privacy", () => {
  it("rechecks timer ownership under the user privacy lock and skips off users", async () => {
    const getMode = vi.fn().mockResolvedValue("off");
    const runExclusive = vi.fn(async (_userId: number, operation: () => Promise<void>) =>
      operation(),
    );
    const privacy = {
      getMode,
      runExclusive,
    } as unknown as UserPrivacyCallbacks;
    const onLog = vi.fn();

    await continueChat({} as Api, { privacy, onLog } as unknown as ContinueChatConfig, {
      chatId: 42,
      userId: 42,
      eventDescription: "timer fired",
    });

    expect(runExclusive).toHaveBeenCalledWith(42, expect.any(Function));
    expect(getMode).toHaveBeenCalledWith(42);
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Personalized continuation skipped because personalization is off",
      }),
    );
  });

  it("fails closed for an ownerless private continuation", async () => {
    const privacy = {
      getMode: vi.fn(),
      runExclusive: vi.fn(),
    } as unknown as UserPrivacyCallbacks;
    const onLog = vi.fn();

    await continueChat({} as Api, { privacy, onLog } as unknown as ContinueChatConfig, {
      chatId: 42,
      eventDescription: "legacy event",
    });

    expect(privacy.getMode).not.toHaveBeenCalled();
    expect(privacy.runExclusive).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Ownerless private continuation skipped because privacy cannot be evaluated",
      }),
    );
  });
});
