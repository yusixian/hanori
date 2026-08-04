import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PendingAdminActionRegistry,
  PENDING_ADMIN_ACTION_TTL_MS,
} from "./pending-github-actions.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("PendingAdminActionRegistry", () => {
  it("binds an action kind and allows it to be taken only once", () => {
    const registry = new PendingAdminActionRegistry();
    const action = registry.register({
      kind: "rss:remove_rss_feed",
      chatId: -100,
      userId: 7,
      description: "remove feed",
      execute: vi.fn().mockResolvedValue({ summary: "done" }),
    });

    expect(action).toMatchObject({
      kind: "rss:remove_rss_feed",
      chatId: -100,
      userId: 7,
    });
    expect(registry.take(action.id)).toBe(action);
    expect(registry.take(action.id)).toBeUndefined();
    registry.destroy();
  });

  it("expires pending actions after ten minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
    const registry = new PendingAdminActionRegistry();
    const action = registry.register({
      kind: "rss:add_rss_feed",
      chatId: -100,
      userId: 7,
      description: "add feed",
      execute: vi.fn().mockResolvedValue({ summary: "done" }),
    });

    vi.advanceTimersByTime(PENDING_ADMIN_ACTION_TTL_MS);
    expect(registry.get(action.id)).toBeUndefined();
    registry.destroy();
  });
});
