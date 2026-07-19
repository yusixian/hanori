import type { Api } from "grammy";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PixAIRateLimiter } from "../services/pixai-rate-limiter.js";
import { PixAIClient, PixAITaskTerminalError } from "./pixai.js";
import { directPixAIGenerate } from "./pixai-direct.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("directPixAIGenerate", () => {
  test("reserves the active slot while pending persistence is blocked", async () => {
    vi.spyOn(PixAIClient.prototype, "createTask").mockResolvedValue({
      id: "task-1",
      status: "pending",
    });
    vi.spyOn(PixAIClient.prototype, "pollUntilComplete").mockImplementation(
      () => new Promise(() => {}),
    );
    let releasePersistence!: () => void;
    const onGenerationTrack = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePersistence = resolve;
        }),
    );
    const rateLimiter = new PixAIRateLimiter({
      maxConcurrentTasks: 1,
      userCooldownSec: 0,
      chatCooldownSec: 0,
    });
    const api = { sendMessage: vi.fn() } as unknown as Api;

    const generating = directPixAIGenerate(
      "prompt",
      {},
      {
        getImageGenConfig: () => ({ provider: "pixai", apiKey: "key" }),
        api,
        chatId: 123,
        userId: 456,
        recentBotMessageIds: [],
        onGenerationTrack,
        rateLimiter,
      },
    );

    await vi.waitFor(() => expect(onGenerationTrack).toHaveBeenCalledOnce());
    expect(rateLimiter.getStats().active).toBe(1);
    expect(rateLimiter.check(789, 101, false)).toMatchObject({
      allowed: false,
      reason: "concurrent_full",
    });

    releasePersistence();
    await expect(generating).resolves.toMatchObject({ ok: true, taskId: "task-1" });
  });

  test("keeps retryable polling failures pending", async () => {
    vi.spyOn(PixAIClient.prototype, "createTask").mockResolvedValue({
      id: "task-1",
      status: "pending",
    });
    vi.spyOn(PixAIClient.prototype, "pollUntilComplete").mockRejectedValue(
      new Error("PixAI GraphQL get task failed: HTTP 401 unauthorized"),
    );
    const onGenerationTrack = vi.fn().mockResolvedValue(undefined);
    const onLog = vi.fn().mockResolvedValue(undefined);
    const api = { sendMessage: vi.fn() } as unknown as Api;

    await expect(
      directPixAIGenerate(
        "prompt",
        {},
        {
          getImageGenConfig: () => ({ provider: "pixai", apiKey: "key" }),
          api,
          chatId: 123,
          recentBotMessageIds: [],
          onGenerationTrack,
          onLog,
        },
      ),
    ).resolves.toMatchObject({ ok: true, taskId: "task-1" });

    await vi.waitFor(() =>
      expect(onLog).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("leaving task pending") }),
      ),
    );
    expect(onGenerationTrack).toHaveBeenCalledOnce();
    expect(onGenerationTrack).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  test("does not notify when the direct path loses a terminal failure claim", async () => {
    vi.spyOn(PixAIClient.prototype, "createTask").mockResolvedValue({
      id: "task-1",
      status: "pending",
    });
    vi.spyOn(PixAIClient.prototype, "pollUntilComplete").mockRejectedValue(
      new PixAITaskTerminalError("failed", "PixAI task failed: rejected"),
    );
    const onGenerationTrack = vi.fn().mockImplementation(async (record) => {
      if (record.status === "failed") throw new Error("already claimed");
    });
    const onLog = vi.fn().mockResolvedValue(undefined);
    const api = { sendMessage: vi.fn() } as unknown as Api;

    await expect(
      directPixAIGenerate(
        "prompt",
        {},
        {
          getImageGenConfig: () => ({ provider: "pixai", apiKey: "key" }),
          api,
          chatId: 123,
          recentBotMessageIds: [],
          onGenerationTrack,
          onLog,
        },
      ),
    ).resolves.toMatchObject({ ok: true, taskId: "task-1" });

    await vi.waitFor(() =>
      expect(onLog).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("already claimed") }),
      ),
    );
    expect(onGenerationTrack).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
