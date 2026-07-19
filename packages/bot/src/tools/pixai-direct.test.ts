import type { Api } from "grammy";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PixAIRateLimiter } from "../services/pixai-rate-limiter.js";
import { PixAIClient } from "./pixai.js";
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
});
