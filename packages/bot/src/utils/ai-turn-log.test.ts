import { describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { createAiTurnLogger } from "./ai-turn-log.js";

describe("AI turn diagnostics", () => {
  it("preserves correlated provider errors, counters and content while masking credentials", () => {
    const sink = vi.fn();
    const log = createAiTurnLogger(sink, { chatId: 1, messageId: 2 }, ["provider-secret"]);
    const error = Object.assign(
      new Error("rejected provider-secret", { cause: new Error("upstream") }),
      {
        statusCode: 429,
        responseBody: '{"error":"quota exceeded"}',
        headers: { authorization: "Bearer provider-secret" },
      },
    );
    log({
      level: "debug",
      message: "AI request",
      meta: { inputTokens: 123, text: "complete input" },
    });
    log({ level: "error", message: "AI reply failed", meta: { error } });
    const request = sink.mock.calls[0]![0];
    const failure = sink.mock.calls[1]![0];
    expect(failure.meta.correlationId).toBe(request.meta.correlationId);
    expect(request.meta).toMatchObject({
      chatId: 1,
      messageId: 2,
      inputTokens: 123,
      text: "complete input",
    });
    expect(failure.meta.error).toMatchObject({
      statusCode: 429,
      responseBody: '{"error":"quota exceeded"}',
      stack: expect.any(String),
      cause: { message: "upstream" },
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain("provider-secret");
    log({ level: "info", message: "finished" });
    expect(Object.keys(sink.mock.calls[2]![0].meta).sort()).toEqual([
      "chatId",
      "correlationId",
      "messageId",
    ]);
  });

  it("does not let a failed diagnostic sink mask the original operation", async () => {
    expect(() =>
      createAiTurnLogger(() => {
        throw new Error("offline");
      }, {})({ level: "error", message: "failure" }),
    ).not.toThrow();
    createAiTurnLogger(async () => {
      throw new Error("offline");
    }, {})({ level: "error", message: "failure" });
    await Promise.resolve();
  });
  it("retains structured transport context beyond a truncated request prefix", () => {
    const sink = vi.fn();
    const secret = "sensitive-provider-key";
    const error = new APICallError({
      message: "x".repeat(990) + secret,
      url: "https://example.test/v1?key=" + secret,
      requestBodyValues: { messages: Array.from({ length: 10 }, () => "x".repeat(20_000)) },
      statusCode: 429,
      responseBody: '{"error":{"code":"quota"}}',
      responseHeaders: { "x-request-id": "req-1" },
    });
    createAiTurnLogger(sink, { chatId: 1 }, [secret])({
      level: "error",
      message: "failed",
      meta: {
        error,
        model: "model-a",
        providerId: "provider-a",
        providerFormat: "openai",
        stage: "model",
      },
    });
    const meta = sink.mock.calls[0]![0].meta;
    expect(meta).toMatchObject({
      truncated: true,
      model: "model-a",
      providerId: "provider-a",
      providerFormat: "openai",
      stage: "model",
      errorSummary: { statusCode: 429, code: "quota", requestId: "req-1" },
    });
    expect(JSON.stringify(meta)).not.toContain(secret);
    expect(meta.errorSummary.message).not.toContain("sensitive");
  });
});
