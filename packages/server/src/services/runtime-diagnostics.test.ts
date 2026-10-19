import { describe, expect, it, vi } from "vitest";
import { RuntimeDiagnostics } from "./runtime-diagnostics.js";

function setup(overrides: { maxTraces?: number; maxEvents?: number; retentionMs?: number } = {}) {
  let now = 100_000;
  const audit = vi.fn(async (): Promise<void> => undefined);
  const service = new RuntimeDiagnostics({
    adminIds: [1],
    audit,
    secrets: ["live-secret"],
    now: () => now,
    ...overrides,
    runtime: async () => ({
      botStatus: "running",
      uptimeMs: 100,
      database: "reachable",
      redis: "not_configured",
      model: "unknown",
      telegram: "unknown",
      version: "unknown",
      environment: "test",
      startedAt: 0,
      checkedAt: now,
      rss: "unobserved",
      imageTasks: "unobserved",
      githubTasks: "unobserved",
      activeTimers: 0,
    }),
  });
  return {
    service,
    audit,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const actor = { chatId: -10, userId: 1, messageId: 20 };
describe("RuntimeDiagnostics", () => {
  it("retains a failed request for 24 hours by default without removing the capacity bound", async () => {
    const { service, advance } = setup();
    const traceId = service.startTrace(actor);
    service.record(traceId, { stage: "model", outcome: "failed", code: "model_timeout" });
    advance(23 * 60 * 60 * 1000);
    await expect(
      service.query(actor, { operation: "get_request_trace", traceId }),
    ).resolves.toMatchObject({
      ok: true,
      retentionMs: 86_400_000,
      traces: [{ traceId }],
    });
    advance(60 * 60 * 1000 + 1);
    await expect(
      service.query(actor, { operation: "get_request_trace", traceId }),
    ).resolves.toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("audits denials and fails closed when audit storage fails", async () => {
    const { service, audit } = setup();
    expect(
      await service.query({ ...actor, userId: 2 }, { operation: "query_sanitized_logs" }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "forbidden" }));
    audit.mockRejectedValueOnce(
      new Error("postgres://owner:live-secret@private/database", {
        cause: { password: "live-secret" },
      }),
    );
    await expect(service.query(actor, { operation: "query_sanitized_logs" })).rejects.toThrow(
      "Diagnostic audit unavailable",
    );
    audit.mockImplementationOnce(() => {
      throw new Error("postgres://owner:live-secret@private/database");
    });
    await expect(service.query(actor, { operation: "query_sanitized_logs" })).rejects.toThrow(
      "Diagnostic audit unavailable",
    );
    await expect(
      service.query(actor, { operation: "query_sanitized_logs" }),
    ).resolves.toMatchObject({ ok: true });
  });
  it("isolates Bots and chats and selects the previous message of the same user", async () => {
    const { service } = setup();
    const previous = service.startTrace({ ...actor, messageId: 18 });
    service.startTrace({ ...actor, userId: 2, messageId: 19 });
    const current = service.startTrace(actor);
    const foreign = service.startTrace({ ...actor, chatId: -20 });
    const response = await service.query(
      { ...actor, currentTraceId: current },
      { operation: "get_request_trace", previous: true },
    );
    expect(response.traces?.map((trace) => trace.traceId)).toEqual([previous]);
    expect(
      await service.query(actor, { operation: "get_request_trace", traceId: foreign }),
    ).toMatchObject({ code: "not_found" });
    expect(
      await setup().service.query(actor, { operation: "get_request_trace", traceId: previous }),
    ).toMatchObject({ code: "not_found" });
  });
  it("projects config and events using a strict whitelist and blocks known secrets", async () => {
    const { service } = setup();
    service.bindRuntime({
      effectiveConfig: () =>
        ({
          enabled: true,
          modelId: "live-secret",
          providerId: "https://secret",
          toolNames: ["search", "live-secret"],
          apiKey: "leak",
          token: "leak",
          cookie: "leak",
          privateKey: "leak",
          systemPrompt: "leak",
          baseURL: "https://private/?key=leak",
          headers: { Authorization: "leak" },
          filePath: "/private/secret",
          nested: { password: "leak" },
        }) as never,
      scheduler: () => ({ active: null, queued: null, asyncTasks: null }),
    });
    const config = await service.query(actor, { operation: "get_effective_config" });
    expect(JSON.stringify(config)).not.toMatch(/live-secret|https|apiKey|leak/);
    expect(config.config?.toolNames).toEqual(["search"]);
    const id = service.startTrace(actor);
    service.record(id, {
      stage: "tool",
      outcome: "failed",
      code: "live-secret",
      toolName: "live-secret",
      apiKey: "leak",
      error: { message: "leak", stack: "/private/secret", cause: { cookie: "leak" } },
      input: { prompt: "leak" },
      output: "leak",
      text: "leak",
      url: "https://private/?secret=leak",
    } as never);
    const response = await service.query(actor, { operation: "get_request_trace", traceId: id });
    expect(JSON.stringify(response)).not.toMatch(/live-secret|apiKey|leak/);
  });
  it("preserves provider-qualified model IDs and scopes recent observations", async () => {
    const { service, advance } = setup();
    service.bindRuntime({
      effectiveConfig: () => ({ enabled: true, modelId: "provider/model-v1.2" }),
      scheduler: () => ({ active: 1, queued: 0, asyncTasks: 0 }),
    });
    expect(
      (await service.query(actor, { operation: "get_effective_config" })).config?.modelId,
    ).toBe("provider/model-v1.2");
    const current = service.startTrace(actor);
    service.record(current, { stage: "model", outcome: "failed", code: "model_timeout" });
    advance(10);
    const foreign = service.startTrace({ ...actor, chatId: -99 });
    service.record(foreign, { stage: "model", outcome: "succeeded" });
    expect((await service.query(actor, { operation: "get_runtime_status" })).runtime).toMatchObject(
      {
        model: "unknown",
        lastModelEvent: { at: 100_000, outcome: "failed", code: "model_timeout" },
      },
    );
  });
  it("keeps a bounded usable trace with a terminal event when metadata is dense", async () => {
    const { service } = setup();
    const id = service.startTrace(actor);
    for (let index = 0; index < 64; index++)
      service.record(id, {
        stage: index === 63 ? "complete" : "tool",
        outcome: index === 63 ? "failed" : "started",
        toolCallId: "a".repeat(100),
        toolName: "b".repeat(100),
        parentTraceId: id,
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: Number.MAX_SAFE_INTEGER,
        durationMs: Number.MAX_SAFE_INTEGER,
        updateId: Number.MAX_SAFE_INTEGER,
      });
    const response = await service.query(actor, { operation: "get_request_trace", traceId: id });
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(24_000);
    expect(response.traces?.[0]?.events.at(-1)).toMatchObject({
      stage: "complete",
      outcome: "failed",
    });
  });
  it("applies trace and tool-call filters to both log and error queries", async () => {
    const { service } = setup();
    const first = service.startTrace({ ...actor, messageId: 18 });
    const second = service.startTrace({ ...actor, messageId: 19 });
    service.record(first, {
      stage: "tool",
      outcome: "failed",
      toolCallId: "call-a",
      code: "tool_failed",
    });
    service.record(first, { stage: "model", outcome: "failed", code: "model_failed" });
    service.record(second, {
      stage: "tool",
      outcome: "failed",
      toolCallId: "call-b",
      code: "tool_failed",
    });
    const logs = await service.query(actor, {
      operation: "query_sanitized_logs",
      traceId: first,
      toolCallId: "call-a",
    });
    expect(logs.traces).toHaveLength(1);
    expect(logs.traces?.[0]?.events).toEqual([expect.objectContaining({ toolCallId: "call-a" })]);
    const errors = await service.query(actor, {
      operation: "get_recent_errors",
      traceId: first,
      toolCallId: "call-a",
    });
    expect(errors.errors).toEqual([
      { stage: "tool", code: "tool_failed", count: 1, lastAt: 100_000 },
    ]);
    const missing = await service.query(actor, {
      operation: "query_sanitized_logs",
      traceId: "missing",
    });
    expect(missing.traces).toEqual([]);
  });
  it("bounds traces/events, expires old traces and validates pagination", async () => {
    const { service, advance } = setup({ maxTraces: 2, maxEvents: 2, retentionMs: 100 });
    service.startTrace(actor);
    const retained = service.startTrace(actor);
    service.record(retained, { stage: "ingress", outcome: "started" });
    const id = service.startTrace(actor);
    service.record(id, { stage: "model", outcome: "failed", code: "model_failed" });
    service.record(id, { stage: "complete", outcome: "succeeded" });
    expect(
      await service.query(actor, { operation: "query_sanitized_logs", limit: 1, offset: 1 }),
    ).toMatchObject({ total: 2, truncated: true, traces: [expect.anything()] });
    expect(await service.query(actor, { operation: "get_recent_errors" })).toMatchObject({
      errors: [{ code: "model_failed", stage: "model", count: 1, lastAt: 100_000 }],
    });
    expect(
      await service.query(actor, { operation: "query_sanitized_logs", limit: 51 }),
    ).toMatchObject({ code: "invalid_request" });
    advance(101);
    expect(await service.query(actor, { operation: "query_sanitized_logs" })).toMatchObject({
      total: 0,
    });
  });
  it("keeps terminal events and follows parents only inside the current chat", async () => {
    const { service } = setup({ maxEvents: 2 });
    const parent = service.startTrace({ ...actor, messageId: 18 });
    const foreign = service.startTrace({ ...actor, chatId: -20, messageId: 17 });
    const id = service.startTrace({ ...actor, messageId: 19 });
    service.record(id, { stage: "ingress", outcome: "started" });
    service.record(id, { stage: "queue", outcome: "coalesced", parentTraceId: parent });
    service.record(id, { stage: "tool", outcome: "started", parentTraceId: foreign });
    service.record(id, {
      stage: "complete",
      outcome: "failed",
      code: "failed",
      parentTraceId: parent,
    });
    const response = await service.query(actor, { operation: "get_request_trace" });
    expect(response.traces?.map((trace) => trace.traceId)).toEqual([id, parent]);
    expect(response.traces?.[0]).toMatchObject({
      truncated: true,
      events: [{ stage: "ingress" }, { stage: "complete" }],
    });
    expect(
      (await service.query(actor, { operation: "get_request_trace", messageId: 19 })).traces?.[0]
        ?.traceId,
    ).toBe(id);
  });
  it("allows five healthy concurrent queries while keeping at most four audit writes active", async () => {
    vi.useFakeTimers();
    try {
      const { service, audit } = setup();
      let active = 0;
      let peak = 0;
      audit.mockImplementation(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
      });
      const results = Promise.all(
        Array.from({ length: 5 }, () =>
          service.query(actor, { operation: "query_sanitized_logs" }).catch((error) => error),
        ),
      );
      await vi.advanceTimersByTimeAsync(25);
      expect(await results).toEqual(Array(5).fill(expect.objectContaining({ ok: true })));
      expect(peak).toBe(4);
      expect(audit).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });
  it("fails closed on bounded audit timeout and retains occupied slots until writes settle", async () => {
    vi.useFakeTimers();
    try {
      const { service, audit } = setup();
      audit.mockImplementation(() => new Promise(() => {}));
      const pending = Array.from({ length: 4 }, () =>
        service
          .query(actor, { operation: "query_sanitized_logs" })
          .catch((error: Error) => error.message),
      );
      await vi.advanceTimersByTimeAsync(1001);
      expect(await Promise.all(pending)).toEqual(Array(4).fill("Diagnostic audit unavailable"));
      const waiting = service
        .query(actor, { operation: "query_sanitized_logs" })
        .catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await waiting).toBe("Diagnostic audit unavailable");
      expect(audit).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds the audit queue, removes timed-out waiters and recovers after occupied slots settle", async () => {
    vi.useFakeTimers();
    try {
      const { service, audit } = setup();
      const releases: (() => void)[] = [];
      audit.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));
      const pending = Array.from({ length: 12 }, (_, chatId) =>
        service
          .query({ ...actor, chatId }, { operation: "query_sanitized_logs" })
          .catch((error: Error) => error.message),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(audit).toHaveBeenCalledTimes(4);
      await expect(
        service.query({ ...actor, chatId: 12 }, { operation: "query_sanitized_logs" }),
      ).rejects.toThrow("Diagnostic audit unavailable");
      await vi.advanceTimersByTimeAsync(1000);
      expect(await Promise.all(pending)).toEqual(Array(12).fill("Diagnostic audit unavailable"));
      releases.forEach((resolve) => resolve());
      await vi.advanceTimersByTimeAsync(0);
      // Expired queue entries cannot write later when an occupied slot becomes available.
      expect(audit).toHaveBeenCalledTimes(4);
      audit.mockResolvedValue(undefined);
      await expect(
        service.query({ ...actor, chatId: 13 }, { operation: "query_sanitized_logs" }),
      ).resolves.toMatchObject({ ok: true });
      expect(audit).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });
  it("includes time spent queued in the one-second audit deadline", async () => {
    vi.useFakeTimers();
    try {
      const { service, audit } = setup();
      let calls = 0;
      audit.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, ++calls <= 4 ? 900 : 200);
          }),
      );
      const pending = Array.from({ length: 5 }, () =>
        service
          .query(actor, { operation: "query_sanitized_logs" })
          .catch((error: Error) => error.message),
      );
      await vi.advanceTimersByTimeAsync(1000);
      const results = await Promise.all(pending);
      expect(results.slice(0, 4)).toEqual(Array(4).fill(expect.objectContaining({ ok: true })));
      expect(results[4]).toBe("Diagnostic audit unavailable");
      expect(audit).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
    }
  });
  it("audits actor and Bot rate limits", async () => {
    const { service, audit } = setup();
    for (let index = 0; index < 10; index++)
      await service.query(actor, { operation: "query_sanitized_logs" });
    expect(await service.query(actor, { operation: "query_sanitized_logs" })).toMatchObject({
      code: "rate_limited",
    });
    for (let index = 0; index < 49; index++)
      await service.query({ ...actor, chatId: index }, { operation: "query_sanitized_logs" });
    expect(
      await service.query({ ...actor, chatId: 999 }, { operation: "query_sanitized_logs" }),
    ).toMatchObject({ code: "rate_limited" });
    expect(audit).toHaveBeenCalledTimes(61);
  });
});

it("retains only safe image correlation identifiers and delivery observations", async () => {
  const { service } = setup();
  const id = service.startTrace({
    chatId: actor.chatId,
    userId: actor.userId,
    messageId: actor.messageId,
  });
  service.record(id, {
    stage: "tool",
    outcome: "succeeded",
    toolName: "create_image",
    toolCallId: "call-1",
    generationId: "generation-1",
    providerOperationId: "operation-1",
    deliveryState: "pending",
  });
  service.record(id, {
    stage: "tool",
    outcome: "failed",
    generationId: "live-secret",
    providerOperationId: "https://private.invalid/token",
    deliveryState: "unknown",
  });
  const response = await service.query(actor, { operation: "get_request_trace", traceId: id });
  expect(response.historyScope).toBe("current_process");
  expect(response.traces![0]!.events[0]).toMatchObject({
    generationId: "generation-1",
    providerOperationId: "operation-1",
    deliveryState: "pending",
  });
  expect(response.traces![0]!.events[1]!.generationId).toBeUndefined();
  expect(response.traces![0]!.events[1]!.providerOperationId).toBeUndefined();
  expect(JSON.stringify(response)).not.toContain("live-secret");
});
