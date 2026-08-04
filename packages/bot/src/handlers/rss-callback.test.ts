import type { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PendingAdminActionRegistry,
  PENDING_ADMIN_ACTION_TTL_MS,
} from "../services/pending-github-actions.js";
import { createAdminActionCallbackQueryHandler } from "./event-handlers.js";

function callback(
  id: string,
  userId: number,
  options: { chatId?: number; decision?: "yes" | "no"; namespace?: "rss" | "gh" } = {},
) {
  return {
    callbackQuery: {
      id: `callback-${userId}`,
      data: `cos:${options.namespace ?? "rss"}:${id}:${options.decision ?? "yes"}`,
      from: { id: userId },
      message: { chat: { id: options.chatId ?? -100 }, message_id: 22, text: "confirm" },
    },
  };
}

function createApi() {
  return {
    raw: { answerCallbackQuery: vi.fn().mockResolvedValue(true) },
    editMessageText: vi.fn().mockResolvedValue({ message_id: 22 }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RSS confirmation callbacks", () => {
  it.each([
    "rss:mark_rss_read",
    "rss:add_rss_feed",
    "rss:remove_rss_feed",
    "rss:create_rss_collection",
  ] as const)("executes a confirmed %s action", async (kind) => {
    const execute = vi.fn().mockResolvedValue({ summary: "完成" });
    const registry = new PendingAdminActionRegistry();
    const action = registry.register({
      kind,
      chatId: -100,
      userId: 7,
      description: "RSS 操作",
      execute,
    });
    const api = createApi();
    const handler = createAdminActionCallbackQueryHandler({
      api: api as unknown as Api,
      pendingActions: registry,
      adminIds: [7],
    });

    await handler(callback(action.id, 7));
    expect(execute).toHaveBeenCalledOnce();
    registry.destroy();
  });

  it("re-checks the current admin, requester, chat and executes exactly once", async () => {
    const execute = vi.fn().mockResolvedValue({ summary: "已移除 RSS 订阅源 22" });
    const registry = new PendingAdminActionRegistry();
    const action = registry.register({
      kind: "rss:remove_rss_feed",
      chatId: -100,
      userId: 7,
      description: "移除 RSS 订阅源 22",
      execute,
    });
    const api = createApi();
    const adminIds = [7];
    const handler = createAdminActionCallbackQueryHandler({
      api: api as unknown as Api,
      pendingActions: registry,
      adminIds,
    });

    await handler(callback(action.id, 8));
    await handler(callback(action.id, 7, { chatId: -200 }));
    adminIds.length = 0;
    await handler(callback(action.id, 7));
    expect(execute).not.toHaveBeenCalled();
    expect(registry.get(action.id)).toBeDefined();

    adminIds.push(7);
    await Promise.all([handler(callback(action.id, 7)), handler(callback(action.id, 7))]);
    expect(execute).toHaveBeenCalledOnce();
    expect(registry.get(action.id)).toBeUndefined();
    registry.destroy();
  });

  it("cancels without executing and consumes the pending action", async () => {
    const execute = vi.fn();
    const registry = new PendingAdminActionRegistry();
    const action = registry.register({
      kind: "rss:mark_rss_read",
      chatId: -100,
      userId: 7,
      description: "标记 RSS 合集 7 为已读",
      execute,
    });
    const api = createApi();
    const handler = createAdminActionCallbackQueryHandler({
      api: api as unknown as Api,
      pendingActions: registry,
      adminIds: [7],
    });

    await handler(callback(action.id, 7, { decision: "no" }));
    expect(execute).not.toHaveBeenCalled();
    expect(registry.get(action.id)).toBeUndefined();
    registry.destroy();
  });

  it("does not execute expired, missing, or mismatched-kind actions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
    const execute = vi.fn();
    const registry = new PendingAdminActionRegistry();
    const rssAction = registry.register({
      kind: "rss:add_rss_feed",
      chatId: -100,
      userId: 7,
      description: "添加 RSS 订阅源",
      execute,
    });
    const githubAction = registry.register({
      chatId: -100,
      userId: 7,
      description: "create issue",
      execute,
    });
    const api = createApi();
    const handler = createAdminActionCallbackQueryHandler({
      api: api as unknown as Api,
      pendingActions: registry,
      adminIds: [7],
    });

    await handler(callback(githubAction.id, 7));
    expect(registry.get(githubAction.id)).toBeDefined();
    vi.advanceTimersByTime(PENDING_ADMIN_ACTION_TTL_MS);
    await handler(callback(rssAction.id, 7));
    await handler(callback("missing", 7));
    expect(execute).not.toHaveBeenCalled();
    registry.destroy();
  });

  it("does not expose RSS execution errors in the confirmation result", async () => {
    const registry = new PendingAdminActionRegistry();
    const action = registry.register({
      kind: "rss:add_rss_feed",
      chatId: -100,
      userId: 7,
      description: "添加订阅源：https://example.com/feed?…",
      execute: vi.fn().mockRejectedValue(new Error("token=super-secret")),
    });
    const api = createApi();
    const handler = createAdminActionCallbackQueryHandler({
      api: api as unknown as Api,
      pendingActions: registry,
      adminIds: [7],
    });

    await handler(callback(action.id, 7));
    expect(JSON.stringify(api.editMessageText.mock.calls)).not.toContain("super-secret");
    expect(api.editMessageText).toHaveBeenCalledWith(
      -100,
      22,
      expect.stringContaining("执行失败，请稍后重试"),
    );
    registry.destroy();
  });
});
