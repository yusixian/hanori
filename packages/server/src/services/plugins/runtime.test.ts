import type { PluginActor, PluginSession } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { bindPluginSession, runPluginCall, validatePluginDefinition } from "./runtime.js";

const actor: PluginActor = {
  botId: "bot",
  chatId: 1,
  userId: 2,
  isAdmin: false,
  isPrivate: true,
  readOnly: false,
};
const controller = () => new AbortController();
function fixture(): PluginSession {
  return {
    tools: [
      {
        name: "read",
        description: "Read",
        inputSchema: { type: "object" },
        effect: "read_only",
        access: "all",
        execute: async () => ({ value: 1 }),
      },
      {
        name: "write",
        description: "Write",
        inputSchema: { type: "object" },
        effect: "mutating",
        access: "all",
        execute: async () => ({ value: 2 }),
      },
      {
        name: "admin",
        description: "Admin",
        inputSchema: { type: "object" },
        effect: "read_only",
        access: "admin",
        execute: async () => ({ value: 3 }),
      },
    ],
    searchProviders: [
      {
        id: "read",
        scope: "fixture",
        description: "Find",
        pagination: "single_page",
        search: async () => ({ status: "empty", items: [], hasMore: false }),
      },
    ],
  };
}
function bind(
  session = fixture(),
  context = actor,
  authorize: () => Promise<void> = vi.fn(async () => undefined),
  signal = controller().signal,
) {
  return bindPluginSession({
    pluginId: "example.fixture",
    session,
    actor: context,
    authorize,
    signal,
  });
}

describe("trusted plugin invocation boundary", () => {
  it("filters admin tools and mutations for read-only researchers, with stable distinct namespaces", () => {
    expect(bind().tools.map((entry) => entry.name.split("_").at(-1))).toEqual(["read", "write"]);
    expect(bind(fixture(), { ...actor, readOnly: true }).tools).toHaveLength(1);
    expect(bind(fixture(), { ...actor, isAdmin: true }).tools).toHaveLength(3);
    const other = bindPluginSession({
      pluginId: "example.other",
      session: fixture(),
      actor,
      authorize: async () => undefined,
      signal: controller().signal,
    });
    expect(other.tools[0]!.name).not.toBe(bind().tools[0]!.name);
  });

  it("rejects malformed tools instead of silently assigning read privileges", () => {
    const session = fixture();
    (session.tools![0] as { effect: string }).effect = "unknown";
    expect(() => bind(session)).toThrow("invalid_plugin");
    expect(() => validatePluginDefinition({ apiVersion: 2, createSession() {} })).toThrow(
      "invalid_plugin",
    );
  });

  it("checks current permission before execution and rejects results revoked in flight", async () => {
    const execute = vi.fn(async () => ({ secret: "synthetic-result" }));
    const session = fixture();
    session.tools![0]!.execute = execute;
    const authorize = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValue(new Error("revoked"));
    await expect(
      bind(session, actor, authorize).tools[0]!.execute({}, controller().signal),
    ).rejects.toThrow("plugin_failed");
    expect(execute).toHaveBeenCalledOnce();
    const denied = vi.fn(async () => {
      throw new Error("private credential");
    });
    await expect(
      bind(session, actor, denied).tools[0]!.execute({}, controller().signal),
    ).rejects.toThrow("plugin_failed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("enforces argument/result bounds and hides exception contents", async () => {
    const session = fixture();
    const execute = vi.fn(async () => ({ data: "x".repeat(64_001) }));
    session.tools![0]!.execute = execute;
    const tool = bind(session).tools[0]!;
    await expect(tool.execute({ data: "x".repeat(32_001) }, controller().signal)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    await expect(tool.execute({}, controller().signal)).rejects.toThrow();
    execute.mockRejectedValueOnce(new Error("cookie=private-secret"));
    await expect(tool.execute({}, controller().signal)).rejects.toThrow("plugin_failed");
  });

  it("cancels active calls and rejects late values from a plugin that ignores its signal", async () => {
    const stop = controller();
    let finish!: (value: unknown) => void;
    const session = fixture();
    session.tools![0]!.execute = async () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = bind(session, actor, undefined, stop.signal).tools[0]!.execute(
      {},
      controller().signal,
    );
    const rejected = expect(pending).rejects.toThrow("plugin_stopped");
    await vi.waitFor(() => expect(finish).toBeDefined());
    stop.abort();
    await rejected;
    finish({ late: true });
  });

  it("bounds plugin factory/check duration", async () => {
    await expect(
      runPluginCall(async () => new Promise(() => {}), controller().signal, 10),
    ).rejects.toThrow("plugin_timeout");
  });

  it.each(["tool", "search"] as const)(
    "allows a %s call to finish beyond the previous one-minute limit",
    async (kind) => {
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        const timeout = controller();
        setTimeout(() => timeout.abort(), ms);
        return timeout.signal;
      });
      try {
        const session = fixture();
        session.tools![0]!.execute = async () =>
          new Promise((resolve) => setTimeout(() => resolve({ value: 1 }), 120_000));
        session.searchProviders![0]!.search = async () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ status: "empty", items: [], hasMore: false }), 120_000),
          );
        const bound = bind(session);
        const pending =
          kind === "tool"
            ? bound.tools[0]!.execute({}, controller().signal)
            : bound.searchProviders[0]!.search(
                { scope: "fixture", query: "slow source", page: 1, limit: 10 },
                controller().signal,
              );
        const completed = expect(pending).resolves.toEqual(
          kind === "tool" ? { value: 1 } : { status: "empty", items: [], hasMore: false },
        );
        await vi.advanceTimersByTimeAsync(120_000);
        await completed;
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    },
  );

  it("stops a non-cooperative plugin after ten minutes and aborts its call signal", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const timeout = controller();
      setTimeout(() => timeout.abort(), ms);
      return timeout.signal;
    });
    try {
      let callSignal: AbortSignal | undefined;
      const session = fixture();
      session.tools![0]!.execute = async (_input, signal) => {
        callSignal = signal;
        return new Promise(() => {});
      };
      const pending = bind(session).tools[0]!.execute({}, controller().signal);
      const rejected = expect(pending).rejects.toThrow("plugin_timeout");
      await vi.advanceTimersByTimeAsync(599_999);
      expect(callSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(callSignal?.aborted).toBe(true);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
