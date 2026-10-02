import { describe, expect, it, vi } from "vitest";
import { createRuntimeDiagnosticTools } from "../packages/bot/src/tools/runtime-diagnostics.ts";
import { RuntimeDiagnostics } from "../packages/server/src/services/runtime-diagnostics.ts";

function setup() {
  const actor = { chatId: -10, userId: 1, messageId: 20 };
  const audit = vi.fn(async () => undefined);
  const service = new RuntimeDiagnostics({
    adminIds: [1],
    audit,
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
      checkedAt: Date.now(),
      rss: "unobserved",
      imageTasks: "unobserved",
      githubTasks: "unobserved",
      activeTimers: 0,
    }),
  });
  service.bindRuntime({
    effectiveConfig: () => ({ enabled: true }),
    scheduler: () => ({ active: 0, queued: 0, asyncTasks: 0 }),
  });
  const previous = service.startTrace({ ...actor, messageId: 19 });
  service.record(previous, { stage: "tool", outcome: "failed", code: "tool_failed" });
  const currentTraceId = service.startTrace(actor);
  const tools = createRuntimeDiagnosticTools({
    port: service,
    actor: { ...actor, currentTraceId },
    adminIds: [1],
  });
  return { service, tools, previous, audit };
}
const execution = { toolCallId: "diagnostic-call", messages: [] };

describe("runtime diagnostic tool and service contract", () => {
  it("accepts empty optional IDs from the model without losing the previous-message default", async () => {
    const { tools, previous, audit } = setup();
    const response = await tools.get_request_trace.execute(
      {
        messageId: null,
        toolCallId: "",
        traceId: "",
        previous: true,
        windowMs: 3_600_000,
        limit: 20,
        offset: 0,
      },
      execution,
    );
    expect(response).toMatchObject({ ok: true, traces: [{ traceId: previous }] });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ messageId: 20 }),
        outcome: "succeeded",
        previous: true,
      }),
    );
  });

  it("audits all five simultaneous tool queries before returning their data", async () => {
    const { tools, previous, audit } = setup();
    const queries = Object.entries(tools).map(([name, tool]) =>
      tool.execute(
        name === "get_runtime_status" || name === "get_effective_config"
          ? {}
          : {
              messageId: null,
              traceId: null,
              toolCallId: null,
              windowMs: null,
              limit: null,
              offset: null,
              ...(name === "get_request_trace" ? { previous: null } : {}),
            },
        execution,
      ),
    );
    const results = await Promise.all(queries);
    expect(results).toEqual([
      expect.objectContaining({ ok: true, runtime: expect.any(Object) }),
      expect.objectContaining({ ok: true, config: expect.any(Object) }),
      expect.objectContaining({
        ok: true,
        traces: [expect.objectContaining({ traceId: previous })],
      }),
      expect.objectContaining({ ok: true, traces: expect.any(Array) }),
      expect.objectContaining({
        ok: true,
        errors: [expect.objectContaining({ code: "tool_failed" })],
      }),
    ]);
    expect(audit).toHaveBeenCalledTimes(5);
  });

  it("still audits and rejects invalid numbers and injected chat scope", async () => {
    const { tools, audit } = setup();
    for (const request of [{ limit: 51 }, { chatId: -99, toolCallId: null }]) {
      await expect(tools.query_sanitized_logs.execute(request, execution)).resolves.toMatchObject({
        ok: false,
        code: "invalid_request",
      });
    }
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls.every(([entry]) => entry.outcome === "invalid_request")).toBe(true);
  });
});
