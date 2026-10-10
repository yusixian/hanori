import type { Database } from "@cos-tool-bot/database";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClientManager } from "./mcp-client-manager.js";

const row = {
  id: 1,
  name: "MCP",
  isActive: true,
  url: "https://example.test/mcp",
  transport: "streamable-http",
  presetId: null,
  toolNamePrefix: null,
  encryptedHeaders: null,
};
const managers: McpClientManager[] = [];
function setup() {
  vi.useFakeTimers();
  const query = vi.fn(async () => [row]);
  const db = { select: () => ({ from: () => ({ where: query }) }) } as unknown as Database;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const connect = vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
  const close = vi.spyOn(Client.prototype, "close").mockResolvedValue(undefined);
  const list = vi.spyOn(Client.prototype, "listTools").mockResolvedValue({ tools: [] });
  const manager = new McpClientManager(db, logger, "unused");
  managers.push(manager);
  return { manager, connect, close, list, query };
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.destroyAll()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MCP connection lifetime", () => {
  it("backs off and stops after ten retries in addition to the initial attempt", async () => {
    const { manager, connect } = setup();
    connect.mockRejectedValue(new Error("offline"));
    await manager.connect(1);
    for (let retry = 0; retry < 10; retry++) {
      const delay = Math.min(1000 * 2 ** retry, 300_000);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(connect).toHaveBeenCalledTimes(retry + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledTimes(retry + 2);
    }
    expect(manager.getStatus(1)[0]?.error).toBe("Gave up after 10 retries");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(connect).toHaveBeenCalledTimes(11);
    await manager.connect(1);
    expect(connect).toHaveBeenCalledTimes(12);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(13);
  });

  it("resets the retry sequence only after a successful connection", async () => {
    const { manager, connect, list } = setup();
    connect.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
    await manager.connect(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(manager.getStatus(1)[0]?.connected).toBe(true);
    list.mockRejectedValueOnce(new Error("health failed"));
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(4);
  });

  it("cancels retries on disconnect and does not retry a disabled server", async () => {
    const { manager, connect, query } = setup();
    connect.mockRejectedValue(new Error("offline"));
    await manager.connect(1);
    await manager.disconnect(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(connect).toHaveBeenCalledOnce();
    query.mockResolvedValue([{ ...row, isActive: false }]);
    await manager.connect(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(connect).toHaveBeenCalledOnce();
    expect(manager.getStatus()).toEqual([]);
  });

  it.each(["resolve", "reject"] as const)("ignores a late %s after disconnect", async (mode) => {
    const { manager, connect } = setup();
    const pending = deferred<void>();
    connect.mockReturnValueOnce(pending.promise);
    const starting = manager.connect(1);
    await vi.advanceTimersByTimeAsync(0);
    await manager.disconnect(1);
    await manager.connect(1);
    if (mode === "resolve") pending.resolve();
    else pending.reject(new Error("late"));
    await starting;
    expect(manager.getStatus(1)[0]?.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent connects and invalidates a pending query on shutdown", async () => {
    const { manager, query, connect } = setup();
    const pending = deferred<(typeof row)[]>();
    query.mockReturnValueOnce(pending.promise);
    const first = manager.connect(1);
    const second = manager.connect(1);
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    await manager.destroyAll();
    pending.resolve([row]);
    await first;
    expect(connect).not.toHaveBeenCalled();
    expect(manager.getStatus()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a hanging transport start and starts a retry without waiting for it", async () => {
    const { manager, connect } = setup();
    const handshake = deferred<void>();
    connect.mockReturnValueOnce(handshake.promise);
    const starting = manager.connect(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await starting;
    expect(manager.getStatus(1)[0]?.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(manager.getStatus(1)[0]?.connected).toBe(true);
    handshake.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getStatus(1)[0]?.connected).toBe(true);
  });

  it("does not let an old health failure affect a replacement connection", async () => {
    const { manager, list, connect } = setup();
    await manager.connect(1);
    const pending = deferred<{ tools: [] }>();
    list.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    await manager.disconnect(1);
    await manager.connect(1);
    pending.reject(new Error("late health failure"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(manager.getStatus(1)[0]?.connected).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
