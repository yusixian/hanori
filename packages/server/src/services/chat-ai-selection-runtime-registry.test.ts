import { describe, expect, it, vi } from "vitest";
import {
  ChatAiSelectionRuntimeRegistry,
  type ChatAiSelectionRuntime,
  type ChatAiSelectionRuntimeSnapshot,
} from "./chat-ai-selection-runtime-registry.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

function snapshot(revision: string): ChatAiSelectionRuntimeSnapshot {
  return {
    revision,
    global: { providerId: "provider-a", modelId: "model-a" },
    chats: new Map([[-1001, { providerId: "provider-b", modelId: null }]]),
  };
}

describe("ChatAiSelectionRuntimeRegistry", () => {
  it("awaits runtime application before recording the applied revision", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apply = vi.fn(async () => blocked);
    const registry = new ChatAiSelectionRuntimeRegistry();
    registry.register(BOT_ID, { apply });

    const published = registry.publish(BOT_ID, snapshot("revision-1"));
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(registry.getAppliedRevision(BOT_ID)).toBeNull();

    release();
    await expect(published).resolves.toEqual({
      status: "applied",
      desiredRevision: "revision-1",
      appliedRevision: "revision-1",
    });
    expect(registry.getAppliedRevision(BOT_ID)).toBe("revision-1");
  });

  it("returns pending when no runtime is registered", async () => {
    const registry = new ChatAiSelectionRuntimeRegistry();

    await expect(registry.publish(BOT_ID, snapshot("revision-1"))).resolves.toEqual({
      status: "pending",
      desiredRevision: "revision-1",
      appliedRevision: null,
      reason: "runtime_unavailable",
    });
  });

  it("returns the apply error and preserves the last applied revision", async () => {
    const failure = new Error("runtime rejected snapshot");
    const apply = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    const registry = new ChatAiSelectionRuntimeRegistry();
    registry.register(BOT_ID, { apply });
    await registry.publish(BOT_ID, snapshot("revision-1"));

    await expect(registry.publish(BOT_ID, snapshot("revision-2"))).resolves.toEqual({
      status: "pending",
      desiredRevision: "revision-2",
      appliedRevision: "revision-1",
      reason: "apply_failed",
      error: failure,
    });
    expect(registry.getAppliedRevision(BOT_ID)).toBe("revision-1");
  });

  it("does not let an old disposer unregister a replacement runtime", async () => {
    const oldRuntime: ChatAiSelectionRuntime = { apply: vi.fn(async () => {}) };
    const nextRuntime: ChatAiSelectionRuntime = { apply: vi.fn(async () => {}) };
    const registry = new ChatAiSelectionRuntimeRegistry();
    const unregisterOld = registry.register(BOT_ID, oldRuntime);
    registry.register(BOT_ID, nextRuntime);

    unregisterOld();
    await registry.publish(BOT_ID, snapshot("revision-1"));

    expect(oldRuntime.apply).not.toHaveBeenCalled();
    expect(nextRuntime.apply).toHaveBeenCalledTimes(1);
  });

  it("returns pending if the runtime is replaced while applying", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new ChatAiSelectionRuntimeRegistry();
    registry.register(BOT_ID, { apply: async () => blocked });

    const published = registry.publish(BOT_ID, snapshot("revision-1"));
    await Promise.resolve();
    registry.register(BOT_ID, { apply: vi.fn(async () => {}) });
    release();

    await expect(published).resolves.toEqual({
      status: "pending",
      desiredRevision: "revision-1",
      appliedRevision: null,
      reason: "runtime_replaced",
    });
    expect(registry.getAppliedRevision(BOT_ID)).toBeNull();
  });

  it("supports explicit publication after a runtime is re-registered", async () => {
    const firstRuntime: ChatAiSelectionRuntime = { apply: vi.fn(async () => {}) };
    const nextRuntime: ChatAiSelectionRuntime = { apply: vi.fn(async () => {}) };
    const registry = new ChatAiSelectionRuntimeRegistry();
    registry.register(BOT_ID, firstRuntime);
    await registry.publish(BOT_ID, snapshot("revision-1"));

    expect(registry.unregister(BOT_ID, firstRuntime)).toBe(true);
    registry.register(BOT_ID, nextRuntime);
    expect(registry.getAppliedRevision(BOT_ID)).toBeNull();

    await expect(registry.publish(BOT_ID, snapshot("revision-2"))).resolves.toMatchObject({
      status: "applied",
      appliedRevision: "revision-2",
    });
    expect(nextRuntime.apply).toHaveBeenCalledWith(snapshot("revision-2"));
  });
});
