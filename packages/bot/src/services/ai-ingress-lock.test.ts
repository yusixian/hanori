import { describe, expect, it, vi } from "vitest";
import { AiIngressLock } from "./ai-ingress-lock.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("AiIngressLock", () => {
  it("orders destructive Chat mutations after message ingress without blocking other Chats", async () => {
    const locks = new AiIngressLock();
    const gate = deferred();
    const events: string[] = [];
    const ingress = locks.runMessage(1, 10, async () => {
      events.push("ingress:start");
      await gate.promise;
      events.push("ingress:end");
    });
    const clear = locks.runChatMutation(1, async () => {
      events.push("clear");
    });
    await locks.runMessage(2, 20, async () => {
      events.push("other-chat");
    });

    expect(events).toEqual(["ingress:start", "other-chat"]);
    gate.resolve();
    await Promise.all([ingress, clear]);
    expect(events).toEqual(["ingress:start", "other-chat", "ingress:end", "clear"]);
  });

  it("orders user privacy mutations after ingress across Chats", async () => {
    const locks = new AiIngressLock();
    const gate = deferred();
    const events: string[] = [];
    const ingress = locks.runMessage(1, 10, async () => {
      events.push("ingress:start");
      await gate.promise;
      events.push("ingress:end");
    });
    const privacy = locks.runUserMutation(10, async () => {
      events.push("privacy");
    });

    await vi.waitFor(() => expect(events).toEqual(["ingress:start"]));
    gate.resolve();
    await Promise.all([ingress, privacy]);
    expect(events).toEqual(["ingress:start", "ingress:end", "privacy"]);
  });

  it("registers a waiting message before a later clear mutation", async () => {
    const locks = new AiIngressLock();
    const firstGate = deferred();
    const secondGate = deferred();
    const events: string[] = [];
    const firstContext = {};
    const secondContext = {};

    const first = locks.runAdmittedMessage(firstContext, 1, 10, async () => {
      events.push("message:1:start");
      await firstGate.promise;
      events.push("message:1:end");
    });
    const second = locks.runAdmittedMessage(secondContext, 1, 10, async () => {
      events.push("message:2:start");
      await secondGate.promise;
      events.push("message:2:end");
    });
    const clear = locks.runChatMutation(1, async () => {
      events.push("clear");
    });

    await vi.waitFor(() => expect(events).toEqual(["message:1:start"]));
    firstGate.resolve();
    await vi.waitFor(() =>
      expect(events).toEqual(["message:1:start", "message:1:end", "message:2:start"]),
    );
    expect(locks.hasMessageAdmission(firstContext)).toBe(false);
    expect(locks.hasMessageAdmission(secondContext)).toBe(true);

    secondGate.resolve();
    await Promise.all([first, second, clear]);
    expect(events).toEqual([
      "message:1:start",
      "message:1:end",
      "message:2:start",
      "message:2:end",
      "clear",
    ]);
    expect(locks.hasMessageAdmission(secondContext)).toBe(false);
  });
});
