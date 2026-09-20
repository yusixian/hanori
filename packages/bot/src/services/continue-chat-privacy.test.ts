import type { UserPrivacyCallbacks } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { continueChat, fallbackExecutionLock, type ContinueChatConfig } from "./continue-chat.js";

describe("continueChat privacy", () => {
  it("includes continuation content in the bounded correlated diagnostic", async () => {
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

    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "continueChat triggered",
        meta: expect.objectContaining({ eventDescriptionLength: secretDescription.length }),
      }),
    );
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("continueChat failed:"),
        meta: expect.objectContaining({
          correlationId: expect.any(String),
          eventDescription: secretDescription,
        }),
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

  it("acquires max-one execution ownership before the privacy lock", async () => {
    const order: string[] = [];
    let executionOwned = false;
    const runWithExecution: NonNullable<ContinueChatConfig["runWithExecution"]> = async (
      _scope,
      operation,
    ) => {
      order.push("execution");
      expect(executionOwned).toBe(false);
      executionOwned = true;
      try {
        return await operation({
          signal: new AbortController().signal,
          isCurrent: () => true,
        });
      } finally {
        executionOwned = false;
      }
    };
    const privacy = {
      runExclusive: vi.fn(async (_userId: number, operation: () => Promise<boolean>) => {
        order.push("privacy");
        expect(executionOwned).toBe(true);
        return operation();
      }),
      getMode: vi.fn(async () => {
        order.push("mode");
        return "off" as const;
      }),
    } as unknown as UserPrivacyCallbacks;

    await continueChat({} as Api, { privacy, runWithExecution } as unknown as ContinueChatConfig, {
      chatId: 42,
      userId: 42,
      eventDescription: "timer fired",
    });

    expect(order).toEqual(["execution", "privacy", "mode"]);
    expect(executionOwned).toBe(false);
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
    const botId = "bot-a";
    const releaseLock = await fallbackExecutionLock.acquire(`${botId}:${chatId}`);
    const resolveSelection = vi.fn(() => ({ model: {} as never, modelId: "model-a" }));

    const continuation = continueChat(
      {} as Api,
      { botId, resolveSelection } as unknown as ContinueChatConfig,
      { chatId, userId: 42, eventDescription: "timer fired" },
    );
    await Promise.resolve();
    expect(resolveSelection).not.toHaveBeenCalled();

    releaseLock();
    await continuation;
    expect(resolveSelection).toHaveBeenCalledOnce();
  });
});
