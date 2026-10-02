import { describe, expect, it, vi } from "vitest";
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
        toolName: "get_request_trace",
        toolCallId: "call",
      }),
    );
    expect(JSON.stringify(events.mock.calls)).not.toContain("forbidden");
  });
});
