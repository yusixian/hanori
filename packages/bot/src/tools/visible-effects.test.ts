import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { trackSuccessfulToolEffects } from "./visible-effects.js";
import { createPluginTools } from "./plugins.js";

function executable(output: unknown): Tool {
  return { execute: vi.fn(async () => output) } as unknown as Tool;
}

describe("trackSuccessfulToolEffects", () => {
  it("uses each plugin session's declared effect without leaking by dynamic tool name", async () => {
    const onEffect = vi.fn();
    for (const effect of ["read_only", "mutating", "read_only"] as const) {
      const tools = trackSuccessfulToolEffects(
        createPluginTools({
          tools: [
            {
              name: "plg_fixture_tool",
              description: "Fixture",
              inputSchema: { type: "object" },
              effect,
              access: "all",
              execute: async () => ({ ok: true }),
            },
          ],
          searchProviders: [],
          dispose: async () => {},
        }),
        onEffect,
      );
      await tools.plg_fixture_tool!.execute!({}, { toolCallId: "fixture", messages: [] });
    }
    expect(onEffect.mock.calls).toEqual([["plg_fixture_tool"]]);
  });
  it("tracks successful side effects but not failures or known read-only tools", async () => {
    const onVisibleEffect = vi.fn();
    const tools = trackSuccessfulToolEffects(
      {
        send_photo: executable({ success: true, message_id: 1 }),
        set_timer: executable({ success: true, timer_id: "timer-1" }),
        send_document: executable({ error: "failed" }),
        send_poll: executable({ success: true, message_id: 2 }),
        get_chat_info: executable({ id: -100, title: "read only" }),
        web_search: executable({ result: "read only" }),
        list_rss_feeds: executable({ feeds: [] }),
        delegate_task: executable({ agent: "general", result: "translated", steps: 1 }),
        create_image: executable({ accepted: true, generation: { id: "generation-1" } }),
        failed_create_image: executable({ accepted: false, reason: "rate_limited" }),
        failed_cancel_image: executable({ ok: false, reason: "provider_rejected" }),
        mark_rss_read: executable({ success: true, count: 3 }),
        write_file: executable({ success: true, path: "report.md" }),
        save_memory: executable({ success: true, id: "memory-1" }),
      },
      onVisibleEffect,
    );

    await tools.send_photo!.execute!({}, {} as never);
    await tools.set_timer!.execute!({}, {} as never);
    await tools.send_document!.execute!({}, {} as never);
    await tools.send_poll!.execute!({}, {} as never);
    await tools.get_chat_info!.execute!({}, {} as never);
    await tools.web_search!.execute!({}, {} as never);
    await tools.list_rss_feeds!.execute!({}, {} as never);
    await tools.delegate_task!.execute!({}, {} as never);
    await tools.create_image!.execute!({}, {} as never);
    await tools.failed_create_image!.execute!({}, {} as never);
    await tools.failed_cancel_image!.execute!({}, {} as never);
    await tools.mark_rss_read!.execute!({}, {} as never);
    await tools.write_file!.execute!({}, {} as never);
    await tools.save_memory!.execute!({}, {} as never);

    expect(onVisibleEffect.mock.calls).toEqual([
      ["send_photo"],
      ["set_timer"],
      ["send_poll"],
      ["create_image"],
      ["mark_rss_read"],
      ["write_file"],
      ["save_memory"],
    ]);
  });

  it("treats an unknown successful tool as side-effecting by default", async () => {
    const onEffect = vi.fn();
    const tools = trackSuccessfulToolEffects(
      { future_external_tool: executable({ ok: true }) },
      onEffect,
    );

    await tools.future_external_tool!.execute!({}, {} as never);

    expect(onEffect).toHaveBeenCalledWith("future_external_tool");
  });
});
