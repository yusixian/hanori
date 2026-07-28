import { describe, expect, it, vi } from "vitest";
import {
  AiReplyQueueFullError,
  AiReplyScheduler,
  AiReplySchedulerDestroyedError,
} from "./ai-reply-scheduler.js";

describe("AiReplyScheduler", () => {
  it("admits different chats up to the global limit", async () => {
    const scheduler = new AiReplyScheduler({ maxConcurrent: 2 });

    const first = scheduler.acquire({ chatId: 1 });
    const second = scheduler.acquire({ chatId: 2 });
    const third = scheduler.acquire({ chatId: 3 });

    expect(first.queued).toBe(false);
    expect(second.queued).toBe(false);
    expect(third.queued).toBe(true);
    expect(scheduler.stats).toEqual({
      active: 2,
      activeUsers: 0,
      queued: 1,
      maxConcurrent: 2,
      maxQueued: 100,
    });

    const firstPermit = await first.permit;
    firstPermit.release();
    const thirdPermit = await third.permit;
    expect(scheduler.stats).toMatchObject({ active: 2, queued: 0 });

    (await second.permit).release();
    thirdPermit.release();
  });

  it("keeps a chat serial and grants its requests in FIFO order", async () => {
    const scheduler = new AiReplyScheduler({ maxConcurrent: 3 });
    const first = scheduler.acquire({ chatId: 1 });
    const second = scheduler.acquire({ chatId: 1 });
    const third = scheduler.acquire({ chatId: 1 });
    const grants: string[] = [];
    void second.permit.then(() => grants.push("second"));
    void third.permit.then(() => grants.push("third"));

    expect(first.queued).toBe(false);
    expect(second.queued).toBe(true);
    expect(third.queued).toBe(true);
    expect(scheduler.stats).toMatchObject({ active: 1, queued: 2 });

    (await first.permit).release();
    const secondPermit = await second.permit;
    expect(grants).toEqual(["second"]);
    expect(scheduler.stats).toMatchObject({ active: 1, queued: 1 });

    secondPermit.release();
    const thirdPermit = await third.permit;
    expect(grants).toEqual(["second", "third"]);
    thirdPermit.release();
  });

  it("skips a busy chat at the queue head when another chat can run", async () => {
    const scheduler = new AiReplyScheduler({ maxConcurrent: 2 });
    const activeChatOne = scheduler.acquire({ chatId: 1 });
    const activeChatTwo = scheduler.acquire({ chatId: 2 });
    const blockedByChatOne = scheduler.acquire({ chatId: 1 });
    const runnableChatThree = scheduler.acquire({ chatId: 3 });
    const blockedGrant = vi.fn();
    const runnableGrant = vi.fn();
    void blockedByChatOne.permit.then(blockedGrant);
    void runnableChatThree.permit.then(runnableGrant);

    (await activeChatTwo.permit).release();
    const chatThreePermit = await runnableChatThree.permit;
    expect(runnableGrant).toHaveBeenCalledOnce();
    expect(blockedGrant).not.toHaveBeenCalled();

    (await activeChatOne.permit).release();
    const chatOnePermit = await blockedByChatOne.permit;
    expect(blockedGrant).toHaveBeenCalledOnce();

    chatThreePermit.release();
    chatOnePermit.release();
  });

  it("does not spend a second slot on the same user and preserves per-chat FIFO", async () => {
    const scheduler = new AiReplyScheduler({ maxConcurrent: 2 });
    const activeUser = scheduler.acquire({ chatId: 1, userId: 10 });
    const blockedSameUser = scheduler.acquire({ chatId: 2, userId: 10 });
    const laterSameChat = scheduler.acquire({ chatId: 2, userId: 30 });
    const unrelated = scheduler.acquire({ chatId: 3, userId: 20 });
    const blockedGrant = vi.fn();
    const laterGrant = vi.fn();
    void blockedSameUser.permit.then(blockedGrant);
    void laterSameChat.permit.then(laterGrant);

    expect(activeUser.queued).toBe(false);
    expect(blockedSameUser.queued).toBe(true);
    expect(laterSameChat.queued).toBe(true);
    expect(unrelated.queued).toBe(false);
    expect(scheduler.stats).toMatchObject({ active: 2, activeUsers: 2, queued: 2 });

    (await unrelated.permit).release();
    await Promise.resolve();
    expect(blockedGrant).not.toHaveBeenCalled();
    expect(laterGrant).not.toHaveBeenCalled();
    expect(scheduler.stats).toMatchObject({ active: 1, activeUsers: 1, queued: 2 });

    const anotherUnrelated = scheduler.acquire({ chatId: 4, userId: 40 });
    expect(anotherUnrelated.queued).toBe(false);
    (await anotherUnrelated.permit).release();

    (await activeUser.permit).release();
    const blockedPermit = await blockedSameUser.permit;
    expect(blockedGrant).toHaveBeenCalledOnce();
    expect(laterGrant).not.toHaveBeenCalled();

    blockedPermit.release();
    (await laterSameChat.permit).release();
    expect(laterGrant).toHaveBeenCalledOnce();
    expect(scheduler.stats).toMatchObject({ active: 0, activeUsers: 0, queued: 0 });
  });

  it("throws a recognizable error when the bounded queue is full", async () => {
    const scheduler = new AiReplyScheduler({ maxConcurrent: 1, maxQueued: 1 });
    const active = scheduler.acquire({ chatId: 1, userId: 9 });
    const queued = scheduler.acquire({ chatId: 2, userId: 9 });

    expect(() => scheduler.acquire({ chatId: 3 })).toThrow(AiReplyQueueFullError);
    try {
      scheduler.acquire({ chatId: 3 });
    } catch (error) {
      expect(error).toMatchObject({ code: "AI_REPLY_QUEUE_FULL", maxQueued: 1 });
    }

    (await active.permit).release();
    (await queued.permit).release();
  });

  it("removes and rejects an aborted queued request", async () => {
    const scheduler = new AiReplyScheduler({ maxConcurrent: 1, maxQueued: 1 });
    const active = scheduler.acquire({ chatId: 1 });
    const controller = new AbortController();
    const queued = scheduler.acquire({ chatId: 2, signal: controller.signal });
    const reason = new Error("AI disabled by /stop");
    const rejection = queued.permit.catch((error) => error);

    controller.abort(reason);

    await expect(rejection).resolves.toBe(reason);
    expect(scheduler.stats).toMatchObject({ active: 1, activeUsers: 0, queued: 0 });
    const replacement = scheduler.acquire({ chatId: 3 });
    expect(replacement.queued).toBe(true);

    (await active.permit).release();
    (await replacement.permit).release();
  });

  it("rejects queued requests on destroy and does not admit future work", async () => {
    const scheduler = new AiReplyScheduler({ maxConcurrent: 1 });
    const active = scheduler.acquire({ chatId: 1, userId: 9 });
    const queued = scheduler.acquire({ chatId: 2, userId: 9 });
    const rejection = queued.permit.catch((error) => error);

    scheduler.destroy();

    await expect(rejection).resolves.toBeInstanceOf(AiReplySchedulerDestroyedError);
    expect(scheduler.stats).toMatchObject({ active: 1, activeUsers: 1, queued: 0 });
    expect(() => scheduler.acquire({ chatId: 3 })).toThrow(AiReplySchedulerDestroyedError);

    const permit = await active.permit;
    permit.release();
    permit.release();
    expect(scheduler.stats).toMatchObject({ active: 0, activeUsers: 0, queued: 0 });
  });

  it("releases idempotently while continuing to drain the queue", async () => {
    const scheduler = new AiReplyScheduler({ maxConcurrent: 1 });
    const active = scheduler.acquire({ chatId: 1 });
    const queued = scheduler.acquire({ chatId: 2 });

    const activePermit = await active.permit;
    activePermit.release();
    activePermit.release();

    const queuedPermit = await queued.permit;
    expect(scheduler.stats).toMatchObject({ active: 1, queued: 0 });
    queuedPermit.release();
    queuedPermit.release();
    expect(scheduler.stats).toMatchObject({ active: 0, queued: 0 });
  });

  it("validates limits and returns immutable stats", () => {
    expect(() => new AiReplyScheduler({ maxConcurrent: 0 })).toThrow(
      "maxConcurrent must be a positive integer",
    );
    expect(() => new AiReplyScheduler({ maxConcurrent: 1, maxQueued: -1 })).toThrow(
      "maxQueued must be a non-negative integer",
    );

    const scheduler = new AiReplyScheduler({ maxConcurrent: 4, maxQueued: 8 });
    const stats = scheduler.stats;
    expect(Object.isFrozen(stats)).toBe(true);
    expect(stats).toEqual({
      active: 0,
      activeUsers: 0,
      queued: 0,
      maxConcurrent: 4,
      maxQueued: 8,
    });
  });
});
