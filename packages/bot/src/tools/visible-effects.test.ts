import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { trackSuccessfulToolEffects } from "./visible-effects.js";

function executable(output: unknown): Tool {
  return { execute: vi.fn(async () => output) } as unknown as Tool;
}

describe("trackSuccessfulToolEffects", () => {
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
        generate_image: executable({ success: true, generationId: "generation-1" }),
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
    await tools.generate_image!.execute!({}, {} as never);
    await tools.mark_rss_read!.execute!({}, {} as never);
    await tools.write_file!.execute!({}, {} as never);
    await tools.save_memory!.execute!({}, {} as never);

    expect(onVisibleEffect.mock.calls).toEqual([
      ["send_photo"],
      ["set_timer"],
      ["send_poll"],
      ["generate_image"],
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
