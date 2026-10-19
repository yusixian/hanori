import { describe, expect, it, vi } from "vitest";
import { asSchema } from "ai";
import type { RuntimeDiagnosticsPort } from "@cos-tool-bot/shared";
import { createRuntimeDiagnosticTools } from "./runtime-diagnostics.js";
import { composeTurnTools } from "../utils/tool-pipeline.js";
import { createRequestCache } from "./utils.js";

function port(): RuntimeDiagnosticsPort {
  return {
    startTrace: vi.fn(() => "trace"),
    record: vi.fn(),
    bindRuntime: vi.fn(),
    query: vi.fn().mockResolvedValue({ ok: false, code: "forbidden" }),
  };
}
describe("runtime diagnostic tools", () => {
  it("does not expose diagnostic tools to non Bot administrators", () => {
    const service = port();
    expect(
      createRuntimeDiagnosticTools({
        port: service,
        actor: { chatId: -100, userId: 42, messageId: 9 },
        adminIds: [7],
      }),
    ).toEqual({});
    expect(service.query).not.toHaveBeenCalled();
  });
  it("binds the trusted actor and delegates authorization to the server", async () => {
    const service = port();
    const actor = { chatId: -100, userId: 7, messageId: 9, currentTraceId: "current" };
    const tools = createRuntimeDiagnosticTools({ port: service, actor, adminIds: [7] });
    expect(Object.keys(tools)).toHaveLength(5);
    await tools.get_request_trace!.execute!(
      { previous: true },
      { toolCallId: "call", messages: [] },
    );
    expect(service.query).toHaveBeenCalledWith(actor, {
      operation: "get_request_trace",
      previous: true,
    });
  });
  it("records a resolved error result as a failed tool without exposing its content", async () => {
    const service = port();
    const events = vi.fn();
    const tools = composeTurnTools(
      createRuntimeDiagnosticTools({
        port: service,
        actor: { chatId: -100, userId: 7, messageId: 9 },
        adminIds: [7],
      }),
      {
        requestCache: createRequestCache(),
        getStep: () => 1,
        onEffect: vi.fn(),
        onDiagnostic: events,
      },
    );
    await tools.get_request_trace!.execute!({}, { toolCallId: "call", messages: [] });
    expect(events).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: "tool",
        outcome: "failed",
        code: "tool_forbidden",
        toolName: "get_request_trace",
        toolCallId: "call",
      }),
    );
    for (const [event] of events.mock.calls) {
      expect(event).not.toHaveProperty("input");
      expect(event).not.toHaveProperty("output");
      expect(event).not.toHaveProperty("error");
    }
  });
});

describe("diagnostic argument schemas and normalization", () => {
  function fixture() {
    const service = port();
    const actor = { chatId: -100, userId: 7, messageId: 8283 };
    return {
      service,
      actor,
      tools: createRuntimeDiagnosticTools({ port: service, actor, adminIds: [7] }),
    };
  }
  async function execute(tool: import("ai").Tool, input: unknown) {
    return tool.execute!(input as never, { toolCallId: "actual-call", messages: [] });
  }
  it("accepts blank optional identifiers through SDK validation before normalization", async () => {
    const { service, actor, tools } = fixture();
    const selected = tools.get_request_trace!;
    const result = await asSchema(selected.inputSchema).validate!({
      traceId: "",
      toolCallId: "  ",
    });
    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    await execute(selected, result.value);
    expect(service.query).toHaveBeenCalledWith(actor, { operation: "get_request_trace" });
  });
  it("normalizes empty online identifiers without changing valid parameters", async () => {
    const { service, actor, tools } = fixture();
    await execute(tools.get_runtime_status!, {
      messageId: 1,
      toolCallId: "",
      traceId: "  ",
      previous: true,
      windowMs: 3600000,
      limit: 20,
      offset: 0,
    });
    expect(service.query).toHaveBeenCalledWith(actor, {
      operation: "get_runtime_status",
      messageId: 1,
      previous: true,
      windowMs: 3600000,
      limit: 20,
      offset: 0,
    });
  });
  it("uses defaults for null input and null optional fields", async () => {
    const { service, actor, tools } = fixture();
    await execute(tools.get_request_trace!, null);
    expect(service.query).toHaveBeenLastCalledWith(actor, { operation: "get_request_trace" });
    await execute(tools.get_request_trace!, {
      traceId: null,
      messageId: null,
      toolCallId: null,
      previous: null,
      windowMs: null,
      limit: null,
      offset: null,
    });
    expect(service.query).toHaveBeenLastCalledWith(actor, { operation: "get_request_trace" });
  });
  it("preserves unknown scope keys and invalid numbers for server rejection", async () => {
    const { service, actor, tools } = fixture();
    await execute(tools.query_sanitized_logs!, {
      chatId: 999,
      operation: "get_runtime_status",
      limit: -1,
      traceId: "real-trace",
      toolCallId: "real-tool",
    });
    expect(service.query).toHaveBeenLastCalledWith(actor, {
      operation: "query_sanitized_logs",
      chatId: 999,
      limit: -1,
      traceId: "real-trace",
      toolCallId: "real-tool",
    });
  });
  it("exposes only parameters meaningful for each operation", () => {
    const { tools } = fixture();
    const schema = (name: string) =>
      (tools[name]!.inputSchema as { jsonSchema: { properties: Record<string, unknown> } })
        .jsonSchema;
    expect(Object.keys(schema("get_runtime_status").properties)).toEqual([]);
    expect(Object.keys(schema("get_effective_config").properties)).toEqual([]);
    expect(schema("get_request_trace").properties).toHaveProperty("previous");
    expect(schema("query_sanitized_logs").properties).not.toHaveProperty("previous");
    expect(schema("get_recent_errors").properties).not.toHaveProperty("previous");
  });
});
