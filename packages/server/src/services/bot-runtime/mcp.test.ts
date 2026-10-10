import pino from "pino";
import { expect, it, vi } from "vitest";
import { createMcpCallbacks } from "./mcp.js";
import { runtimeHost, runtimeServices } from "./test-fakes.js";

it.each(["add", "remove"])(
  "uses the captured runtime restart after a successful %s",
  async (action) => {
    let release!: () => void;
    const saved = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn();
    const capture = vi.fn(() => request);
    const update = vi.fn(() => ({ set: () => ({ where: () => saved }) }));
    const row = { aiConfig: { mcpServerIds: action === "add" ? [] : [3] } };
    const services = runtimeServices(undefined, pino({ level: "silent" }), {
      db: { select: () => ({ from: () => ({ where: async () => [row] }) }), update } as never,
      mcpClientManager: {} as never,
    });
    const callbacks = createMcpCallbacks(
      "bot",
      services,
      runtimeHost({ createDeferredRestart: capture }),
    )!;
    expect(capture).toHaveBeenCalledExactlyOnceWith("bot");
    const operation = action === "add" ? callbacks.addServer(3) : callbacks.removeServer(3);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(request).not.toHaveBeenCalled();
    release();
    await expect(operation).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
  },
);

it("does not request a restart when the configuration write fails", async () => {
  const request = vi.fn();
  const services = runtimeServices(undefined, pino({ level: "silent" }), {
    db: {
      select: () => ({
        from: () => ({ where: async () => [{ aiConfig: { mcpServerIds: [3] } }] }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            throw new Error("write failed");
          },
        }),
      }),
    } as never,
    mcpClientManager: {} as never,
  });
  const callbacks = createMcpCallbacks(
    "bot",
    services,
    runtimeHost({ createDeferredRestart: () => request }),
  )!;
  await expect(callbacks.removeServer(3)).rejects.toThrow("write failed");
  expect(request).not.toHaveBeenCalled();
});
