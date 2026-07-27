import type { Tool } from "ai";
import type { Api } from "grammy";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PixAIGenerationRecord } from "@cos-tool-bot/shared";
import type { NsfwChecker } from "../services/nsfw-checker.js";
import {
  handlePixAIBackgroundFailure,
  createPixAITool,
  PixAIClient,
  PixAIGenerationPersistenceError,
  PixAITaskTerminalError,
  pollAndSend,
  recoverPixAIGeneration,
  trackPendingGeneration,
} from "./pixai.js";

interface ExecutableImageTool {
  execute: (input: { prompt: string }) => Promise<unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PixAI task logging", () => {
  test("logs prompt length without persisting generation prompts", async () => {
    const createTask = vi.spyOn(PixAIClient.prototype, "createTask").mockResolvedValue({
      id: "task-1",
      status: "pending",
    });
    const pollUntilComplete = vi
      .spyOn(PixAIClient.prototype, "pollUntilComplete")
      .mockImplementation(() => new Promise(() => {}));
    const onLog = vi.fn();
    const prompt = "confidential image prompt";
    const tools = createPixAITool({
      config: { provider: "pixai", apiKey: "key" },
      api: { sendMessage: vi.fn() } as unknown as Api,
      chatId: 123,
      userId: 456,
      recentBotMessageIds: [],
      onGenerationTrack: vi.fn().mockResolvedValue(undefined),
      onLog,
    });

    await (tools.generate_image as Tool as unknown as ExecutableImageTool).execute({ prompt });

    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("PixAI task created"),
        meta: expect.objectContaining({ promptLength: prompt.length }),
      }),
    );
    expect(JSON.stringify(onLog.mock.calls)).not.toContain(prompt);
    createTask.mockRestore();
    pollUntilComplete.mockRestore();
  });
});

describe("PixAI recovery", () => {
  test("queries an existing task immediately even when the polling budget is exhausted", async () => {
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
    await expect(client.pollUntilComplete("task-1", 0, 10, 0)).resolves.toEqual({
      urls: ["https://example.com/image.png"],
      mediaIds: [],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });

  test("uses only the timeout remaining since the task was created", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
    const poll = vi.spyOn(PixAIClient.prototype, "pollUntilComplete").mockResolvedValue({
      urls: ["https://example.com/image.png"],
      mediaIds: [],
    });
    const api = {
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 42 }),
    } as unknown as Api;

    await recoverPixAIGeneration({
      apiKey: "key",
      api,
      record: { ...baseRecord(), status: "pending" },
      timeoutMs: 60_000,
      createdAtMs: Date.now() - 45_000,
    });

    expect(poll).toHaveBeenCalledWith("task-1", 15_000, 5000, 0, undefined);
    poll.mockRestore();
    vi.useRealTimers();
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

describe("PixAI background failure handling", () => {
  test("leaves retryable HTTP failures pending", async () => {
    const harness = backgroundFailureHarness();

    await handlePixAIBackgroundFailure(
      new Error("PixAI GraphQL get task failed: HTTP 401 unauthorized"),
      harness.options,
    );

    expect(harness.onGenerationTrack).not.toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("leaving task pending for recovery"),
      }),
    );
  });

  test("does not notify after losing the terminal failure claim", async () => {
    const onGenerationTrack = vi.fn().mockRejectedValue(new Error("already claimed"));
    const harness = backgroundFailureHarness(onGenerationTrack);

    await handlePixAIBackgroundFailure(
      new PixAITaskTerminalError("failed", "PixAI task failed: rejected"),
      harness.options,
    );

    expect(onGenerationTrack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorMessage: "PixAI task failed: rejected" }),
    );
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.onLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("already claimed") }),
    );
  });

  test("persists and notifies for a terminal timeout when the claim succeeds", async () => {
    const harness = backgroundFailureHarness();

    await handlePixAIBackgroundFailure(
      new PixAITaskTerminalError("timeout", "PixAI task timed out after 300s"),
      harness.options,
    );

    expect(harness.onGenerationTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorMessage: "PixAI task timed out after 300s",
      }),
    );
    expect(harness.sendMessage).toHaveBeenCalledWith(
      123,
      "图片生成失败: PixAI task timed out after 300s",
    );
  });

  test("treats a missing tracking callback as ownership", async () => {
    const harness = backgroundFailureHarness();

    await handlePixAIBackgroundFailure(
      new PixAITaskTerminalError("cancelled", "PixAI task cancelled: user request"),
      { ...harness.options, onGenerationTrack: undefined },
    );

    expect(harness.sendMessage).toHaveBeenCalledOnce();
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

function backgroundFailureHarness(
  onGenerationTrack = vi.fn<(record: PixAIGenerationRecord) => Promise<void>>().mockResolvedValue(),
) {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
  const onLog = vi.fn();
  return {
    onGenerationTrack,
    onLog,
    sendMessage,
    options: {
      api: { sendMessage } as unknown as Api,
      chatId: 123,
      baseRecord: baseRecord(),
      startTime: Date.now(),
      logPrefix: "PixAI test task",
      onLog,
      onGenerationTrack,
    },
  };
}
