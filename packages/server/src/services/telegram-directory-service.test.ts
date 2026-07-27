import type { Database } from "@cos-tool-bot/database";
import {
  bots,
  miniAppChatGrants,
  miniAppOperatorGrants,
  telegramBotProfiles,
  telegramChats,
} from "@cos-tool-bot/database";
import { describe, expect, it } from "vitest";
import { TelegramDirectoryService } from "./telegram-directory-service.js";

const BOT_A = "00000000-0000-4000-8000-000000000001";
const BOT_B = "00000000-0000-4000-8000-000000000002";

interface StoredBot {
  platform: string;
  adminChatIds: unknown[];
}

interface StoredProfile {
  botId: string;
  telegramUserId: number;
  username: string;
  displayName: string;
  observedAt: Date;
}

interface StoredChat {
  botId: string;
  chatId: number;
  type: string;
  title: string | null;
  username: string | null;
  lastObservedAt: Date;
  botMembershipStatus: string | null;
  membershipObservedAt: Date | null;
  leftAt: Date | null;
}

interface FakeState {
  bots: Map<string, StoredBot>;
  profiles: Map<string, StoredProfile>;
  chats: Map<string, StoredChat>;
  operators: Array<{ botId: string; telegramUserId: unknown }>;
  chatGrants: Array<{ botId: string; chatId: unknown }>;
  conflictOptions: unknown[];
  whereConditions: unknown[];
  insertCalls: number;
}

function collectPrimitiveValues(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (value === null || typeof value !== "object") return [value];
  if (seen.has(value)) return [];
  seen.add(value);
  if (value instanceof Date) return [value];
  return Object.values(value).flatMap((entry) => collectPrimitiveValues(entry, seen));
}

function conditionBotId(condition: unknown): string | undefined {
  return collectPrimitiveValues(condition).find(
    (value): value is string => typeof value === "string" && value.startsWith("00000000-"),
  );
}

function chatKey(botId: string, chatId: number): string {
  return `${botId}:${chatId}`;
}

function createFakeDatabase() {
  const state: FakeState = {
    bots: new Map(),
    profiles: new Map(),
    chats: new Map(),
    operators: [],
    chatGrants: [],
    conflictOptions: [],
    whereConditions: [],
    insertCalls: 0,
  };

  const db = {
    insert: (table: unknown) => {
      state.insertCalls += 1;
      return {
        values: (input: Record<string, unknown>) => ({
          onConflictDoUpdate: (options: unknown) => {
            state.conflictOptions.push(options);
            const where = (options as { where?: unknown }).where;
            if (!where) throw new Error("test fake requires a guarded conflict update");
            return {
              returning: async () => {
                if (table === telegramBotProfiles) {
                  const next = input as unknown as StoredProfile;
                  const current = state.profiles.get(next.botId);
                  if (current && current.observedAt >= next.observedAt) return [];
                  state.profiles.set(next.botId, { ...next });
                  return [{ botId: next.botId }];
                }

                if (table !== telegramChats) throw new Error("unexpected insert table");
                const botId = input.botId as string;
                const chatId = input.chatId as number;
                const key = chatKey(botId, chatId);
                const current = state.chats.get(key);
                const isMembershipWrite = Object.hasOwn(input, "botMembershipStatus");

                if (!current) {
                  state.chats.set(key, {
                    botId,
                    chatId,
                    type: input.type as string,
                    title: input.title as string | null,
                    username: input.username as string | null,
                    lastObservedAt: input.lastObservedAt as Date,
                    botMembershipStatus:
                      (input.botMembershipStatus as string | null | undefined) ?? null,
                    membershipObservedAt:
                      (input.membershipObservedAt as Date | null | undefined) ?? null,
                    leftAt: (input.leftAt as Date | null | undefined) ?? null,
                  });
                  return [{ chatId }];
                }

                if (isMembershipWrite) {
                  const observedAt = input.membershipObservedAt as Date;
                  if (current.membershipObservedAt && current.membershipObservedAt >= observedAt) {
                    return [];
                  }
                  current.botMembershipStatus = input.botMembershipStatus as string;
                  current.membershipObservedAt = observedAt;
                  current.leftAt = input.leftAt as Date | null;
                  return [{ chatId }];
                }

                const observedAt = input.lastObservedAt as Date;
                if (current.lastObservedAt >= observedAt) return [];
                current.type = input.type as string;
                current.title = input.title as string | null;
                current.username = input.username as string | null;
                current.lastObservedAt = observedAt;
                return [{ chatId }];
              },
            };
          },
        }),
      };
    },
    select: () => ({
      from: (table: unknown) => ({
        where: async (condition: unknown) => {
          state.whereConditions.push(condition);
          const botId = conditionBotId(condition);
          if (!botId) return [];
          if (table === bots) {
            const bot = state.bots.get(botId);
            return bot?.platform === "telegram" ? [{ adminChatIds: bot.adminChatIds }] : [];
          }
          if (table === miniAppOperatorGrants) {
            return state.operators
              .filter((row) => row.botId === botId)
              .map((row) => ({ telegramUserId: row.telegramUserId }));
          }
          if (table === miniAppChatGrants) {
            return state.chatGrants
              .filter((row) => row.botId === botId)
              .map((row) => ({ chatId: row.chatId }));
          }
          throw new Error("unexpected select table");
        },
      }),
    }),
  } as unknown as Database;

  return { db, state, service: new TelegramDirectoryService(db) };
}

