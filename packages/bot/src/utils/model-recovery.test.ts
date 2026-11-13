import { describe, expect, it, vi } from "vitest";
import { APICallError, generateText, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { createModelRecovery, type RecoverySelection } from "./model-recovery.js";
import { modelErrorSummary } from "./model-error-summary.js";

type Model = ReturnType<typeof createModelRecovery>["model"];
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const error = (statusCode = 503) =>
  new APICallError({
    message: "upstream failed",
    url: "https://example.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
  });
function selection(
  id: string,
  run: Model["doGenerate"],
  stream?: Model["doStream"],
): RecoverySelection {
  return {
    providerId: "provider",
    modelId: id,
    model: {
      specificationVersion: "v3",
      provider: "fake",
      modelId: id,
      supportedUrls: {},
      doGenerate: run,
      doStream: stream ?? vi.fn(),
    },
  };
}
const success: Awaited<ReturnType<Model["doGenerate"]>> = {
  content: [{ type: "text", text: "ok" }],
  finishReason: { unified: "stop", raw: "stop" },
  usage,
  warnings: [],
};
describe("model recovery request boundary", () => {
  it("shares retry budget then switches configured fallback without SDK multiplication", async () => {
    const primary = vi.fn(async () => {
      throw error();
    });
    const fallback = vi.fn(async () => success);
    const recovery = createModelRecovery({
      primary: selection("a", primary),
      fallback: selection("b", fallback),
      config: { maxRetries: 1, fallback: { providerId: "provider", modelId: "b" } },
    });
    expect(
      (await generateText({ model: recovery.model, prompt: "hello", maxRetries: 0 })).text,
    ).toBe("ok");
    expect(primary).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 403, 404, 422])("does not retry deterministic status %i", async (status) => {
    const run = vi.fn(async () => {
      throw error(status);
    });
    const recovery = createModelRecovery({ primary: selection("a", run) });
    await expect(
      generateText({ model: recovery.model, prompt: "hello", maxRetries: 0 }),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not loop into the same pair", async () => {
    const run = vi.fn(async () => {
      throw error();
    });
    const primary = selection("a", run);
    const recovery = createModelRecovery({
      primary,
      fallback: primary,
      config: { maxRetries: 0, fallback: { providerId: "provider", modelId: "a" } },
    });
    await expect(
      generateText({ model: recovery.model, prompt: "hello", maxRetries: 0 }),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("cancels during backoff without issuing another request", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      setTimeout(() => controller.abort(), 10);
      throw error();
    });
    const recovery = createModelRecovery({
      primary: selection("a", run),
      signal: controller.signal,
    });
    await expect(
      generateText({
        model: recovery.model,
        prompt: "hello",
        maxRetries: 0,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("preserves an already executed write tool when the next model request retries", async () => {
    const write = vi.fn(async (_input: { value: string }) => "saved");
    const run = vi
      .fn<Model["doGenerate"]>()
      .mockResolvedValueOnce({
        ...success,
        content: [
          { type: "tool-call", toolCallId: "one", toolName: "write", input: '{"value":"x"}' },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
      })
      .mockRejectedValueOnce(error())
      .mockResolvedValueOnce(success);
    const recovery = createModelRecovery({ primary: selection("a", run) });
    const result = await generateText({
      model: recovery.model,
      prompt: "write",
      maxRetries: 0,
      stopWhen: stepCountIs(3),
      tools: { write: tool({ inputSchema: z.object({ value: z.string() }), execute: write }) },
    });
    expect(result.text).toBe("ok");
    expect(write).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[2]![0].prompt).toEqual(run.mock.calls[1]![0].prompt);
  });
  it("repairs generated parameters without executing a tool during repair", async () => {
    const write = vi.fn(async (_input: { value: string }) => "saved");
    const call = (input: string) => ({
      ...success,
      content: [{ type: "tool-call" as const, toolCallId: "one", toolName: "write", input }],
      finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    });
    const run = vi
      .fn<Model["doGenerate"]>()
      .mockResolvedValueOnce(call('{"value":2}'))
      .mockResolvedValueOnce(call('{"value":"fixed"}'))
      .mockResolvedValueOnce(success);
    const recovery = createModelRecovery({ primary: selection("a", run) });
    await generateText({
      model: recovery.model,
      prompt: "write",
      maxRetries: 0,
      experimental_repairToolCall: recovery.repairToolCall,
      stopWhen: stepCountIs(3),
      tools: { write: tool({ inputSchema: z.object({ value: z.string() }), execute: write }) },
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toEqual({ value: "fixed" });
  });
  it.each([false, true])("SSE failure: partial output=%s", async (partial) => {
    const open = vi
      .fn<Model["doStream"]>()
      .mockImplementationOnce(async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            if (partial) {
              c.enqueue({ type: "text-start", id: "x" });
              c.enqueue({ type: "text-delta", id: "x", delta: "seen" });
            }
            c.enqueue({ type: "error", error: error() });
            c.close();
          },
        }),
      }))
      .mockImplementationOnce(async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "text-start", id: "x" });
            c.enqueue({ type: "text-delta", id: "x", delta: "ok" });
            c.enqueue({ type: "text-end", id: "x" });
            c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            c.close();
          },
        }),
      }));
    const recovery = createModelRecovery({ primary: selection("a", vi.fn(), open) });
    const errors: unknown[] = [];
    const result = streamText({
      model: recovery.model,
      prompt: "hi",
      maxRetries: 0,
      onError: ({ error }) => {
        errors.push(error);
      },
    });
    await result.consumeStream();
    expect(open).toHaveBeenCalledTimes(partial ? 1 : 2);
    expect(errors.length).toBe(partial ? 1 : 0);
  });
  it("keeps transport diagnostics outside oversized request bodies", () => {
    const failure = new APICallError({
      message: "secret failure",
      url: "https://example.test/v1/chat/completions?key=secret",
      requestBodyValues: { content: "x".repeat(100000) },
      statusCode: 500,
      responseBody: '{"error":{"code":"upstream_parse"}}',
      responseHeaders: { "x-request-id": "request-1" },
    });
    const summary = modelErrorSummary(failure, ["secret"]);
    expect(summary).toMatchObject({
      statusCode: 500,
      code: "upstream_parse",
      requestId: "request-1",
      endpoint: "https://example.test/v1/chat/completions",
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
  it.each([429, 500, 503])("recovers a transient HTTP %s", async (status) => {
    const run = vi
      .fn<Model["doGenerate"]>()
      .mockRejectedValueOnce(error(status))
      .mockResolvedValueOnce(success);
    const recovery = createModelRecovery({ primary: selection("a", run) });
    await generateText({ model: recovery.model, prompt: "hi", maxRetries: 0 });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("distinguishes upstream parameter parsing from deterministic schema rejection", async () => {
    const failure = new APICallError({
      message:
        "Failed to parse parameters from your message. Please update the message and try again.",
      url: "https://example.test",
      requestBodyValues: {},
      statusCode: 400,
    });
    const run = vi
      .fn<Model["doGenerate"]>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(success);
    const recovery = createModelRecovery({ primary: selection("a", run) });
    await generateText({ model: recovery.model, prompt: "hi", maxRetries: 0 });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("shares exhausted budget across requests and never returns to primary after fallback", async () => {
    const primary = vi
      .fn<Model["doGenerate"]>()
      .mockRejectedValueOnce(error())
      .mockResolvedValueOnce(success)
      .mockRejectedValue(error());
    const fallback = vi.fn<Model["doGenerate"]>().mockRejectedValue(error());
    const recovery = createModelRecovery({
      primary: selection("a", primary),
      fallback: selection("b", fallback),
      config: { maxRetries: 1, fallback: { providerId: "provider", modelId: "b" } },
    });
    await generateText({ model: recovery.model, prompt: "first", maxRetries: 0 });
    await expect(
      generateText({ model: recovery.model, prompt: "second", maxRetries: 0 }),
    ).rejects.toThrow();
    expect(primary).toHaveBeenCalledTimes(3);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
  it("tool repair consumes the same retry budget as subsequent model failures", async () => {
    const write = vi.fn(async (_input: { value: string }) => "saved");
    const call = (input: string) => ({
      ...success,
      content: [{ type: "tool-call" as const, toolCallId: "one", toolName: "write", input }],
      finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    });
    const run = vi
      .fn<Model["doGenerate"]>()
      .mockResolvedValueOnce(call('{"value":2}'))
      .mockResolvedValueOnce(call('{"value":"fixed"}'))
      .mockRejectedValue(error());
    const recovery = createModelRecovery({ primary: selection("a", run) });
    await expect(
      generateText({
        model: recovery.model,
        prompt: "write",
        maxRetries: 0,
        experimental_repairToolCall: recovery.repairToolCall,
        stopWhen: stepCountIs(3),
        tools: { write: tool({ inputSchema: z.object({ value: z.string() }), execute: write }) },
      }),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("does not open a retry after the stream consumer cancels during backoff", async () => {
    let reachedRetry!: () => void;
    const retrying = new Promise<void>((resolve) => {
      reachedRetry = resolve;
    });
    const open = vi.fn<Model["doStream"]>().mockImplementation(async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "error", error: error() });
          c.close();
        },
      }),
    }));
    const recovery = createModelRecovery({
      primary: selection("a", vi.fn(), open),
      onLog: (entry) => {
        if (entry.meta?.decision === "retry") reachedRetry();
      },
    });
    const result = await recovery.model.doStream({ prompt: [] });
    const reader = result.stream.getReader();
    const pending = reader.read();
    await retrying;
    await reader.cancel();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("does not replay a tool call already exposed before a streaming failure", async () => {
    const write = vi.fn(async (_input: { value: string }) => "saved");
    const open = vi.fn<Model["doStream"]>().mockImplementation(async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({
            type: "tool-call",
            toolCallId: "one",
            toolName: "write",
            input: '{"value":"x"}',
          });
          c.enqueue({ type: "error", error: error() });
          c.close();
        },
      }),
    }));
    const recovery = createModelRecovery({ primary: selection("a", vi.fn(), open) });
    const failures: unknown[] = [];
    const result = streamText({
      model: recovery.model,
      prompt: "write",
      maxRetries: 0,
      tools: { write: tool({ inputSchema: z.object({ value: z.string() }), execute: write }) },
      onError: ({ error }) => {
        failures.push(error);
      },
    });
    await result.consumeStream();
    expect(open).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(1);
  });
  it("records the actual model for each completed stream step across fallback", async () => {
    const complete = async () => ({
      stream: new ReadableStream<
        Awaited<ReturnType<Model["doStream"]>>["stream"] extends ReadableStream<infer T> ? T : never
      >({
        start(c) {
          c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
          c.close();
        },
      }),
    });
    const primary = vi
      .fn<Model["doStream"]>()
      .mockImplementationOnce(complete)
      .mockRejectedValue(error());
    const secondary = vi.fn<Model["doStream"]>().mockImplementation(complete);
    const recovery = createModelRecovery({
      primary: selection("a", vi.fn(), primary),
      fallback: selection("b", vi.fn(), secondary),
      config: { maxRetries: 0, fallback: { providerId: "provider", modelId: "b" } },
    });
    for (let i = 0; i < 2; i++) {
      const result = await recovery.model.doStream({ prompt: [] });
      await result.stream.pipeTo(new WritableStream());
    }
    expect(recovery.streamSelections.map((entry) => entry.modelId)).toEqual(["a", "b"]);
  });
  it("keeps primary stream attribution separate from a fallback-only tool repair and accounts for repair usage", async () => {
    const write = vi.fn(async (_input: { value: string }) => "saved");
    const open = vi.fn<Model["doStream"]>().mockImplementation(async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({
            type: "tool-call",
            toolCallId: "one",
            toolName: "write",
            input: '{"value":2}',
          });
          c.enqueue({
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage,
          });
          c.close();
        },
      }),
    }));
    const repair = vi.fn<Model["doGenerate"]>().mockResolvedValue({
      ...success,
      content: [
        {
          type: "tool-call",
          toolCallId: "repair",
          toolName: "write",
          input: '{"value":"fixed"}',
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    });
    const recovery = createModelRecovery({
      primary: selection("a", vi.fn(), open),
      fallback: selection("b", repair),
      config: { maxRetries: 0, fallback: { providerId: "provider", modelId: "b" } },
    });
    const result = streamText({
      model: recovery.model,
      prompt: "write",
      maxRetries: 0,
      experimental_repairToolCall: recovery.repairToolCall,
      tools: { write: tool({ inputSchema: z.object({ value: z.string() }), execute: write }) },
    });
    await result.consumeStream();
    expect(await result.steps).toHaveLength(1);
    expect(recovery.selection().modelId).toBe("b");
    expect(recovery.streamSelections.map((entry) => entry.modelId)).toEqual(["a"]);
    expect(recovery.repairUsages).toMatchObject([
      { selection: { modelId: "b" }, usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledTimes(1);
  });
  it("retries invalid repair data within the shared budget without executing it", async () => {
    const write = vi.fn(async (_input: { value: string }) => "saved");
    const call = (input: string) => ({
      ...success,
      content: [{ type: "tool-call" as const, toolCallId: "one", toolName: "write", input }],
      finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    });
    const run = vi
      .fn<Model["doGenerate"]>()
      .mockResolvedValueOnce(call('{"value":2}'))
      .mockResolvedValueOnce(call('{"value":3}'))
      .mockResolvedValueOnce(call('{"value":"fixed"}'))
      .mockResolvedValueOnce(success);
    const recovery = createModelRecovery({
      primary: selection("a", run),
      config: { maxRetries: 2, fallback: null },
    });
    await generateText({
      model: recovery.model,
      prompt: "write",
      maxRetries: 0,
      experimental_repairToolCall: recovery.repairToolCall,
      stopWhen: stepCountIs(3),
      tools: { write: tool({ inputSchema: z.object({ value: z.string() }), execute: write }) },
    });
    expect(run).toHaveBeenCalledTimes(4);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toEqual({ value: "fixed" });
    expect(recovery.repairUsages).toHaveLength(2);
  });
});
