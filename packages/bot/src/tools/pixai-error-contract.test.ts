import type { Api } from "grammy";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PixAIGenerationRecord } from "@cos-tool-bot/shared";
import {
  handlePixAIBackgroundFailure,
  isTerminalPixAIRecoveryError,
  isTerminalPixAITaskError,
  PixAIClient,
  PixAIRecoveryTerminalError,
  PixAITaskTerminalError,
} from "./pixai.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PixAI terminal error contract", () => {
  test("uses stable discriminants instead of message text", () => {
    expect(isTerminalPixAITaskError(new PixAITaskTerminalError("failed", "new wording"))).toBe(
      true,
    );
    expect(
      isTerminalPixAIRecoveryError(new PixAIRecoveryTerminalError("task-not-found", "new wording")),
    ).toBe(true);
    expect(isTerminalPixAITaskError(new Error("PixAI task failed: old wording"))).toBe(false);
    expect(
      isTerminalPixAIRecoveryError(
        new Error("PixAI GraphQL get task failed: HTTP 404 old wording"),
      ),
    ).toBe(false);
  });

  test("keeps recovery-only terminal errors pending in the live background handler", async () => {
    const sendMessage = vi.fn();
    const onGenerationTrack = vi.fn();
    const onLog = vi.fn();

    await handlePixAIBackgroundFailure(
      new PixAIRecoveryTerminalError("completed-without-images", "no usable output"),
      {
        api: { sendMessage } as unknown as Api,
        chatId: 123,
        baseRecord: baseRecord(),
        startTime: Date.now(),
        logPrefix: "PixAI background task",
        onGenerationTrack,
        onLog,
      },
    );

    expect(onGenerationTrack).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("leaving task pending") }),
    );
  });

  test.each(["graphql", "rest"] as const)(
    "%s HTTP 404 produces a recovery-only terminal error",
    async (apiMode) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("gone", { status: 404 })));
      const client = new PixAIClient("key", apiMode);

      const error = await client.pollUntilComplete("task-1", 0, 1, 0).catch((err) => err);

      expect(error).toMatchObject({
        pixaiErrorKind: "recovery-terminal",
        reason: "task-not-found",
      });
      expect(isTerminalPixAIRecoveryError(error)).toBe(true);
      expect(isTerminalPixAITaskError(error)).toBe(false);
    },
  );

  test("an empty GraphQL task response produces a recovery-only terminal error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { task: null } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const client = new PixAIClient("key", "graphql");

    const error = await client.pollUntilComplete("task-1", 0, 1, 0).catch((err) => err);

    expect(error).toMatchObject({
      pixaiErrorKind: "recovery-terminal",
      reason: "empty-task-response",
    });
  });

  test("a completed task without images produces a recovery-only terminal error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "task-1", status: "completed", outputs: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const client = new PixAIClient("key", "rest");

    const error = await client.pollUntilComplete("task-1", 0, 1, 0).catch((err) => err);

    expect(error).toMatchObject({
      pixaiErrorKind: "recovery-terminal",
      reason: "completed-without-images",
    });
  });

  test.each([401, 503])("HTTP %s remains retryable", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("failure", { status })));
    const client = new PixAIClient("key", "graphql");

    const error = await client.pollUntilComplete("task-1", 0, 1, 0).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(isTerminalPixAIRecoveryError(error)).toBe(false);
  });

  test("does not infer not-found from GraphQL error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ errors: [{ message: "task not found" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const client = new PixAIClient("key", "graphql");

    const error = await client.pollUntilComplete("task-1", 0, 1, 0).catch((err) => err);

    expect(isTerminalPixAIRecoveryError(error)).toBe(false);
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
