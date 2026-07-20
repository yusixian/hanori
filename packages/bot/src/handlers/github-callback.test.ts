import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { PendingGitHubActionRegistry } from "../services/pending-github-actions.js";
import { createGitHubCallbackQueryHandler } from "./event-handlers.js";

function callback(id: string, userId: number, chatId = -100) {
  return {
    callbackQuery: {
      id: `callback-${userId}`,
      data: `cos:gh:${id}:yes`,
      from: { id: userId },
      message: { chat: { id: chatId }, message_id: 22, text: "confirm" },
    },
  };
}

describe("GitHub confirmation callbacks", () => {
  it("binds confirmation to its requesting administrator and executes once", async () => {
    const execute = vi.fn().mockResolvedValue({
      summary: "created owner/repo#1",
      url: "https://github.com/owner/repo/issues/1",
    });
    const registry = new PendingGitHubActionRegistry();
    const action = registry.register({
      chatId: -100,
      userId: 7,
      description: "create issue",
      execute,
    });
    const api = {
      raw: { answerCallbackQuery: vi.fn().mockResolvedValue(true) },
      editMessageText: vi.fn().mockResolvedValue({ message_id: 22 }),
    } as unknown as Api;
    const handler = createGitHubCallbackQueryHandler({
      api,
      pendingActions: registry,
      adminIds: [7],
    });

    await expect(handler(callback(action.id, 8))).resolves.toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(registry.get(action.id)).toBeDefined();

    await expect(handler(callback(action.id, 7, -200))).resolves.toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(registry.get(action.id)).toBeDefined();

    await expect(handler(callback(action.id, 7))).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(registry.get(action.id)).toBeUndefined();

    await expect(handler(callback(action.id, 7))).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    registry.destroy();
  });

  it("aborts an active confirmed action when the registry is destroyed", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execute = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          started();
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const registry = new PendingGitHubActionRegistry();
    const action = registry.register({
      chatId: -100,
      userId: 7,
      description: "recover workspace",
      execute,
    });
    const api = {
      raw: { answerCallbackQuery: vi.fn().mockResolvedValue(true) },
      editMessageText: vi.fn().mockResolvedValue({ message_id: 22 }),
    } as unknown as Api;
    const handler = createGitHubCallbackQueryHandler({
      api,
      pendingActions: registry,
      adminIds: [7],
    });

    const handling = handler(callback(action.id, 7));
    await didStart;
    const signal = execute.mock.calls[0]![0];
    expect(signal?.aborted).toBe(false);
    registry.destroy();

    await expect(handling).resolves.toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});
