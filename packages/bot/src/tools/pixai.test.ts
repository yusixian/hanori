import type { Api } from "grammy";
import { describe, expect, test, vi } from "vitest";
import type { PixAIGenerationRecord } from "@cos-tool-bot/shared";
import type { NsfwChecker } from "../services/nsfw-checker.js";
import {
  PixAIClient,
  PixAIGenerationPersistenceError,
  pollAndSend,
  trackPendingGeneration,
} from "./pixai.js";

describe("PixAI recovery", () => {
  test("can query an existing task immediately with a request timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "task-1",
          status: "completed",
          outputs: { mediaUrls: ["https://example.com/image.png"] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PixAIClient("key", "rest", 1000);
    await expect(client.pollUntilComplete("task-1", 1000, 10, 0)).resolves.toEqual({
      urls: ["https://example.com/image.png"],
      mediaIds: [],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });

  test("waits for the completed state to be persisted", async () => {
    const client = {
      pollUntilComplete: vi.fn().mockResolvedValue({
        urls: ["https://example.com/image.png"],
        mediaIds: ["media-1"],
      }),
    } as unknown as PixAIClient;
    const api = {
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 42 }),
    } as unknown as Api;
    let releasePersistence!: () => void;
    const onGenerationTrack = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePersistence = resolve;
        }),
    );
    let settled = false;

    const recovery = pollAndSend(
      client,
      "task-1",
      1000,
      {
        api,
        chatId: 123,
        recentBotMessageIds: [],
        prompt: "prompt",
        baseRecord: {
          chatId: 123,
          taskId: "task-1",
          prompt: "prompt",
          modelId: "model",
          width: 512,
          height: 512,
          batchSize: 1,
        },
        startTime: Date.now(),
        onGenerationTrack,
      },
      0,
    ).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(onGenerationTrack).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(api.sendPhoto).not.toHaveBeenCalled();

    releasePersistence();
    await recovery;
    expect(settled).toBe(true);
    expect(api.sendPhoto).toHaveBeenCalledOnce();
    expect(onGenerationTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        status: "completed",
        mediaUrls: ["https://example.com/image.png"],
      }),
    );
  });

  test("does not deliver when completed persistence fails", async () => {
    const client = {
      pollUntilComplete: vi.fn().mockResolvedValue({
        urls: ["https://example.com/image.png"],
        mediaIds: [],
      }),
    } as unknown as PixAIClient;
    const api = {
      sendPhoto: vi.fn(),
    } as unknown as Api;

    await expect(
      pollAndSend(
        client,
        "task-1",
        1000,
        {
          api,
          chatId: 123,
          recentBotMessageIds: [],
          prompt: "prompt",
          baseRecord: baseRecord(),
          startTime: Date.now(),
          onGenerationTrack: vi.fn().mockRejectedValue(new Error("database unavailable")),
        },
        0,
      ),
    ).rejects.toBeInstanceOf(PixAIGenerationPersistenceError);
    expect(api.sendPhoto).not.toHaveBeenCalled();
  });

  test("keeps completed state when Telegram delivery fails", async () => {
    const client = {
      pollUntilComplete: vi.fn().mockResolvedValue({
        urls: ["https://example.com/image.png"],
        mediaIds: [],
      }),
    } as unknown as PixAIClient;
    const api = {
      sendPhoto: vi.fn().mockRejectedValue(new Error("Telegram unavailable")),
    } as unknown as Api;
    const onGenerationTrack = vi.fn().mockResolvedValue(undefined);
    const onLog = vi.fn();

    await expect(
      pollAndSend(
        client,
        "task-1",
        1000,
        {
          api,
          chatId: 123,
          recentBotMessageIds: [],
          prompt: "prompt",
          baseRecord: baseRecord(),
          startTime: Date.now(),
          onGenerationTrack,
          onLog,
        },
        0,
      ),
    ).resolves.toBeUndefined();
    expect(onGenerationTrack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Telegram delivery failed") }),
    );
  });

  test("continues after pending persistence fails", async () => {
    const onLog = vi.fn();
    await expect(
      trackPendingGeneration(
        { ...baseRecord(), status: "pending" },
        vi.fn().mockRejectedValue(new Error("database unavailable")),
        onLog,
      ),
    ).resolves.toBeUndefined();
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("pending PixAI task") }),
    );
  });

  test("cancels recovery polling before the next request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort(new Error("bot stopped"));

    const client = new PixAIClient("key", "rest", 1000);
    await expect(
      client.pollUntilComplete("task-1", 1000, 10, 10, controller.signal),
    ).rejects.toThrow("bot stopped");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test("does not persist or deliver when recovery is cancelled after polling", async () => {
    const controller = new AbortController();
    const client = {
      pollUntilComplete: vi.fn().mockImplementation(async () => {
        controller.abort(new Error("bot stopped"));
        return { urls: ["https://example.com/image.png"], mediaIds: [] };
      }),
    } as unknown as PixAIClient;
    const api = { sendPhoto: vi.fn() } as unknown as Api;
    const onGenerationTrack = vi.fn();

    await expect(
      pollAndSend(
        client,
        "task-1",
        1000,
        {
          api,
          chatId: 123,
          recentBotMessageIds: [],
          prompt: "prompt",
          baseRecord: baseRecord(),
          startTime: Date.now(),
          onGenerationTrack,
          signal: controller.signal,
        },
        0,
      ),
    ).rejects.toThrow("bot stopped");
    expect(onGenerationTrack).not.toHaveBeenCalled();
    expect(api.sendPhoto).not.toHaveBeenCalled();
  });

  test("does not persist or deliver when recovery is cancelled during NSFW checks", async () => {
    const controller = new AbortController();
    const client = {
      pollUntilComplete: vi.fn().mockResolvedValue({
        urls: ["https://example.com/image.png"],
        mediaIds: [],
      }),
    } as unknown as PixAIClient;
    const api = { sendPhoto: vi.fn() } as unknown as Api;
    const onGenerationTrack = vi.fn();
    const nsfwChecker = {
      checkImageUrls: vi.fn().mockImplementation(async () => {
        controller.abort(new Error("bot stopped"));
        return { isNsfw: false, scores: [] };
      }),
    } as unknown as NsfwChecker;

    await expect(
      pollAndSend(
        client,
        "task-1",
        1000,
        {
          api,
          chatId: 123,
          recentBotMessageIds: [],
          prompt: "prompt",
          baseRecord: baseRecord(),
          startTime: Date.now(),
          onGenerationTrack,
          nsfwChecker,
          signal: controller.signal,
        },
        0,
      ),
    ).rejects.toThrow("bot stopped");
    expect(onGenerationTrack).not.toHaveBeenCalled();
    expect(api.sendPhoto).not.toHaveBeenCalled();
  });

  test("finishes delivery when cancellation happens after persistence starts", async () => {
    const controller = new AbortController();
    const client = {
      pollUntilComplete: vi.fn().mockResolvedValue({
        urls: ["https://example.com/image.png"],
        mediaIds: [],
      }),
    } as unknown as PixAIClient;
    const api = {
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 42 }),
    } as unknown as Api;
    const onGenerationTrack = vi.fn().mockImplementation(async () => {
      controller.abort(new Error("bot stopped"));
    });

    await expect(
      pollAndSend(
        client,
        "task-1",
        1000,
        {
          api,
          chatId: 123,
          recentBotMessageIds: [],
          prompt: "prompt",
          baseRecord: baseRecord(),
          startTime: Date.now(),
          onGenerationTrack,
          signal: controller.signal,
        },
        0,
      ),
    ).resolves.toBeUndefined();
    expect(api.sendPhoto).toHaveBeenCalledOnce();
  });
});

function baseRecord(): Omit<PixAIGenerationRecord, "status"> {
  return {
    chatId: 123,
    taskId: "task-1",
    prompt: "prompt",
    modelId: "model",
    width: 512,
    height: 512,
    batchSize: 1,
  };
}
