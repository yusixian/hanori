import type { BotLogEntry } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { createRequestCache } from "../tools/utils.js";
import { composeTurnTools } from "./tool-pipeline.js";

function fakeTool(execute: (args: unknown, options: unknown) => unknown): Tool {
  return { execute } as unknown as Tool;
}

function statusContext() {
  const wait = vi.fn().mockResolvedValue(undefined);
  const resolveWait = vi.fn().mockResolvedValue(undefined);
  const ctx = { wait, resolveWait, waiting_message: undefined } as unknown as WrapperContext;
  return { ctx, wait, resolveWait };
}

function compose(tools: Record<string, Tool>, overrides: Record<string, unknown> = {}) {
  const onEffect = vi.fn();
  const onLog = vi.fn<(entry: BotLogEntry) => void>();
  const composed = composeTurnTools(tools, {
    requestCache: createRequestCache(),
    onLog,
    getStep: () => 3,
    onEffect,
    ...overrides,
  });
  return { composed, onEffect, onLog };
}

describe("composeTurnTools", () => {
  it("reports an effect for a successful side-effecting tool", async () => {
    const { composed, onEffect } = compose({
      send_photo: fakeTool(() => ({ ok: true })),
    });

    await composed["send_photo"]!.execute!({}, {} as never);

    expect(onEffect).toHaveBeenCalledWith("send_photo");
  });

  it("reports no effect for a read-only tool", async () => {
    const { composed, onEffect } = compose({
      web_search: fakeTool(() => ({ results: [] })),
    });

    await composed["web_search"]!.execute!({ query: "a" }, {} as never);

    expect(onEffect).not.toHaveBeenCalled();
  });

  it("sends a Telegram status only when a status context is present", async () => {
    const { ctx, wait } = statusContext();
    const withStatus = compose(
      { web_search: fakeTool(() => ({ results: [] })) },
      {
        statusContext: ctx,
      },
    ).composed;
    const withoutStatus = compose({ web_search: fakeTool(() => ({ results: [] })) }).composed;

    await withStatus["web_search"]!.execute!({ query: "a" }, {} as never);
    expect(wait).toHaveBeenCalledWith("🌐 搜索中...");

    await withoutStatus["web_search"]!.execute!({ query: "a" }, {} as never);
    expect(wait).toHaveBeenCalledOnce();
  });

  it("logs the cached replay, which proves logging wraps the cache", async () => {
    const execute = vi.fn(() => ({ results: ["one"] }));
    const { composed, onLog, onEffect } = compose({ web_search: fakeTool(execute) });

    await composed["web_search"]!.execute!({ query: "same" }, {} as never);
    const replay = await composed["web_search"]!.execute!({ query: "same" }, {} as never);

    expect(execute).toHaveBeenCalledOnce();
    expect(replay).toMatchObject({ _cached: true });
    expect(onEffect).not.toHaveBeenCalled();
    const results = onLog.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.message === "AI tool result");
    expect(results).toHaveLength(2);
    expect(results[0]?.meta).toMatchObject({ step: 3, toolName: "web_search" });
    expect(JSON.stringify(results[1]?.meta)).toContain("_cached");
  });

  it("keeps non-executable tools untouched", async () => {
    const provider = { description: "provider defined" } as unknown as Tool;
    const { composed } = compose({ provider_tool: provider });

    expect(composed["provider_tool"]).toBe(provider);
  });
});
