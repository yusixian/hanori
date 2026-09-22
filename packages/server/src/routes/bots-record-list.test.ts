import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotPool } from "../services/bot-pool.js";
import type { ModelCapabilityService } from "../services/model-capability-service.js";
import { botsRoutes } from "./bots.js";

vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgresql://localhost/cos_tool_bot_test";
  process.env.BETTER_AUTH_SECRET ||= "test-secret";
  process.env.AUTH_OWNER_EMAIL ||= "owner@example.com";
});

const listProfiles = vi.fn();
const searchProfiles = vi.fn();
const listMemories = vi.fn();
const getConversationList = vi.fn();

const botPool = {
  getProfileStore: () => ({ listProfiles, searchProfiles }),
  getBotMemoryStore: () => ({ listMemories }),
  getConversationStore: () => ({ getConversationList }),
} as unknown as BotPool;

const app = new Hono().route(
  "/bots",
  botsRoutes({} as Database, botPool, {} as ModelCapabilityService),
);

beforeEach(() => {
  vi.clearAllMocks();
  listMemories.mockResolvedValue({ data: [], total: 0 });
  getConversationList.mockResolvedValue({ data: [], total: 0 });
});

describe("GET /bots/:botId/profiles", () => {
  it("uses the paginated management query for search results and returns the full total", async () => {
    listProfiles.mockResolvedValue({
      data: Array.from({ length: 5 }, (_, index) => ({
        id: index + 21,
        telegramId: index + 21,
      })),
      total: 25,
    });

    const response = await app.request("/bots/bot-a/profiles?search=Ai&page=2&limit=20");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[]; total: number };
    expect(body).toMatchObject({
      ok: true,
      data: expect.arrayContaining([expect.objectContaining({ id: 21 })]),
      total: 25,
    });
    expect(body.data).toHaveLength(5);
    expect(listProfiles).toHaveBeenCalledWith("bot-a", 2, 20, "Ai");
    expect(searchProfiles).not.toHaveBeenCalled();
  });
});

describe("GET /bots/:botId/memories telegramId", () => {
  it.each([
    ["general", "general"],
    ["-42", -42],
    ["0", 0],
    ["9007199254740991", 9_007_199_254_740_991],
    ["-9007199254740991", -9_007_199_254_740_991],
    ["%20%20", undefined],
    ["%20-42%20", -42],
  ])("maps %s to the expected memory filter", async (query, expected) => {
    const response = await app.request(`/bots/bot-a/memories?telegramId=${query}`);

    expect(response.status).toBe(200);
    expect(listMemories).toHaveBeenCalledWith("bot-a", 1, 20, {
      category: undefined,
      search: undefined,
      telegramId: expected,
    });
  });

  it.each(["person", "1.5", "1e3", "%2B42", "9007199254740992", "--42"])(
    "rejects invalid filter %s instead of returning all memories",
    async (query) => {
      const response = await app.request(`/bots/bot-a/memories?telegramId=${query}`);

      expect(response.status).toBe(400);
      expect(listMemories).not.toHaveBeenCalled();
    },
  );
});

describe("GET /bots/:botId/conversations", () => {
  it("normalizes and forwards the optional search with the existing pagination", async () => {
    getConversationList.mockResolvedValue({ data: [{ chatId: 25 }], total: 25 });

    const response = await app.request(
      "/bots/bot-a/conversations?search=%20Alice%20&page=2&limit=20",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, total: 25 });
    expect(getConversationList).toHaveBeenCalledWith("bot-a", 2, 20, "Alice");
  });

  it("accepts blank search as the unfiltered form", async () => {
    const response = await app.request("/bots/bot-a/conversations?search=%20%20");

    expect(response.status).toBe(200);
    expect(getConversationList).toHaveBeenCalledWith("bot-a", 1, 20, "");
  });

  it("rejects searches longer than 100 characters before querying the store", async () => {
    const response = await app.request(
      `/bots/bot-a/conversations?search=${encodeURIComponent("a".repeat(101))}`,
    );

    expect(response.status).toBe(400);
    expect(getConversationList).not.toHaveBeenCalled();
  });
});
