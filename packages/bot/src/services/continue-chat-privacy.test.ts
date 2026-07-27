import type { UserPrivacyCallbacks } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { acquireChatLock } from "./chat-lock.js";
import { continueChat, type ContinueChatConfig } from "./continue-chat.js";

describe("continueChat privacy", () => {
  it("does not persist the continuation event description in generic logs", async () => {
    const onLog = vi.fn();
    const secretDescription = "private timer reason that must not reach logs";

    await continueChat(
      {} as Api,
      {
        onLog,
        resolveSelection: () => ({ model: {} as never, modelId: "model-a" }),
      } as unknown as ContinueChatConfig,
      {
        chatId: -100,
        userId: 42,
        eventDescription: secretDescription,
      },
    );

    const serializedLogs = JSON.stringify(onLog.mock.calls);
    expect(serializedLogs).not.toContain(secretDescription);
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "continueChat triggered",
        meta: expect.objectContaining({ eventDescriptionLength: secretDescription.length }),
      }),
    );
  });

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

  it("rejects privacy and AI-disabled skips when reliable delivery is required", async () => {
    const privacy = {
      getMode: vi.fn().mockResolvedValue("off"),
      runExclusive: vi.fn(async (_userId: number, operation: () => Promise<void>) => operation()),
    } as unknown as UserPrivacyCallbacks;

    await expect(
      continueChat({} as Api, { privacy } as unknown as ContinueChatConfig, {
        chatId: 42,
        userId: 42,
        eventDescription: "timer fired",
        requireDelivery: true,
      }),
    ).rejects.toThrow("personalization is off");

    await expect(
      continueChat({} as Api, { isAiDisabled: () => true } as unknown as ContinueChatConfig, {
        chatId: -100,
        eventDescription: "rss digest",
        requireDelivery: true,
      }),
    ).rejects.toThrow("AI is disabled");
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

  it("resolves one selection snapshot only after acquiring the chat lock", async () => {
    const chatId = -200;
    const releaseLock = await acquireChatLock(chatId);
    const resolveSelection = vi.fn(() => ({ model: {} as never, modelId: "model-a" }));

    const continuation = continueChat(
      {} as Api,
      { resolveSelection } as unknown as ContinueChatConfig,
      { chatId, userId: 42, eventDescription: "timer fired" },
    );
    await Promise.resolve();
    expect(resolveSelection).not.toHaveBeenCalled();

    releaseLock();
    await continuation;
    expect(resolveSelection).toHaveBeenCalledOnce();
  });
});