describe("TelegramDirectoryService", () => {
  it("rejects unsafe, wrongly signed, and unscoped identifiers before touching the database", async () => {
    const { service, state } = createFakeDatabase();
    const baseChat = {
      botId: BOT_A,
      chatId: -1001,
      type: "group" as const,
      title: "Group",
      username: null,
      observedAt: new Date("2026-07-27T00:00:00.000Z"),
    };

    await expect(service.observeChat({ ...baseChat, botId: "bot-a" })).rejects.toThrow("UUID");
    await expect(service.observeChat({ ...baseChat, chatId: 1001 })).rejects.toThrow("negative");
    await expect(
      service.observeChat({ ...baseChat, chatId: -Number.MAX_SAFE_INTEGER - 1 }),
    ).rejects.toThrow("safe integer");
    await expect(
      service.upsertBotProfile({
        botId: BOT_A,
        telegramUserId: -42,
        username: "test_bot",
        displayName: "Test",
        observedAt: baseChat.observedAt,
      }),
    ).rejects.toThrow("positive");
    await expect(
      service.observeChat({ ...baseChat, observedAt: new Date(Number.NaN) }),
    ).rejects.toThrow("valid Date");
    expect(state.insertCalls).toBe(0);
  });

  it("keeps Bot profiles and chat metadata scoped and ignores stale or duplicate observations", async () => {
    const { service, state } = createFakeDatabase();
    const t1 = new Date("2026-07-27T01:00:00.000Z");
    const t2 = new Date("2026-07-27T02:00:00.000Z");

    await expect(
      service.upsertBotProfile({
        botId: BOT_A,
        telegramUserId: 11,
        username: "old_bot",
        displayName: "Old",
        observedAt: t1,
      }),
    ).resolves.toBe(true);
    await expect(
      service.upsertBotProfile({
        botId: BOT_A,
        telegramUserId: 12,
        username: "new_bot",
        displayName: "New",
        observedAt: t2,
      }),
    ).resolves.toBe(true);
    await expect(
      service.upsertBotProfile({
        botId: BOT_A,
        telegramUserId: 13,
        username: "duplicate_bot",
        displayName: "Duplicate",
        observedAt: t2,
      }),
    ).resolves.toBe(false);

    const base = {
      chatId: -1001,
      type: "group" as const,
      username: null,
    };
    await service.observeChat({ ...base, botId: BOT_A, title: "Old", observedAt: t1 });
    await service.observeChat({ ...base, botId: BOT_A, title: "New", observedAt: t2 });
    await expect(
      service.observeChat({ ...base, botId: BOT_A, title: "Stale", observedAt: t1 }),
    ).resolves.toBe(false);
    await service.observeChat({ ...base, botId: BOT_B, title: "Other Bot", observedAt: t2 });

    expect(state.profiles.get(BOT_A)?.username).toBe("new_bot");
    expect(state.chats.get(chatKey(BOT_A, -1001))?.title).toBe("New");
    expect(state.chats.get(chatKey(BOT_B, -1001))?.title).toBe("Other Bot");
    expect(state.conflictOptions).toHaveLength(7);
  });

  it("archives left membership, restores re-entry, and never treats null or stale status as authoritative", async () => {
    const { service, state } = createFakeDatabase();
    const t1 = new Date("2026-07-27T01:00:00.000Z");
    const t2 = new Date("2026-07-27T02:00:00.000Z");
    const t3 = new Date("2026-07-27T03:00:00.000Z");
    const base = {
      botId: BOT_A,
      chatId: -1001,
      type: "supergroup" as const,
      username: "example_group",
    };

    await service.observeBotMembership({
      ...base,
      title: "Joined",
      status: "member",
      observedAt: t1,
    });
    const left = await service.observeBotMembership({
      ...base,
      title: "Left",
      status: "left",
      observedAt: t2,
    });
    expect(left.membershipObserved).toBe(true);
    expect(state.chats.get(chatKey(BOT_A, -1001))).toMatchObject({
      botMembershipStatus: "left",
      membershipObservedAt: t2,
      leftAt: t2,
    });

    await expect(
      service.observeBotMembership({
        ...base,
        title: "Stale",
        status: "administrator",
        observedAt: t1,
      }),
    ).resolves.toMatchObject({ membershipObserved: false });
    await expect(
      service.observeBotMembership({
        ...base,
        title: "Duplicate",
        status: "kicked",
        observedAt: t2,
      }),
    ).resolves.toMatchObject({ membershipObserved: false });

    const nonAuthoritative = await service.observeBotMembership({
      ...base,
      title: "Directory Refresh",
      status: null,
      observedAt: t3,
    });
    expect(nonAuthoritative).toEqual({ chatObserved: true, membershipObserved: false });
    expect(state.chats.get(chatKey(BOT_A, -1001))).toMatchObject({
      title: "Directory Refresh",
      botMembershipStatus: "left",
      membershipObservedAt: t2,
      leftAt: t2,
    });

    await service.observeBotMembership({
      ...base,
      title: "Rejoined",
      status: "administrator",
      observedAt: new Date("2026-07-27T04:00:00.000Z"),
    });
    expect(state.chats.get(chatKey(BOT_A, -1001))).toMatchObject({
      botMembershipStatus: "administrator",
      leftAt: null,
    });
  });

  it("reads a fresh, Bot-scoped access snapshot and filters malformed persisted IDs", async () => {
    const { service, state } = createFakeDatabase();
    state.bots.set(BOT_A, {
      platform: "telegram",
      adminChatIds: [9, -1001, 9, Number.MAX_SAFE_INTEGER + 1],
    });
    state.bots.set(BOT_B, { platform: "telegram", adminChatIds: [99] });
    state.operators.push(
      { botId: BOT_A, telegramUserId: 10 },
      { botId: BOT_A, telegramUserId: -10 },
      { botId: BOT_B, telegramUserId: 100 },
    );
    state.chatGrants.push(
      { botId: BOT_A, chatId: -2001 },
      { botId: BOT_A, chatId: 2001 },
      { botId: BOT_B, chatId: -9001 },
    );

    await expect(service.readAccessSnapshot(BOT_A)).resolves.toEqual({
      botId: BOT_A,
      adminTelegramUserIds: [9],
      operatorTelegramUserIds: [10],
      grantedChatIds: [-2001],
    });

    state.operators.splice(0, state.operators.length, { botId: BOT_A, telegramUserId: 11 });
    state.chatGrants.splice(0, state.chatGrants.length, { botId: BOT_A, chatId: -2002 });
    await expect(service.readAccessSnapshot(BOT_A)).resolves.toMatchObject({
      operatorTelegramUserIds: [11],
      grantedChatIds: [-2002],
    });

    expect(state.whereConditions).toHaveLength(6);
    for (const condition of state.whereConditions) {
      expect(collectPrimitiveValues(condition)).toContain(BOT_A);
    }
    await expect(service.readAccessSnapshot(BOT_B)).resolves.toMatchObject({
      adminTelegramUserIds: [99],
      operatorTelegramUserIds: [],
      grantedChatIds: [],
    });
  });
});
